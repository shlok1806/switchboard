import type { FileChange } from "@shared/index";
import CodeBlock, { type CodePiece, type DiffRow } from "@/components/primitives/CodeBlock";

/** Mark the changed middle of a removed/added line pair, so a rename reads at a glance. */
function pair(del: string, add: string): [CodePiece[], CodePiece[]] {
  let s = 0;
  while (s < del.length && s < add.length && del[s] === add[s]) s++;
  let e = 0;
  while (e < del.length - s && e < add.length - s && del[del.length - 1 - e] === add[add.length - 1 - e]) e++;
  const split = (t: string, change: "add" | "del"): CodePiece[] =>
    [
      { text: t.slice(0, s) },
      { text: t.slice(s, t.length - e), change },
      { text: t.slice(t.length - e) },
    ].filter((p) => p.text.length > 0);
  return [split(del, "del"), split(add, "add")];
}

export function toRows(file: FileChange): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const h of file.hunks) {
    const lines = h.lines;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.type === "del") {
        // collect a run of dels followed by the same number of adds, and pair them
        let j = i;
        while (j < lines.length && lines[j].type === "del") j++;
        let k = j;
        while (k < lines.length && lines[k].type === "add") k++;
        const dels = lines.slice(i, j);
        const adds = lines.slice(j, k);
        if (dels.length === adds.length) {
          const pairs = dels.map((d, n) => pair(d.text, adds[n].text));
          dels.forEach((d, n) => rows.push({ old: d.oldNo, cur: null, type: "del", pieces: pairs[n][0] }));
          adds.forEach((a, n) => rows.push({ old: null, cur: a.newNo, type: "add", pieces: pairs[n][1] }));
          i = k - 1;
          continue;
        }
      }
      rows.push({ old: l.oldNo, cur: l.newNo, type: l.type, pieces: [{ text: l.text }] });
    }
  }
  return rows;
}

/** Committed diff hunks for one file, in Beautiful UI's CodeBlock diff view. */
export function FileDiff({ file }: { file: FileChange }) {
  return <CodeBlock variant="Diff" filename={file.path} diff={toRows(file)} className="w-full" />;
}
