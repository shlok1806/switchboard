// One status comment per Issue, edited in place (issue #2). Instead of a new
// comment for every Claim, release or Takeover, the Issue carries one comment
// that always shows where the Task stands: who holds it and through which Agent,
// the Steps done, the holder's last Update and a short history. The comment's ID
// is stored per Task; when someone deletes the comment, the next change posts a
// new one.
//
// Writes go through the GitHub App, so the comment shows as `switchboard[bot]`
// and its text names the Person and the Agent.

import type { Holder, PersonName, Task, TaskNumber } from "../../shared/src/index";
import type { AgentRoster } from "./agents";
import type { GitHub } from "./github/index";
import type { Tasks } from "./tasks";

/** How many history lines the comment keeps, newest last. */
export const STATUS_HISTORY_LINES = 6;

/** Marks Switchboard's status comment, so a person reading the raw text knows what it is. */
export const STATUS_MARKER = "<!-- switchboard:status -->";

/** Longest Update text quoted in the comment. */
const UPDATE_QUOTE_LENGTH = 500;

export const STATUS_COMMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS status_comments (
    task INTEGER PRIMARY KEY,
    comment_id INTEGER,
    history TEXT NOT NULL
  );
`;

type StatusRow = { task: number; comment_id: number | null; history: string };
type PayloadRow = { payload: string; at: string };

export interface StatusHost {
  sql: SqlStorage;
  tasks: Tasks;
  agents: AgentRoster;
}

/** The Person behind a holder: the Person itself, or the holding Agent's Person. */
export function holderPerson(agents: AgentRoster, holder: Holder): PersonName | undefined {
  return holder.kind === "person" ? holder.person : agents.find(holder.agentId)?.person;
}

/** How a holder reads on GitHub: `Agent \`id\` of \`person\``, or `Person \`person\``. */
export function describeHolder(holder: Holder, owner?: PersonName): string {
  return holder.kind === "agent"
    ? `Agent \`${holder.agentId}\`${owner === undefined ? "" : ` of \`${owner}\``}`
    : `Person \`${holder.person}\``;
}

/**
 * A holder's last Update: its latest one about this Task, or failing that its
 * latest one since `since` (when it claimed the Task).
 */
export function lastUpdate(
  sql: SqlStorage,
  holder: Holder,
  task: TaskNumber,
  since: string,
): { text: string; at: string } | undefined {
  const [field, value] = holder.kind === "agent" ? ["$.agentId", holder.agentId] : ["$.person", holder.person];
  const who = `type = 'update' AND json_extract(actor, '$.kind') = ? AND json_extract(actor, '${field}') = ?`;
  const row =
    sql
      .exec<PayloadRow>(
        `SELECT payload, at FROM events WHERE ${who} AND task = ? ORDER BY seq DESC LIMIT 1`,
        holder.kind,
        value,
        task,
      )
      .toArray()[0] ??
    sql
      .exec<PayloadRow>(
        `SELECT payload, at FROM events WHERE ${who} AND at >= ? ORDER BY seq DESC LIMIT 1`,
        holder.kind,
        value,
        since,
      )
      .toArray()[0];
  return row === undefined ? undefined : { text: (JSON.parse(row.payload) as { text: string }).text, at: row.at };
}

