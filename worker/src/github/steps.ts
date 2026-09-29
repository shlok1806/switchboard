import type { Step } from "../../../shared/src/index";

// A GitHub task-list item: `- [ ] text`, `* [x] text` or `+ [X] text`, at any indent.
const CHECKLIST_ITEM = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*\S)\s*$/;
const FENCE = /^\s*(```|~~~)/;

interface ChecklistLine {
  /** Which line of the body it is on. */
  line: number;
  step: Step;
}

/** Every checklist item in an Issue body, in order. Items inside code fences do not count. */
function checklist(lines: string[]): ChecklistLine[] {
  const items: ChecklistLine[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;
    const item = CHECKLIST_ITEM.exec(line);
    if (item?.[2] !== undefined && item[4] !== undefined) {
      items.push({ line: i, step: { index: items.length, text: item[4], done: item[2] !== " " } });
    }
  });
  return items;
}

/** Parses the checklist Steps out of an Issue body. Items inside code fences do not count. */
export function parseSteps(body: string): Step[] {
  return checklist(body.split(/\r?\n/)).map((item) => item.step);
}

/**
 * Ticks Step `index` in an Issue body, leaving every other character as it was.
 * Returns the body unchanged when the Step is already ticked, and null when the
 * body has no Step `index` with `text` (the Steps changed on GitHub).
 */
export function tickStep(body: string, index: number, text: string): string | null {
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const item = checklist(lines)[index];
  if (item === undefined || item.step.text !== text) return null;
  if (item.step.done) return body;
  lines[item.line] = (lines[item.line] ?? "").replace(CHECKLIST_ITEM, (_all, open, _mark, close, rest) => {
    const trailing = /\s*$/.exec(lines[item.line] ?? "")?.[0] ?? "";
    return `${open}x${close}${rest}${trailing}`;
  });
  return lines.join(newline);
}
