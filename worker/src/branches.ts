// One branch and one pull request per Task (ADR 0006), on the Channel's side.
//
// - The holder's wrapper creates the Task branch and its worktree when an Agent
//   claims a Task, then reports the branch here. The Task records it; a later
//   holder picks up the same branch.
// - Finishing a Task opens a pull request from its branch into the default branch
//   whose body closes the Issue and names the holder, and marks the Task in review.
//   When the PR merges, GitHub closes the Issue and the Task sync marks it done.
// - A Task branch pushed without the wrapper reporting it (the Agent made its own)
//   is linked to its claimed Task when the push arrives.
// - Pushes to Task branches and merges into the default branch arrive from the
//   GitHub webhook and become `push` and `merge` Events, with the changed files
//   and capped diff hunks read from the compare API.

import type { ChannelEvent, EventType, Holder, PushCommit, Task, TaskNumber } from "../../shared/src/index";
import { CLAIMED_LABEL, REVIEW_LABEL, taskOfBranch } from "../../shared/src/index";
import type { NewEvent } from "./channel";
import type { Caller, ClaimResult, Claims } from "./claims";
import { APP_NOT_CONFIGURED, type CodeChange, capFileChanges, type GitHub } from "./github/index";
import type { Tasks } from "./tasks";

/** A push Event lists at most this many commits, the newest ones. */
const MAX_PUSH_COMMITS = 50;

/** What the Channel lends this module. */
export interface BranchHost {
  tasks: Tasks;
  claims: Claims;
  gitHub(): GitHub | null;
  append<K extends EventType>(event: NewEvent<K>): ChannelEvent;
  /** Records an Event under a fixed ID, or returns null when the Channel already has it. */
  appendOnce<K extends EventType>(id: string, event: NewEvent<K>): ChannelEvent | null;
}

export type CodeEventResult =
  | { ok: true; event: ChannelEvent | null }
  | { ok: false; status: 502 | 503; reason: string };

function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").slice(0, 200);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** The pull request body: it closes the Issue and names the holder (ADR 0006). */
export function pullRequestBody(number: TaskNumber, holder: string, summary: string | undefined): string {
  const lines = [`Closes #${number}`, "", `Opened via Switchboard by ${holder}.`];
  if (summary !== undefined && summary.trim().length > 0) lines.push("", summary.trim());
  return lines.join("\n");
}

export class Branches {
  constructor(private readonly host: BranchHost) {}

  /** The holder's wrapper reports the Task branch it created and pushed. */
  async record(caller: Caller, number: TaskNumber, branch: string): Promise<ClaimResult> {
    const synced = await this.host.tasks.ensureSynced();
    if (!synced.ok) return synced;
    const { claims, tasks } = this.host;

    const who = claims.resolve(caller);
    if (!who.ok) return who;
    const { acting } = who;
    if (taskOfBranch(branch) !== number) {
      return { ok: false, status: 400, reason: `Task #${number}'s branch must be named task/${number}-<slug>.` };
    }
    const held = claims.held(acting, number, "set the branch of");
    if (!held.ok) return held;
    const { task } = held;
    if (task.branch === branch) return { ok: true, task };
    if (task.branch !== undefined) {
      return { ok: false, status: 409, reason: `Task #${number} already has branch ${task.branch}.` };
    }
    tasks.write({ ...task, branch, updatedAt: new Date().toISOString() });
    this.host.append({
      type: "task.branch",
      actor: acting.actor,
      capture: acting.capture,
      task: number,
      payload: { branch },
    });
    return claims.current(number);
  }

