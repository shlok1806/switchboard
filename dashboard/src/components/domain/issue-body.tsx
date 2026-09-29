import type { ReactNode } from "react";

/**
 * A small, safe reading of a GitHub Issue body: headings, bullets and paragraphs
 * as plain text (no HTML is ever injected). Checklist items are skipped because
 * the Task shows them as Steps.
 */
export function IssueBody({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{para.join(" ")}</p>);
    if (list.length)
      blocks.push(
        <ul key={blocks.length} className="list-disc pl-5">
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
    para = [];
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*]\s+\[[ xX]\]/.test(line)) continue; // a Step
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(
        <h3 key={blocks.length} className="pt-1 text-[12.5px] font-semibold text-ink">
          {heading[1]}
        </h3>,
      );
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
      continue;
    }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  if (!blocks.length) return null;
  return <div className="flex max-w-2xl flex-col gap-2 text-[13.5px] leading-relaxed text-ink-2">{blocks}</div>;
}
