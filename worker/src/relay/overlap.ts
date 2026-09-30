// The overlap the Relay works out in code before it asks Jev, so the strongest
// signal never depends on the model spotting it. Deliberately simple:
//
// - Shared files: paths the Event changed (a push's or merge's files, a file edit's
//   path) that the Agent touched (its `file.edit` Events) or that its Task's own
//   pushes changed.
// - Removed or renamed symbols: names a declaration line in the Event's diff took
//   away (`function`, `class`, `const`, `def`, ... on a deleted line) that no added
//   line of the same diff still mentions. A rename looks exactly like that.
// - Symbols the Agent uses: those names, found as whole words in the Agent's
//   corpus: the added and context lines of recent committed hunks for its touched
//   and Task files, and of its own Task's pushes. The Channel never sees
//   uncommitted code, so a name only used in uncommitted work is missed (the shared
//   file usually catches that case).

import type { ChannelEvent, DiffHunk, FileChange } from "../../../shared/src/index";

/** A declaration on one line of code, and the name it declares. */
const DECLARATION =
  /\b(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|namespace)\s+([A-Za-z_$][\w$]*)/g;

/** Every identifier on a line. */
const WORD = /[A-Za-z_$][\w$]*/g;

/** Names shorter than this are too common to mean anything. */
const MIN_SYMBOL_LENGTH = 3;

/** The files an Event changed, as paths. */
export function eventFiles(event: ChannelEvent): string[] {
  switch (event.type) {
    case "push":
    case "merge":
      return event.payload.files.map((file) => file.path);
    case "file.edit":
      return [event.payload.path];
    default:
      return [];
  }
}

/** The files of a push or merge, with their hunks. Empty for other Events. */
export function eventChanges(event: ChannelEvent): FileChange[] {
  return event.type === "push" || event.type === "merge" ? event.payload.files : [];
}

function linesOf(hunks: readonly DiffHunk[], types: readonly ("add" | "del" | "ctx")[]): string[] {
  return hunks.flatMap((hunk) => hunk.lines.filter((line) => types.includes(line.type)).map((line) => line.text));
}

/** Names the diff declared on deleted lines and no longer mentions on any added line. */
export function removedSymbols(files: readonly FileChange[]): string[] {
  const hunks = files.flatMap((file) => file.hunks);
  const added = new Set(linesOf(hunks, ["add"]).flatMap((line) => line.match(WORD) ?? []));
  const removed = new Set<string>();
  for (const line of linesOf(hunks, ["del"])) {
    for (const match of line.matchAll(DECLARATION)) {
      const name = match[1];
      if (name !== undefined && name.length >= MIN_SYMBOL_LENGTH && !added.has(name)) removed.add(name);
    }
  }
  return [...removed];
}

/** The words of the added and context lines of `files`: code as it stands after those changes. */
export function corpusOf(files: readonly FileChange[]): Set<string> {
  return new Set(
    linesOf(
      files.flatMap((file) => file.hunks),
      ["add", "ctx"],
    ).flatMap((line) => line.match(WORD) ?? []),
  );
}

/** What the Relay knows about one receiving Agent's work, for overlap. */
export interface AgentWork {
  /** Files it touched, most recent first. */
  touched: readonly string[];
  /** Files its Task's pushes changed. */
  taskFiles: readonly string[];
  /** Words in the committed code it works on. */
  corpus: ReadonlySet<string>;
}

/** Shared files and used symbols between one Event and one Agent's work. */
export function overlapOf(event: ChannelEvent, work: AgentWork): { files: string[]; symbols: string[] } {
  const mine = new Set([...work.touched, ...work.taskFiles]);
  const files = [...new Set(eventFiles(event).filter((path) => mine.has(path)))];
  const symbols = removedSymbols(eventChanges(event)).filter((name) => work.corpus.has(name));
  return { files, symbols };
}
