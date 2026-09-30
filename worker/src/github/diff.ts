// Turns GitHub's per-file unified diffs (the compare API's `patch`) into the diff
// hunks `push` and `merge` Events carry, capped so one Event stays small: about
// DIFF_LINES_PER_FILE lines per file and DIFF_LINES_PER_EVENT in all. Whatever is
// cut is marked, and the Event says how to get the full diff with git.

import type { DiffHunk, DiffLine, FileChange } from "../../../shared/src/index";
import { DIFF_LINES_PER_EVENT, DIFF_LINES_PER_FILE } from "../../../shared/src/index";
import type { ComparedFile } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses one file's unified diff into hunks. Lines before the first hunk header are ignored. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (hunk === null) continue;
    const text = line.slice(1);
    let parsed: DiffLine;
    if (line.startsWith("+")) parsed = { type: "add", oldNo: null, newNo: newNo++, text };
    else if (line.startsWith("-")) parsed = { type: "del", oldNo: oldNo++, newNo: null, text };
    else if (line.startsWith(" ")) parsed = { type: "ctx", oldNo: oldNo++, newNo: newNo++, text };
    // "\ No newline at end of file", or the empty string after a trailing newline.
    else continue;
    hunk.lines.push(parsed);
  }
  return hunks;
}

/** Keeps at most `budget` diff lines of `hunks`, in order. */
function take(hunks: DiffHunk[], budget: number): { hunks: DiffHunk[]; kept: number; cut: boolean } {
  const kept: DiffHunk[] = [];
  let left = budget;
  for (const hunk of hunks) {
    if (left <= 0) return { hunks: kept, kept: budget, cut: true };
    if (hunk.lines.length <= left) {
      kept.push(hunk);
      left -= hunk.lines.length;
    } else {
      kept.push({ header: hunk.header, lines: hunk.lines.slice(0, left) });
      return { hunks: kept, kept: budget, cut: true };
    }
  }
  return { hunks: kept, kept: budget - left, cut: false };
}

/**
 * The changed files of a push or merge with their capped hunks, and, when anything
 * was cut, a note pointing at the full diff: `git diff <base>...<head>`.
 */
export function capFileChanges(
  files: ComparedFile[],
  base: string,
  head: string,
): { files: FileChange[]; truncationNote?: string } {
  let left = DIFF_LINES_PER_EVENT;
  let truncated = false;
  const changes = files.map((file): FileChange => {
    const change: FileChange = { path: file.path, additions: file.additions, deletions: file.deletions, hunks: [] };
    if (file.patch === undefined) {
      // Binary, or too large for GitHub to send a patch.
      if (file.additions + file.deletions > 0) {
        change.truncated = true;
        truncated = true;
      }
      return change;
    }
    const taken = take(parsePatch(file.patch), Math.min(DIFF_LINES_PER_FILE, left));
    left -= taken.kept;
    change.hunks = taken.hunks;
    if (taken.cut) {
      change.truncated = true;
      truncated = true;
    }
    return change;
  });
  if (!truncated) return { files: changes };
  return {
    files: changes,
    truncationNote:
      `Diff hunks are capped at about ${DIFF_LINES_PER_FILE} lines per file and ${DIFF_LINES_PER_EVENT} per Event; ` +
      `files marked truncated were cut. For the full diff: git fetch origin && git diff ${short(base)}...${short(head)}`,
  };
}

/** A commit SHA, shortened; a branch name as its remote-tracking ref. */
function short(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : `origin/${ref}`;
}
