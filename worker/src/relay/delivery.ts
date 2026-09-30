// What a Queued Event looks like when it reaches an Agent (ADR 0005): short
// structured facts (who, which Task, what changed), plus committed diff hunks only
// for the files the receiving Agent touches, capped at DELIVERY_DIFF_LINES, with a
// `git fetch` pointer when something was cut. It is built only from an Event that
// passed `agentDeliverable`, so raw Proxy content cannot reach an Agent: the type
// system refuses anything else.

import type {
  Actor,
  AgentDeliverable,
  ChannelEvent,
  Delivery,
  DiffHunk,
  FileChange,
  Task,
  TaskNumber,
  Verdict,
} from "../../../shared/src/index";
import { DELIVERY_DIFF_LINES, DELIVERY_MAX_FILES, holderName, truncate } from "../../../shared/src/index";
import { removedSymbols } from "./overlap";

/** The longest Update or Directive text a Delivery quotes, in characters. */
const MAX_QUOTE = 500;

function quote(text: string): string {
  return JSON.stringify(truncate(text.replace(/\s+/g, " ").trim(), MAX_QUOTE));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One short line of facts about an Event, from its sender's point of view. */
export function summarizeEvent(event: ChannelEvent): string {
  switch (event.type) {
    case "push":
      return (
        `pushed ${plural(Math.max(event.payload.commits.length, 1), "commit")} to ${event.payload.branch} ` +
        `(${event.payload.commit.slice(0, 7)}): ${quote(event.payload.message)}`
      );
    case "merge":
      return `merged pull request #${event.payload.pr} (${event.payload.branch}) into ${event.payload.into} (${event.payload.commit.slice(0, 7)})`;
    case "file.edit":
      return `edited ${event.payload.path} (+${event.payload.additions} -${event.payload.deletions}), not committed yet`;
    case "update":
      return `posted an Update: ${quote(event.payload.text)}`;
    case "directive":
      return `sent a Directive to ${event.payload.to}: ${quote(event.payload.text)}`;
    case "claim":
      return `claimed the Task for ${holderName(event.payload.holder)}`;
    case "claim.release":
      return `released the Claim of ${holderName(event.payload.holder)}`;
    case "claim.stale":
      return `the Claim of ${holderName(event.payload.holder)} is Stale: its holder is Gone`;
    case "claim.recovered":
      return `${holderName(event.payload.holder)} is back, so its Claim is no longer Stale`;
    case "claim.blocked":
      return `the Task claimed by ${holderName(event.payload.holder)} is now blocked by ${event.payload.blockedBy.map((n) => `#${n}`).join(", ")}`;
    case "claim.unblocked":
      return `the Task claimed by ${holderName(event.payload.holder)} is no longer blocked`;
    case "step.complete":
      return `completed Step ${event.payload.step}: ${quote(event.payload.text)}`;
    case "takeover":
      return `took over the Stale Claim of ${holderName(event.payload.from)} for ${holderName(event.payload.to)}`;
    case "task.branch":
      return `started branch ${event.payload.branch}`;
    case "task.review":
      return `finished the Task: pull request #${event.payload.pr} is open for review`;
    case "task.done":
      return event.payload.closedOnGitHub ? "closed the Issue on GitHub: the Task is done" : "the Task is done";
    case "task.create":
      return `created Task ${quote(event.payload.title)}`;
    case "task.change":
      return `changed the Task on GitHub: ${event.payload.fields.join(", ")}`;
    case "task.reopen":
      return "reopened the Issue on GitHub";
    case "task.remove":
      return "deleted or moved the Issue on GitHub: the Task is gone";
    default:
      return event.type;
  }
}

/** Keeps at most `budget` diff lines of `hunks`, in order. */
function take(hunks: readonly DiffHunk[], budget: number): { hunks: DiffHunk[]; used: number; cut: boolean } {
  const kept: DiffHunk[] = [];
  let left = budget;
  for (const hunk of hunks) {
    if (left <= 0) return { hunks: kept, used: budget, cut: true };
    if (hunk.lines.length <= left) {
      kept.push(hunk);
      left -= hunk.lines.length;
    } else {
      kept.push({ header: hunk.header, lines: hunk.lines.slice(0, left) });
      return { hunks: kept, used: budget, cut: true };
    }
  }
  return { hunks: kept, used: budget - left, cut: false };
}

/**
 * The files of a push or merge for one Agent: every changed file listed (up to
 * DELIVERY_MAX_FILES), hunks kept only for the files in `mine`, DELIVERY_DIFF_LINES
 * lines in all. `cut` lists the files of `mine` whose hunks were cut here or by GitHub.
 */
export function filesFor(
  files: readonly FileChange[],
  mine: ReadonlySet<string>,
): { files: FileChange[]; moreFiles: number; cut: string[] } {
  // The Agent's own files first, so they are listed and keep their hunks.
  const ordered = [...files.filter((f) => mine.has(f.path)), ...files.filter((f) => !mine.has(f.path))];
  const listed = ordered.slice(0, DELIVERY_MAX_FILES);
  let left = DELIVERY_DIFF_LINES;
  const cut: string[] = [];
  const out = listed.map((file): FileChange => {
    const base = { path: file.path, additions: file.additions, deletions: file.deletions };
    if (!mine.has(file.path)) return { ...base, hunks: [] };
    const taken = take(file.hunks, left);
    left -= taken.used;
    const truncated = taken.cut || file.truncated === true;
    if (truncated) cut.push(file.path);
    return { ...base, hunks: taken.hunks, ...(truncated ? { truncated: true } : {}) };
  });
  return { files: out, moreFiles: files.length - listed.length, cut };
}

function shellPaths(paths: readonly string[]): string {
  return paths.map((p) => (/^[\w./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`)).join(" ");
}

/** How to get the full diff of the files that were cut. */
function fetchPointer(event: ChannelEvent, paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  if (event.type === "push") {
    const count = Math.max(event.payload.commits.length, 1);
    return `git fetch origin && git log -p -${count} origin/${event.payload.branch} -- ${shellPaths(paths)}`;
  }
  if (event.type === "merge") {
    const commit = event.payload.commit.slice(0, 12);
    return `git fetch origin && git diff ${commit}^1 ${commit} -- ${shellPaths(paths)}`;
  }
  return undefined;
}

/** The unified diff text of `files`, capped, for Jev: the Agent's own files first. */
export function diffText(files: readonly FileChange[], mine: ReadonlySet<string>): string {
  const ordered = [...files.filter((f) => mine.has(f.path)), ...files.filter((f) => !mine.has(f.path))];
  let left = DELIVERY_DIFF_LINES;
  const lines: string[] = [];
  for (const file of ordered) {
    if (left <= 0) break;
    if (file.hunks.length === 0) continue;
    const taken = take(file.hunks, left);
    left -= taken.used;
    lines.push(`--- ${file.path}`);
    for (const hunk of taken.hunks) {
      lines.push(hunk.header);
      for (const line of hunk.lines) {
        lines.push(`${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`);
      }
    }
  }
  return lines.join("\n");
}

/** Builds the Delivery of one Event for one Agent. Only an Event that passed `agentDeliverable` may be delivered. */
export function buildDelivery(
  event: AgentDeliverable,
  sender: Actor,
  verdict: { id: string } & Pick<Verdict, "option" | "delivered" | "overlap" | "addressed">,
  mine: ReadonlySet<string>,
  taskOf: (number: TaskNumber) => Task | null,
): Delivery {
  const known = event.task === undefined ? null : taskOf(event.task);
  const task =
    event.task === undefined ? undefined : { number: event.task, ...(known === null ? {} : { title: known.title }) };
  const changes = event.type === "push" || event.type === "merge" ? event.payload.files : [];
  const { files, moreFiles, cut } = filesFor(changes, mine);
  // A file the Agent does not touch carries no hunks, but if it removed or renamed a
  // symbol the Agent uses, the Agent gets the pointer to read that change.
  const used = new Set(verdict.overlap.symbols);
  const renamedIn = changes
    .filter((file) => !mine.has(file.path) && removedSymbols([file]).some((name) => used.has(name)))
    .map((file) => file.path);
  const fetch = fetchPointer(event, [...cut, ...renamedIn]);
  return {
    id: verdict.id,
    event: event.id,
    seq: event.seq,
    at: event.at,
    sender,
    type: event.type,
    ...(task === undefined ? {} : { task }),
    summary: summarizeEvent(event),
    files,
    ...(moreFiles > 0 ? { moreFiles } : {}),
    ...(fetch === undefined ? {} : { fetch }),
    overlap: {
      files: verdict.overlap.files,
      symbols: verdict.overlap.symbols,
      ...(verdict.addressed === undefined ? {} : { addressed: verdict.addressed }),
    },
    verdict: { option: verdict.option, delivered: verdict.delivered },
  };
}
