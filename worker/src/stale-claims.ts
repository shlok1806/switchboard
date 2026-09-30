// Stale Claims and Takeover (ADR 0002). A Claim follows its holder's Presence and
// its Task's blockers, and only a Person can move it:
//
// - When an Agent goes Gone, every Claim it holds becomes Stale (a `claim.stale`
//   Event). A Stale Claim never expires on its own: it stays held until a Person
//   takes it over.
// - When the Agent comes back before any Takeover, its Claims stop being Stale
//   (`claim.recovered`).
// - A Person's Takeover moves a Stale Claim to themselves or to one of their own
//   Agents, and records a `takeover` Event with the hand-off: the previous holder,
//   the Steps completed and the last Update. GitHub gets the assignee and a comment.
//   An Agent can never take over, and a Claim that is not Stale cannot be taken over.
// - The Agent that lost the Claim is told when it comes back: each Takeover waits
//   here as a Lost Claim until the Agent's wrapper next registers or heartbeats,
//   and is handed to it once (`AgentResponse.lostClaims`).
// - A claimed Task that becomes blocked keeps its Claim, flagged with the blockers
//   (`Claim.blockedBy`, a `claim.blocked` Event), until they close.
//
// Every check and write happens in one synchronous stretch, like a Claim, so a
// Takeover cannot race a Claim, a release or another Takeover.

import type {
  AgentId,
  ChannelEvent,
  EventType,
  Holder,
  LostClaim,
  Presence,
  Task,
  TaskNumber,
} from "../../shared/src/index";
import { CLAIMED_LABEL, holderName } from "../../shared/src/index";
import type { AgentRoster } from "./agents";
import type { NewEvent } from "./channel";
import { type Caller, type ClaimResult, type Claims, describeHolder } from "./claims";
import type { Tasks } from "./tasks";

export const STALE_CLAIMS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS lost_claims (
    event TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL
  );
