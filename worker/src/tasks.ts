// Tasks mirror GitHub Issues (ADR 0001). GitHub owns title, description, labels,
// blockers, sub-issues and the checklist Steps; this module copies them into the
// Channel's SQLite and records every change as an Event. Switchboard-owned fields
// (status other than done, Claim, branch, PR) are never overwritten by a sync.
//
// Changes arrive three ways: a Person creating a Task through the Channel API, a
// GitHub webhook naming the Issues that changed, and a periodic reconcile (a Durable
// Object alarm) that re-reads every open Issue to repair missed webhooks.

import type {
  ChannelEvent,
  EventType,
  PersonName,
  StreamMessage,
  Task,
  TaskField,
  TaskNumber,
  TaskSyncVia,
} from "../../shared/src/index";
import type { NewEvent } from "./channel";
import type { GitHub, GitHubIssue, IssueRef, WebhookChange } from "./github/index";
import { parseSteps } from "./github/index";

/** How often the reconcile re-reads GitHub. */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** How many Issues a reconcile reads at once, to stay clear of GitHub's secondary rate limits. */
const RECONCILE_CONCURRENCY = 8;

export type TaskResult<T> = { ok: true; value: T } | { ok: false; status: 404 | 502 | 503; reason: string };

export interface NewTask {
  title: string;
  description: string;
  labels: string[];
}

/** What the Channel Durable Object lends this module. */
export interface TaskHost {
  storage: DurableObjectStorage;
  /** The GitHub to sync with, or null when sync is not configured. */
  gitHub(): GitHub | null;
  append<K extends EventType>(event: NewEvent<K>): ChannelEvent;
  broadcast(message: StreamMessage): void;
}

/** An Issue with the relationships a Task shows, read from GitHub. */
interface Mirror {
  issue: GitHubIssue;
  subtasks: IssueRef[];
  blockedBy: TaskNumber[];
}

type TaskRow = { number: number; data: string };

const NOT_CONFIGURED = "GitHub sync is not configured: set the GITHUB_TOKEN Worker secret.";

