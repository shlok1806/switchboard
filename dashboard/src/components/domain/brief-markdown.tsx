/*
 * A page of the Brief (ADR 0042), read as the small Markdown its Agents write: headings,
 * paragraphs, bullet and numbered lists, code blocks, inline code, bold and links. A Task or
 * pull request named as #123 links to its Task page. Nothing is ever injected as HTML: every
 * piece is text React escapes, and a link is drawn only for an http(s) address.
 */
import type { ReactNode } from "react";
import { href } from "@/lib/router";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

/** The page's blocks, in order. */
/** The blocks a page shows: a first heading that only repeats the page's title is left out. */
function shownBlocks(text: string, title?: string): Block[] {
  const blocks = briefBlocks(text);
  const first = blocks[0];
  return first?.kind === "heading" && title !== undefined && first.text.trim().toLowerCase() === title.trim().toLowerCase() ? blocks.slice(1) : blocks;
}

/** A page's headings, for its outline: each with the id `BriefMarkdown` gives it under `headingIds`. */
export function briefOutline(text: string, title: string | undefined, headingIds: string): { id: string; text: string; level: number }[] {
  return shownBlocks(text, title).flatMap((b, i) => (b.kind === "heading" ? [{ id: `${headingIds}-${i}`, text: b.text, level: b.level }] : []));
}

export function briefBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: "para", text: para.join(" ") });
    if (list !== null) blocks.push({ kind: "list", ...list });
    para = [];
    list = null;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```"); i++) code.push(lines[i] ?? "");
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    const item = /^(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      if (para.length > 0 || (list !== null && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3] ?? "");
      continue;
    }
    // A line under a list item, indented, carries the item on.
    if (list !== null && /^\s+/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line}`;
      continue;
    }
    if (list !== null) flush();
    para.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|((?<![\w&/])#\d{1,7}\b)/g;

/** A line's text, with its code, bold, links and Task references drawn. */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, code, bold, link, task] = match;
    const start = match.index ?? 0;
    if (start > at) parts.push(text.slice(at, start));
    const key = parts.length;
    if (code) {
      parts.push(
        <code key={key} className="rounded-[3px] bg-paper-2 px-1 py-px font-mono [overflow-wrap:anywhere] text-ink" /* taste-skill-ignore: inline code */>
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      parts.push(
        <strong key={key} className="font-semibold text-ink">
          {bold.slice(2, -2)}
        </strong>,
      );
    } else if (link) {
      const [, label = "", url = ""] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link) ?? [];
      parts.push(
        /^https?:\/\//.test(url) ? (
          <a key={key} href={url} target="_blank" rel="noreferrer" className="text-ink underline">
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else if (task) {
      parts.push(
        <a
          key={key}
          href={href({ view: "task", number: Number(task.slice(1)) })}
          className="text-ink tabular-nums underline decoration-rule-2 hover:decoration-ink"
        >
          {task}
        </a>,
      );
    }
    at = start + whole.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * A page's Markdown at reading width, as the team's knowledge reads (design.md "Reading"):
 * the serif at 17/1.6 in ink-2, headings in the serif, code in the platform's monospace. A
 * first heading that only repeats the page's title is left out.
 */
export function BriefMarkdown({ text, title, headingIds }: { text: string; title?: string; headingIds?: string }) {
  const shown = shownBlocks(text, title);
  return (
    <div className="flex max-w-[var(--measure)] flex-col gap-4 font-display text-read text-ink-2">
      {shown.map((block, i) => {
        switch (block.kind) {
          case "heading":
            return block.level === 1 ? (
              <h3
                key={i}
                id={headingIds && `${headingIds}-${i}`}
                tabIndex={headingIds ? -1 : undefined}
                className="scroll-mt-6 pt-3 font-display text-section font-medium text-ink"
              >
                <Inline text={block.text} />
              </h3>
            ) : (
              <h4
                key={i}
                id={headingIds && `${headingIds}-${i}`}
                tabIndex={headingIds ? -1 : undefined}
                className="scroll-mt-6 pt-2 font-sans text-title font-semibold text-ink"
              >
                <Inline text={block.text} />
              </h4>
            );
          case "para":
            return (
              <p key={i}>
                <Inline text={block.text} />
              </p>
            );
          case "list": {
            const items = block.items.map((item, j) => (
              <li key={j} className="pl-1">
                <Inline text={item} />
              </li>
            ));
            return block.ordered ? (
              <ol key={i} className="flex list-decimal flex-col gap-1.5 pl-6">
                {items}
              </ol>
            ) : (
              <ul key={i} className="flex list-disc flex-col gap-1.5 pl-6">
                {items}
              </ul>
            );
          }
          default:
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-[var(--r)] bg-paper-2 px-3 py-2.5 font-mono text-small whitespace-pre text-ink" /* taste-skill-ignore: a code block */
              >
                {block.text}
              </pre>
            );
        }
      })}
    </div>
  );
}
