// Claims (ADR 0001, ADR 0002). The Channel Durable Object owns Claim state, so a
// Claim is atomic: every check and the write happen in one synchronous stretch,
// with no await in between, and the object runs one such stretch at a time. Two
// Claims racing for one Task cannot both see it free.
//
// The rules:
// - An Agent claims for itself. A Person claims for themselves or for one of their
//   own Agents, never for another Person's Agent.
// - A Task that is done, or blocked by an open Issue, cannot be claimed.
// - A held Task cannot be claimed; the refusal names the holder. Moving a Claim is a
//   Takeover, which only a Person can do (ADR 0002, see stale-claims.ts).
// - Only the holder releases a Claim or completes its Steps. An Agent's Person may
//   act for it.
//
// After each change the Claim is mirrored to GitHub through the GitHub App: the
// holder's Person as assignee, the `status:claimed` label, the Issue's one status
// comment (status-comment.ts), and ticked Step checkboxes. GitHub failures never
// undo the change; each one is recorded as a `mirror.failed` Event.

import type {
  Actor,
  AgentId,
  Capture,
  ChannelEvent,
  EventType,
  Holder,
  PersonName,
  Task,
  TaskNumber,
} from "../../shared/src/index";
import { CLAIMED_LABEL, holderName, REVIEW_LABEL } from "../../shared/src/index";
import type { AgentRoster } from "./agents";
import type { NewEvent } from "./channel";
import { type GitHub, tickStep } from "./github/index";
import { describeHolder, holderPerson, type StatusComments } from "./status-comment";
import type { Tasks } from "./tasks";

/** Who is calling: the admitted Person, and the Agent when the call carries an Agent token. */
export interface Caller {
  person: PersonName;
  /** Set when the call carries an Agent token: the Agent calls through Switchboard's tools (the Tool Capture). */
  agent?: AgentId;
}

/** A resolved Caller: the Actor its Events name, and the Capture that carried them. */
export interface Acting {
  actor: Extract<Actor, { kind: "agent" | "person" }>;
  capture: Capture | null;
  person: PersonName;
}

export type ClaimRefusal = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 502 | 503;
  reason: string;
  heldBy?: Holder;
};
export type ClaimResult = { ok: true; task: Task } | ClaimRefusal;

/** One GitHub call of a mirrored change, named for its `mirror.failed` Event. */
export type MirrorCall = [name: string, run: () => Promise<unknown>];

/** What the Channel lends this module. */
export interface ClaimHost {
  tasks: Tasks;
  agents: AgentRoster;
  status: StatusComments;
  gitHub(): GitHub | null;
  append<K extends EventType>(event: NewEvent<K>): ChannelEvent;
}

export type Change = "claim" | "release" | "step.complete" | "finish" | "takeover" | "update";

function sameHolder(a: Holder, b: Holder): boolean {
  return a.kind === "agent"
    ? b.kind === "agent" && a.agentId === b.agentId
    : b.kind === "person" && a.person === b.person;
}

export class Claims {
  constructor(private readonly host: ClaimHost) {}

  /** The Issues' status comments, which every mirrored change keeps current. */
  get status(): StatusComments {
    return this.host.status;
  }

  /**
   * Works out who is acting. An Agent must be on the Channel and belong to the
   * authenticated Person; its Events carry the Tool Capture.
   */
  resolve(caller: Caller): { ok: true; acting: Acting } | ClaimRefusal {
    if (caller.agent === undefined) {
      return {
        ok: true,
        acting: { actor: { kind: "person", person: caller.person }, capture: null, person: caller.person },
      };
    }
    const agent = this.host.agents.find(caller.agent);
    if (agent === null) return { ok: false, status: 404, reason: `No Agent ${caller.agent} on this Channel.` };
    if (agent.person !== caller.person) {
      return { ok: false, status: 403, reason: `Agent ${agent.id} belongs to ${agent.person}.` };
    }
    return {
      ok: true,
      acting: { actor: { kind: "agent", agentId: agent.id }, capture: "tool", person: caller.person },
    };
  }