  /**
   * The holder finishes the Task: a pull request from its branch that closes the
   * Issue, and the Task goes to review. Finishing a Task in review changes nothing.
   */
  async finish(caller: Caller, number: TaskNumber, summary?: string): Promise<ClaimResult> {
    const synced = await this.host.tasks.ensureSynced();
    if (!synced.ok) return synced;
    const { claims, tasks } = this.host;

    const who = claims.resolve(caller);
    if (!who.ok) return who;
    const { acting } = who;
    const held = claims.held(acting, number, "finish");
    if (!held.ok) return held;
    const { task, holder } = held;
    if (task.status === "review" && task.pr !== undefined) return { ok: true, task };
    const branch = task.branch;
    if (branch === undefined) {
      return {
        ok: false,
        status: 409,
        reason: `Task #${number} has no branch yet. Claiming it through the Switchboard wrapper creates one.`,
      };
    }
    const gitHub = this.host.gitHub();
    if (gitHub === null) return { ok: false, status: 503, reason: APP_NOT_CONFIGURED };

    let pr: { number: number; url: string };
    try {
      pr = await tasks.exclusive(async () =>
        gitHub.createPullRequest({
          title: task.title,
          body: pullRequestBody(number, this.holderLine(holder), summary),
          head: branch,
          base: await gitHub.defaultBranch(),
        }),
      );
    } catch (error) {
      return { ok: false, status: 502, reason: `GitHub refused the pull request: ${errorText(error)}` };
    }

    // The Task may have moved while GitHub answered: only a Task still held the same way goes to review.
    const now = tasks.read(number);
    if (now === null || now.status === "done" || now.claim === undefined) return claims.current(number);
    tasks.write({ ...now, status: "review", pr: pr.number, updatedAt: new Date().toISOString() });
    this.host.append({
      type: "task.review",
      actor: acting.actor,
      capture: acting.capture,
      task: number,
      payload: { pr: pr.number, url: pr.url, branch },
    });
    claims.status.note(number, `Pull request #${pr.number} opened by ${claims.describe(holder)}.`);

    await claims.mirror(acting, "finish", number, async (gh) => [
      [
        "label",
        async () => {
          await gh.addLabels(number, [REVIEW_LABEL]);
          await gh.removeLabel(number, CLAIMED_LABEL);
          claims.keepLabels(number, (labels) => [
            ...labels.filter((l) => l !== CLAIMED_LABEL && l !== REVIEW_LABEL),
            REVIEW_LABEL,
          ]);
        },
      ],
      claims.statusCall(gh, number),
    ]);
    return claims.current(number);
  }

  /**
   * A verified `push` or `pull_request` delivery. Reads what changed from the compare
   * API and records one Event, under the delivery's ID so a redelivery is not
   * recorded twice. A push that changes nothing (a new branch at main) records none.
   */
  async codeEvent(delivery: string, change: CodeChange): Promise<CodeEventResult> {
    const gitHub = this.host.gitHub();
    if (gitHub === null) return { ok: false, status: 503, reason: APP_NOT_CONFIGURED };
    if (change.kind === "push" && change.task !== null) this.linkBranch(change.task, change.branch);
    let comparison: Awaited<ReturnType<GitHub["compare"]>>;
    try {
      comparison = await gitHub.compare(change.base, change.head);
    } catch (error) {
      return { ok: false, status: 502, reason: `Could not read the diff from GitHub: ${errorText(error)}` };
    }
    const { files, truncationNote } = capFileChanges(comparison.files, change.base, change.head);
    const note = truncationNote === undefined ? {} : { truncationNote };
    const task = change.task === null ? {} : { task: change.task };
    const id = `github:${delivery}`;

    if (change.kind === "merge") {
      const event = this.host.appendOnce(id, {
        type: "merge",
        actor: { kind: "github" },
        capture: null,
        ...task,
        payload: { into: change.into, pr: change.pr, branch: change.branch, commit: change.commit, files, ...note },
      });
      return { ok: true, event };
    }

    if (comparison.commits.length === 0 && files.length === 0) return { ok: true, event: null };
    const commits: PushCommit[] = comparison.commits
      .slice(-MAX_PUSH_COMMITS)
      .map((c) => ({ sha: c.sha, message: firstLine(c.message) }));
    const newest = comparison.commits.at(-1);
    const event = this.host.appendOnce(id, {
      type: "push",
      actor: { kind: "github" },
      capture: null,
      ...task,
      payload: {
        branch: change.branch,
        commit: change.head,
        message: newest === undefined ? "" : firstLine(newest.message),
        commits,
        files,
        ...note,
      },
    });
    return { ok: true, event };
  }

  /**
   * A Task branch that reached GitHub without the wrapper reporting it, as when
   * setting it up on Claim failed and the Agent made its own (#45). A claimed Task
   * with no branch on record takes it, as if its holder had reported it. Returns
   * the Task when it changed, else null.
   */
  linkBranch(number: TaskNumber, branch: string): Task | null {
    const { tasks } = this.host;
    const task = tasks.read(number);
    if (task === null || task.status !== "claimed" || task.claim === undefined) return null;
    if (task.branch !== undefined || taskOfBranch(branch) !== number) return null;
    const linked = { ...task, branch, updatedAt: new Date().toISOString() };
    tasks.write(linked);
    this.host.append({
      type: "task.branch",
      actor: { kind: "github" },
      capture: null,
      task: number,
      payload: { branch },
    });
    return linked;
  }

  /** How the pull request names the holder: its Agent ID (and Person), or the Person. */
  private holderLine(holder: Holder): string {
    return this.host.claims.describe(holder);
  }
}