/** `2026-09-30 14:05 UTC`: short, and the same for every reader. */
function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function quote(text: string): string {
  const cut = text.length > UPDATE_QUOTE_LENGTH ? `${text.slice(0, UPDATE_QUOTE_LENGTH)}...` : text;
  return cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export class StatusComments {
  constructor(private readonly host: StatusHost) {
    host.sql.exec(STATUS_COMMENT_SCHEMA);
  }

  /** Adds a line to Task `number`'s history. The next `sync` shows it. */
  note(number: TaskNumber, line: string, at = new Date().toISOString()): void {
    const row = this.row(number);
    const history = [...(row === undefined ? [] : (JSON.parse(row.history) as string[])), `${when(at)}: ${line}`];
    this.host.sql.exec(
      "INSERT INTO status_comments (task, comment_id, history) VALUES (?, ?, ?) ON CONFLICT (task) DO UPDATE SET history = excluded.history",
      number,
      row?.comment_id ?? null,
      JSON.stringify(history.slice(-STATUS_HISTORY_LINES)),
    );
  }

  /** The stored comment ID of Task `number`, or null when it has none yet. */
  commentId(number: TaskNumber): number | null {
    return this.row(number)?.comment_id ?? null;
  }

  /**
   * Writes the status comment of Task `number` as the Task stands now: edits the
   * stored comment, or posts one when there is none or it was deleted. Throws when
   * GitHub refuses; the caller records the failure.
   */
  async sync(gitHub: GitHub, number: TaskNumber): Promise<void> {
    const task = this.host.tasks.read(number);
    if (task === null) return;
    const body = this.render(task);
    const id = this.commentId(number);
    if (id !== null && (await gitHub.updateComment(id, body))) return;
    const created = await gitHub.createComment(number, body);
    this.host.sql.exec(
      "INSERT INTO status_comments (task, comment_id, history) VALUES (?, ?, '[]') ON CONFLICT (task) DO UPDATE SET comment_id = excluded.comment_id",
      number,
      created,
    );
  }

  /** The comment's text for `task`. */
  render(task: Task): string {
    const lines = [STATUS_MARKER, "**Switchboard status**", ""];
    const claim = task.claim;
    if (task.status === "done") {
      lines.push("Done.");
    } else if (claim === undefined) {
      lines.push("Not claimed.");
    } else {
      const holder = describeHolder(claim.holder, holderPerson(this.host.agents, claim.holder));
      const state =
        task.status === "review" && task.pr !== undefined
          ? `In review in pull request #${task.pr}, held by ${holder}`
          : `Held by ${holder}`;
      lines.push(`${state} since ${when(claim.claimedAt)}.`);
      if (claim.stale) lines.push("", "The holder is Gone, so the Claim is Stale until a Person takes it over.");
      if (claim.blockedBy !== undefined && claim.blockedBy.length > 0) {
        lines.push("", `Blocked by ${claim.blockedBy.map((n) => `#${n}`).join(", ")}.`);
      }
    }
    if (task.steps.length > 0) lines.push("", `Steps done: ${task.stepsDone} of ${task.steps.length}.`);
    if (claim !== undefined && task.status !== "done") {
      const update = this.latestUpdate(task.number) ?? this.holderUpdate(claim.holder, task.number, claim.claimedAt);
      if (update !== undefined) {
        lines.push("", `Last Update, from ${update.by} at ${when(update.at)}:`, quote(update.text));
      }
    }
    const history = JSON.parse(this.row(task.number)?.history ?? "[]") as string[];
    if (history.length > 0) lines.push("", "History:", ...history.map((line) => `- ${line}`));
    return lines.join("\n");
  }

  /** The latest Update about Task `number`, from anyone, naming who wrote it. */
  private latestUpdate(number: TaskNumber): { text: string; at: string; by: string } | undefined {
    const row = this.host.sql
      .exec<PayloadRow & { actor: string }>(
        "SELECT payload, at, actor FROM events WHERE type = 'update' AND task = ? ORDER BY seq DESC LIMIT 1",
        number,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    const actor = JSON.parse(row.actor) as { kind: string; agentId?: string; person?: string };
    const by = actor.kind === "agent" ? `Agent \`${actor.agentId}\`` : `Person \`${actor.person}\``;
    return { text: (JSON.parse(row.payload) as { text: string }).text, at: row.at, by };
  }

  /** The holder's latest Update since it claimed, when none names the Task. */
  private holderUpdate(holder: Holder, number: TaskNumber, since: string) {
    const update = lastUpdate(this.host.sql, holder, number, since);
    return update === undefined ? undefined : { ...update, by: describeHolder(holder) };
  }

  private row(number: TaskNumber): StatusRow | undefined {
    return this.host.sql.exec<StatusRow>("SELECT * FROM status_comments WHERE task = ?", number).toArray()[0];
  }
}