  async claim(caller: Caller, number: TaskNumber, forAgent?: AgentId): Promise<ClaimResult> {
    const synced = await this.host.tasks.ensureSynced();
    if (!synced.ok) return synced;

    // From here to the write there is no await: the Claim is atomic.
    const who = this.resolve(caller);
    if (!who.ok) return who;
    const { acting } = who;
    const holder = this.holderFor(acting, forAgent);
    if ("ok" in holder) return holder;

    const task = this.host.tasks.read(number);
    if (task === null) return { ok: false, status: 404, reason: `No Task #${number}.` };
    if (task.status === "done") return { ok: false, status: 409, reason: `Task #${number} is done.` };
    if (task.claim !== undefined) {
      if (sameHolder(task.claim.holder, holder)) return { ok: true, task };
      const heldBy = task.claim.holder;
      this.record(acting, "claim.refused", number, { heldBy });
      // A Stale Claim still stands: only a Person can take it over (ADR 0002).
      const stale = task.claim.stale ? " Its Claim is Stale: only a Person can take it over." : "";
      return { ok: false, status: 409, reason: `Task #${number} is held by ${holderName(heldBy)}.${stale}`, heldBy };
    }
    if (task.blockedBy.length > 0) {
      const blockers = task.blockedBy.map((n) => `#${n}`).join(", ");
      return { ok: false, status: 409, reason: `Task #${number} is blocked by ${blockers}.` };
    }

    const now = new Date().toISOString();
    this.host.tasks.write({
      ...task,
      status: "claimed",
      claim: { task: number, holder, claimedAt: now, stale: false },
      updatedAt: now,
    });
    this.record(acting, "claim", number, { holder });
    this.host.status.note(number, `Claimed by ${this.describe(holder)}.`, now);
    const assignee = holderPerson(this.host.agents, holder);

    await this.mirror(acting, "claim", number, async (gitHub) => [
      ...this.assign(gitHub, number, assignee),
      [
        "label",
        async () => {
          await gitHub.addLabels(number, [CLAIMED_LABEL]);
          this.keepLabels(number, (labels) => (labels.includes(CLAIMED_LABEL) ? labels : [...labels, CLAIMED_LABEL]));
        },
      ],
      this.statusCall(gitHub, number),
    ]);
    return this.current(number);
  }

  async release(caller: Caller, number: TaskNumber): Promise<ClaimResult> {
    const synced = await this.host.tasks.ensureSynced();
    if (!synced.ok) return synced;

    const who = this.resolve(caller);
    if (!who.ok) return who;
    const { acting } = who;
    const held = this.held(acting, number, "release");
    if (!held.ok) return held;
    const { task, holder } = held;

    const { claim: _released, ...rest } = task;
    this.host.tasks.write({ ...rest, status: "open", updatedAt: new Date().toISOString() });
    this.record(acting, "claim.release", number, { holder });
    this.host.status.note(number, `Released by ${this.describe(holder)}.`);
    const assignee = holderPerson(this.host.agents, holder);

    await this.mirror(acting, "release", number, async (gitHub) => [
      ...(assignee === undefined ? [] : [["unassign", () => gitHub.removeAssignees(number, [assignee])] as MirrorCall]),
      [
        "unlabel",
        async () => {
          await gitHub.removeLabel(number, CLAIMED_LABEL);
          if (task.status === "review") await gitHub.removeLabel(number, REVIEW_LABEL);
          this.keepLabels(number, (labels) =>
            labels.filter((label) => label !== CLAIMED_LABEL && label !== REVIEW_LABEL),
          );
        },
      ],
      this.statusCall(gitHub, number),
    ]);
    return this.current(number);
  }

  async completeStep(caller: Caller, number: TaskNumber, index: number): Promise<ClaimResult> {
    const synced = await this.host.tasks.ensureSynced();
    if (!synced.ok) return synced;

    const who = this.resolve(caller);
    if (!who.ok) return who;
    const { acting } = who;
    const held = this.held(acting, number, "complete a Step of");
    if (!held.ok) return held;
    const { task } = held;
    const step = task.steps[index];
    if (step === undefined) {
      return { ok: false, status: 404, reason: `Task #${number} has ${task.steps.length} Steps, numbered from 0.` };
    }
    if (step.done) return { ok: true, task };

    const steps = task.steps.map((s) => (s.index === index ? { ...s, done: true } : s));
    this.host.tasks.write({
      ...task,
      steps,
      stepsDone: steps.filter((s) => s.done).length,
      updatedAt: new Date().toISOString(),
    });
    this.record(acting, "step.complete", number, { step: index, text: step.text });

    await this.mirror(acting, "step.complete", number, async (gitHub) => [
      [
        "tick",
        async () => {
          const issue = await gitHub.getIssue(number);
          if (issue === null) throw new Error(`Issue #${number} is gone.`);
          const body = tickStep(issue.body, index, step.text);
          if (body === null) throw new Error(`The Issue no longer has Step ${index} "${step.text}".`);
          if (body === issue.body) return;
          await gitHub.setBody(number, body);
          this.keepBody(number, issue.body, body);
        },
      ],
      this.statusCall(gitHub, number),
    ]);
    return this.current(number);
  }

  /** The holder a Claim is for, or a refusal. */
  private holderFor(acting: Acting, forAgent: AgentId | undefined): Holder | ClaimRefusal {
    if (acting.actor.kind === "agent") {
      if (forAgent !== undefined && forAgent !== acting.actor.agentId) {
        return { ok: false, status: 403, reason: "An Agent can only claim for itself." };
      }
      return { kind: "agent", agentId: acting.actor.agentId };
    }
    if (forAgent === undefined) return { kind: "person", person: acting.person };
    const agent = this.host.agents.find(forAgent);
    if (agent === null) return { ok: false, status: 404, reason: `No Agent ${forAgent} on this Channel.` };
    if (agent.person !== acting.person) {
      return {
        ok: false,
        status: 403,
        reason: `Agent ${agent.id} belongs to ${agent.person}. You can claim for yourself or your own Agents.`,
      };
    }
    return { kind: "agent", agentId: agent.id };
  }