/** A GitHub login, as the Person name an Event names (ADR 0001: a close on GitHub is done by a Person). */
function personFromLogin(login: string): PersonName {
  return login.toLowerCase();
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

async function readMirror(gitHub: GitHub, issue: GitHubIssue): Promise<Mirror> {
  const [subtasks, blockers] = await Promise.all([
    issue.subIssueCount > 0 ? gitHub.listSubIssues(issue.number) : [],
    issue.openBlockerCount > 0 ? gitHub.listBlockedBy(issue.number) : [],
  ]);
  const blockedBy = blockers.filter((ref) => ref.state === "open").map((ref) => ref.number);
  return { issue, subtasks, blockedBy: blockedBy.sort((a, b) => a - b) };
}

/** The GitHub-owned fields of a Task. */
function mirroredFields(mirror: Mirror): Omit<Task, "number" | "status" | "claim" | "branch" | "pr" | "updatedAt"> {
  const { issue } = mirror;
  const steps = parseSteps(issue.body);
  return {
    title: issue.title,
    description: issue.body,
    labels: issue.labels,
    blockedBy: mirror.blockedBy,
    ...(issue.parent === undefined ? {} : { parent: issue.parent }),
    subtasks: mirror.subtasks.map((ref) => ref.number),
    subtasksDone: mirror.subtasks.filter((ref) => ref.state === "closed").length,
    steps,
    stepsDone: steps.filter((step) => step.done).length,
    url: issue.url,
  };
}

function changedFields(before: Task, after: Task): TaskField[] {
  const fields: TaskField[] = [];
  if (before.title !== after.title) fields.push("title");
  if (before.description !== after.description) fields.push("description");
  if (!sameList(before.labels, after.labels)) fields.push("labels");
  if (!sameList(before.blockedBy, after.blockedBy)) fields.push("blockedBy");
  if (before.parent !== after.parent) fields.push("parent");
  if (!sameList(before.subtasks, after.subtasks) || before.subtasksDone !== after.subtasksDone) {
    fields.push("subtasks");
  }
  if (JSON.stringify(before.steps) !== JSON.stringify(after.steps)) fields.push("steps");
  return fields;
}

export class Tasks {
  /** Serializes every sync, so an older read of GitHub never lands after a newer one. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: TaskHost) {
    host.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        number INTEGER PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_sync (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Every Task, lowest Issue number first. Runs the first reconcile if there has never been one. */
  async list(): Promise<TaskResult<Task[]>> {
    const synced = await this.ensureSynced();
    if (!synced.ok) return synced;
    const rows = this.host.storage.sql.exec<TaskRow>("SELECT * FROM tasks ORDER BY number").toArray();
    return { ok: true, value: rows.map((row) => JSON.parse(row.data) as Task) };
  }

  async get(number: TaskNumber): Promise<TaskResult<Task>> {
    const synced = await this.ensureSynced();
    if (!synced.ok) return synced;
    const task = this.read(number);
    return task === null ? { ok: false, status: 404, reason: `No Task #${number}.` } : { ok: true, value: task };
  }

  /** Creates the GitHub Issue, then its Task, recording a `task.create` Event by the Person. */
  create(person: PersonName, input: NewTask): Promise<TaskResult<Task>> {
    return this.withGitHub(async (gitHub) => {
      const issue = await gitHub.createIssue({ title: input.title, body: input.description, labels: input.labels });
      this.apply(await readMirror(gitHub, issue), "channel", { createdBy: person });
      const task = this.read(issue.number);
      if (task === null) throw new Error(`Issue #${issue.number} did not become a Task.`);
      return task;
    });
  }

  /** Re-reads the Issues a webhook delivery names. */
  webhook(change: WebhookChange): Promise<TaskResult<null>> {
    return this.withGitHub(async (gitHub) => {
      await this.refresh(gitHub, change.issues, "webhook", change.closed);
      return null;
    });
  }

  /** The reconcile alarm. It always schedules the next run, even when GitHub fails. */
  async alarm(): Promise<void> {
    const gitHub = this.host.gitHub();
    if (gitHub === null) return;
    try {
      await this.exclusive(() => this.reconcile(gitHub));
    } catch (error) {
      console.error("Task reconcile failed", error);
    } finally {
      await this.host.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  private async ensureSynced(): Promise<TaskResult<null>> {
    if (this.syncedAt() !== null) {
      await this.schedule();
      return { ok: true, value: null };
    }
    return this.withGitHub(async (gitHub) => {
      if (this.syncedAt() === null) await this.reconcile(gitHub);
      return null;
    });
  }

  /** Runs one sync against GitHub, serialized, and keeps the reconcile alarm scheduled. */
  private async withGitHub<T>(work: (gitHub: GitHub) => Promise<T>): Promise<TaskResult<T>> {
    const gitHub = this.host.gitHub();
    if (gitHub === null) return { ok: false, status: 503, reason: NOT_CONFIGURED };
    await this.schedule();
    try {
      return { ok: true, value: await this.exclusive(() => work(gitHub)) };
    } catch (error) {
      console.error("GitHub sync failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 502, reason: `Could not reach GitHub: ${detail}` };
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async schedule(): Promise<void> {
    if ((await this.host.storage.getAlarm()) === null) {
      await this.host.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  private syncedAt(): string | null {
    return (
      this.host.storage.sql.exec<{ value: string }>("SELECT value FROM task_sync WHERE key = 'syncedAt'").toArray()[0]
        ?.value ?? null
    );
  }

  /** Re-reads every open Issue, plus every Task GitHub no longer lists as open. */
  private async reconcile(gitHub: GitHub): Promise<void> {
    const open = (await gitHub.listOpenIssues()).sort((a, b) => a.number - b.number);
    const openNumbers = new Set(open.map((issue) => issue.number));
    const mirrors = await mapPooled(open, (issue) => readMirror(gitHub, issue));
    for (const mirror of mirrors) this.apply(mirror, "reconcile");

    const vanished = this.host.storage.sql
      .exec<TaskRow>("SELECT * FROM tasks ORDER BY number")
      .toArray()
      .map((row) => JSON.parse(row.data) as Task)
      .filter((task) => task.status !== "done" && !openNumbers.has(task.number))
      .map((task) => task.number);
    await this.refresh(gitHub, vanished, "reconcile");

    this.host.storage.sql.exec(
      "INSERT OR REPLACE INTO task_sync (key, value) VALUES ('syncedAt', ?)",
      new Date().toISOString(),
    );
  }

  /**
   * Re-reads the given Issues. It also re-reads a sub-issue's parent, whose Subtask
   * count may have moved, and, when an Issue opened or closed, the Issues it blocks.
   */
  private async refresh(
    gitHub: GitHub,
    numbers: TaskNumber[],
    via: TaskSyncVia,
    closed?: WebhookChange["closed"],
  ): Promise<void> {
    const queue = [...numbers];
    const seen = new Set<TaskNumber>();
    for (let number = queue.shift(); number !== undefined; number = queue.shift()) {
      if (seen.has(number)) continue;
      seen.add(number);
      const before = this.read(number);
      const issue = await gitHub.getIssue(number);
      if (issue === null) {
        if (before !== null) this.remove(number, via);
        continue;
      }
      if (issue.parent !== undefined) queue.push(issue.parent);
      const wasDone = before?.status === "done";
      if (before !== null && wasDone !== (issue.state === "closed")) {
        queue.push(...(await gitHub.listBlocking(number)).map((ref) => ref.number));
      }
      const closedBy = closed?.issue === number ? closed.by : undefined;
      this.apply(await readMirror(gitHub, issue), via, closedBy === undefined ? {} : { closedBy });
    }
  }

  /**
   * Writes one Issue into its Task and records what changed. A closed Issue the
   * Channel never saw open is not a Task.
   */
  private apply(mirror: Mirror, via: TaskSyncVia, who: { createdBy?: PersonName; closedBy?: string } = {}): void {
    const { issue } = mirror;
    const before = this.read(issue.number);
    const closed = issue.state === "closed";
    const now = new Date().toISOString();

    if (before === null) {
      if (closed) return;
      const task: Task = { number: issue.number, ...mirroredFields(mirror), status: "open", updatedAt: now };
      this.write(task);
      this.host.append({
        type: "task.create",
        actor: who.createdBy === undefined ? { kind: "github" } : { kind: "person", person: who.createdBy },
        capture: null,
        task: task.number,
        payload: { title: task.title, url: task.url, via },
      });
      return;
    }

    const { parent: _dropped, ...rest } = before;
    const status = closed ? "done" : before.status === "done" ? "open" : before.status;
    const after: Task = { ...rest, ...mirroredFields(mirror), status, updatedAt: before.updatedAt };
    const fields = changedFields(before, after);
    const done = before.status !== "done" && closed;
    const reopened = before.status === "done" && !closed;
    if (fields.length === 0 && !done && !reopened) return;

    after.updatedAt = now;
    this.write(after);
    if (fields.length > 0) {
      this.host.append({
        type: "task.change",
        actor: { kind: "github" },
        capture: null,
        task: after.number,
        payload: { fields, via },
      });
    }
    if (done) {
      const login = who.closedBy ?? issue.closedBy ?? issue.author;
      this.host.append({
        type: "task.done",
        actor: { kind: "person", person: personFromLogin(login) },
        capture: null,
        task: after.number,
        payload: { closedOnGitHub: true },
      });
    }
    if (reopened) {
      this.host.append({
        type: "task.reopen",
        actor: { kind: "github" },
        capture: null,
        task: after.number,
        payload: { via },
      });
    }
  }

  private remove(number: TaskNumber, via: TaskSyncVia): void {
    this.host.storage.sql.exec("DELETE FROM tasks WHERE number = ?", number);
    this.host.append({ type: "task.remove", actor: { kind: "github" }, capture: null, task: number, payload: { via } });
  }

  private read(number: TaskNumber): Task | null {
    const row = this.host.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", number).toArray()[0];
    return row === undefined ? null : (JSON.parse(row.data) as Task);
  }

  private write(task: Task): void {
    this.host.storage.sql.exec(
      "INSERT OR REPLACE INTO tasks (number, data) VALUES (?, ?)",
      task.number,
      JSON.stringify(task),
    );
    this.host.broadcast({ type: "task", task });
  }
}

/** Maps with at most RECONCILE_CONCURRENCY calls in flight, keeping the input order. */
async function mapPooled<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, items.length) }, worker));
  return results;
}