`;

/** What the Channel lends this module. */
export interface StaleClaimHost {
  sql: SqlStorage;
  tasks: Tasks;
  agents: AgentRoster;
  claims: Claims;
  append<K extends EventType>(event: NewEvent<K>): ChannelEvent;
}

type LostRow = { event: string; agent: string; seq: number; data: string };
type PayloadRow = { payload: string };

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

export class StaleClaims {
  constructor(private readonly host: StaleClaimHost) {
    host.sql.exec(STALE_CLAIMS_SCHEMA);
  }

  /**
   * Follows an Agent's Presence: Gone makes its Claims Stale, coming back makes
   * them fresh again. The Channel decides this, so the Events carry no Capture.
   */
  presenceChanged(id: AgentId, presence: Presence): void {
    const stale = presence === "gone";
    for (const task of this.host.tasks.stored()) {
      const claim = task.claim;
      if (claim === undefined || task.status === "done") continue;
      if (claim.holder.kind !== "agent" || claim.holder.agentId !== id || claim.stale === stale) continue;
      this.host.tasks.write({ ...task, claim: { ...claim, stale }, updatedAt: new Date().toISOString() });
      this.host.append({
        type: stale ? "claim.stale" : "claim.recovered",
        actor: { kind: "agent", agentId: id },
        capture: null,
        task: task.number,
        payload: { holder: claim.holder },
      });
    }
  }

  /**
   * Follows a claimed Task's blockers after a GitHub sync. A Task blocked after it
   * was claimed keeps its Claim, flagged with what blocks it now.
   */
  taskChanged(task: Task): void {
    const claim = task.claim;
    if (claim === undefined || task.status === "done") return;
    const before = claim.blockedBy ?? [];
    if (sameList(before, task.blockedBy)) return;
    const { blockedBy: _was, ...rest } = claim;
    const blocked = task.blockedBy.length > 0;
    this.host.tasks.write({ ...task, claim: blocked ? { ...rest, blockedBy: [...task.blockedBy] } : rest });
    if (blocked) {
      this.host.append({
        type: "claim.blocked",
        actor: { kind: "github" },
        capture: null,
        task: task.number,
        payload: { holder: claim.holder, blockedBy: [...task.blockedBy] },
      });
    } else {
      this.host.append({
        type: "claim.unblocked",
        actor: { kind: "github" },
        capture: null,
        task: task.number,
        payload: { holder: claim.holder },
      });
    }
  }

  /** A Person moving a Stale Claim to themselves or to one of their own Agents. */
  async takeover(caller: Caller, number: TaskNumber, to: Holder): Promise<ClaimResult> {
    // ADR 0002: Agents cannot take Claims from each other, whoever they act for.
    if (caller.agent !== undefined) {
      return { ok: false, status: 403, reason: "Only a Person can take over a Claim. An Agent never can." };
    }
    const synced = await this.host.tasks.ensureSynced();
    if (!synced.ok) return synced;

    // From here to the write there is no await: the Takeover is atomic.
    const person = caller.person;
    const target = this.checkTarget(person, to);
    if (target !== null) return target;

    const task = this.host.tasks.read(number);
    if (task === null) return { ok: false, status: 404, reason: `No Task #${number}.` };
    if (task.status === "done") return { ok: false, status: 409, reason: `Task #${number} is done.` };
    const claim = task.claim;
    if (claim === undefined) {
      return { ok: false, status: 409, reason: `Task #${number} is not claimed. Claim it instead.` };
    }
    if (!claim.stale) {
      return {
        ok: false,
        status: 409,
        reason: `Task #${number} is held by ${holderName(claim.holder)}, which is not Gone. Only a Stale Claim can be taken over.`,
        heldBy: claim.holder,
      };
    }

    const from = claim.holder;
    const now = new Date().toISOString();
    this.host.tasks.write({
      ...task,
      claim: { ...claim, holder: to, claimedAt: now, stale: false },
      updatedAt: now,
    });
    const stepsCompleted = task.steps.filter((step) => step.done).map((step) => step.text);
    const lastUpdate = this.lastUpdate(from, number, claim.claimedAt);
    const event = this.host.append({
      type: "takeover",
      actor: { kind: "person", person },
      capture: null,
      task: number,
      payload: { from, to, stepsCompleted, ...(lastUpdate === undefined ? {} : { lastUpdate }) },
    });
    if (from.kind === "agent") {
      const lost: LostClaim = { task: number, title: task.title, by: person, to, at: event.at, event: event.id };
      this.host.sql.exec(
        "INSERT OR REPLACE INTO lost_claims (event, agent, seq, data) VALUES (?, ?, ?, ?)",
        event.id,
        from.agentId,
        event.seq,
        JSON.stringify(lost),
      );
    }

    const acting = { actor: { kind: "person" as const, person }, capture: null, person };
    await this.host.claims.mirror(acting, "takeover", number, async (gitHub) => [
      ["assign", async () => gitHub.addAssignees(number, [await gitHub.login()])],
      ["label", () => gitHub.addLabels(number, [CLAIMED_LABEL])],
      ["comment", () => gitHub.addComment(number, this.comment(person, from, to, stepsCompleted, lastUpdate))],
    ]);
    const after = this.host.tasks.read(number);
    return after === null ? { ok: false, status: 404, reason: `No Task #${number}.` } : { ok: true, task: after };
  }

  /**
   * The Claims Agent `id` lost to a Takeover and has not been told about, oldest
   * first. Each is handed out once: the Channel forgets it here.
   */
  takeLostClaims(id: AgentId): LostClaim[] {
    const rows = this.host.sql
      .exec<LostRow>("DELETE FROM lost_claims WHERE agent = ? RETURNING *", id)
      .toArray()
      .sort((a, b) => a.seq - b.seq);
    return rows.map((row) => JSON.parse(row.data) as LostClaim);
  }

  /** Null when `person` may give a Claim to `to`, else the refusal. */
  private checkTarget(person: string, to: Holder): ClaimResult | null {
    if (to.kind === "person") {
      if (to.person === person) return null;
      return { ok: false, status: 403, reason: "You can take over a Claim for yourself or your own Agents only." };
    }
    const agent = this.host.agents.find(to.agentId);
    if (agent === null) return { ok: false, status: 404, reason: `No Agent ${to.agentId} on this Channel.` };
    if (agent.person !== person) {
      return {
        ok: false,
        status: 403,
        reason: `Agent ${agent.id} belongs to ${agent.person}. You can take over for yourself or your own Agents.`,
      };
    }
    if (agent.presence === "gone") {
      return { ok: false, status: 409, reason: `Agent ${agent.id} is Gone: its Claim would be Stale at once.` };
    }
    return null;
  }

  /**
   * The previous holder's last Update: its latest one about this Task, or failing
   * that its latest one since it claimed the Task.
   */
  private lastUpdate(holder: Holder, task: TaskNumber, since: string): string | undefined {
    const [field, value] = holder.kind === "agent" ? ["$.agentId", holder.agentId] : ["$.person", holder.person];
    const who = `type = 'update' AND json_extract(actor, '$.kind') = ? AND json_extract(actor, '${field}') = ?`;
    const aboutTask = this.host.sql
      .exec<PayloadRow>(
        `SELECT payload FROM events WHERE ${who} AND task = ? ORDER BY seq DESC LIMIT 1`,
        holder.kind,
        value,
        task,
      )
      .toArray()[0];
    const row =
      aboutTask ??
      this.host.sql
        .exec<PayloadRow>(
          `SELECT payload FROM events WHERE ${who} AND at >= ? ORDER BY seq DESC LIMIT 1`,
          holder.kind,
          value,
          since,
        )
        .toArray()[0];
    return row === undefined ? undefined : (JSON.parse(row.payload) as { text: string }).text;
  }

  /** The hand-off, as the Issue comment reads it. */
  private comment(person: string, from: Holder, to: Holder, steps: string[], lastUpdate: string | undefined): string {
    const owner = (holder: Holder) =>
      holder.kind === "agent" ? this.host.agents.find(holder.agentId)?.person : undefined;
    const lines = [
      `Taken over by Person \`${person}\` for ${describeHolder(to, owner(to))} via Switchboard.`,
      "",
      `Previous holder: ${describeHolder(from, owner(from))}, Gone.`,
      steps.length === 0 ? "Steps completed: none." : `Steps completed:\n${steps.map((s) => `- [x] ${s}`).join("\n")}`,
    ];
    if (lastUpdate !== undefined) lines.push(`Last Update:\n> ${lastUpdate.replace(/\n/g, "\n> ")}`);
    return lines.join("\n");
  }
}