  /** The Task and its holder, when `acting` may act as the holder: the holder itself, or a holding Agent's Person. */
  held(acting: Acting, number: TaskNumber, what: string): { ok: true; task: Task; holder: Holder } | ClaimRefusal {
    const task = this.host.tasks.read(number);
    if (task === null) return { ok: false, status: 404, reason: `No Task #${number}.` };
    if (task.status === "done") return { ok: false, status: 409, reason: `Task #${number} is done.` };
    if (task.claim === undefined) return { ok: false, status: 409, reason: `Task #${number} is not claimed.` };
    const holder = task.claim.holder;
    const allowed =
      acting.actor.kind === "agent"
        ? holder.kind === "agent" && holder.agentId === acting.actor.agentId
        : holder.kind === "person"
          ? holder.person === acting.person
          : this.host.agents.find(holder.agentId)?.person === acting.person;
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        reason: `Task #${number} is held by ${holderName(holder)}. Only its holder can ${what} it.`,
        heldBy: holder,
      };
    }
    return { ok: true, task, holder };
  }

  /**
   * Once our own tick is on GitHub, the Task's copy of the body follows it, so the
   * webhook that echoes it back records no change. Only when nobody else edited the
   * Issue in between, which the next sync reports as usual.
   */
  private keepBody(number: TaskNumber, before: string, after: string): void {
    const task = this.host.tasks.read(number);
    if (task === null || task.description !== before) return;
    this.host.tasks.write({ ...task, description: after });
  }

  /**
   * The same for the `status:claimed` label: GitHub owns labels, but this one we
   * just set ourselves, so the Task shows it without waiting for the webhook.
   */
  keepLabels(number: TaskNumber, change: (labels: string[]) => string[]): void {
    const task = this.host.tasks.read(number);
    if (task === null) return;
    const labels = change(task.labels);
    if (labels.length !== task.labels.length || labels.some((l, i) => l !== task.labels[i])) {
      this.host.tasks.write({ ...task, labels });
    }
  }

  describe(holder: Holder): string {
    return describeHolder(holder, holder.kind === "agent" ? this.host.agents.find(holder.agentId)?.person : undefined);
  }

  /** Assigns the Issue to `person` (the holder's Person), so GitHub notifies them. */
  assign(gitHub: GitHub, number: TaskNumber, person: PersonName | undefined): MirrorCall[] {
    return person === undefined ? [] : [["assign", () => gitHub.addAssignees(number, [person])]];
  }

  /** Brings the Issue's one status comment up to date. */
  statusCall(gitHub: GitHub, number: TaskNumber): MirrorCall {
    return ["status comment", () => this.host.status.sync(gitHub, number)];
  }

  /** After an Update about a claimed Task, its status comment shows it as the last Update. */
  async updated(acting: Acting, number: TaskNumber): Promise<void> {
    const task = this.host.tasks.read(number);
    if (task === null || task.claim === undefined || task.status === "done") return;
    await this.mirror(acting, "update", number, async (gitHub) => [this.statusCall(gitHub, number)]);
  }

  current(number: TaskNumber): ClaimResult {
    const task = this.host.tasks.read(number);
    return task === null ? { ok: false, status: 404, reason: `No Task #${number}.` } : { ok: true, task };
  }

  /**
   * Runs one change's GitHub calls in order, after any other GitHub work on the
   * Channel. Each call that fails is recorded and the rest still run.
   */
  async mirror(
    acting: Acting,
    change: Change,
    number: TaskNumber,
    calls: (gitHub: GitHub) => Promise<MirrorCall[]>,
  ): Promise<void> {
    const gitHub = this.host.gitHub();
    if (gitHub === null) return;
    await this.host.tasks.exclusive(async () => {
      for (const [call, run] of await calls(gitHub)) {
        try {
          await run();
        } catch (error) {
          console.error(`Mirroring ${change} of #${number} to GitHub failed at ${call}`, error);
          const reason = error instanceof Error ? error.message : String(error);
          this.host.append({
            type: "mirror.failed",
            actor: acting.actor,
            capture: null,
            task: number,
            payload: { change, call, reason: reason.slice(0, 500) },
          });
        }
      }
    });
  }

  private record<K extends "claim" | "claim.refused" | "claim.release" | "step.complete">(
    acting: Acting,
    type: K,
    task: TaskNumber,
    payload: NewEvent<K>["payload"],
  ): void {
    this.host.append({ type, actor: acting.actor, capture: acting.capture, task, payload } as NewEvent<K>);
  }
}
