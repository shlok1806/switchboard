import type { Step } from "../../../shared/src/index";

// A GitHub task-list item: `- [ ] text`, `* [x] text` or `+ [X] text`, at any indent.
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Parses the checklist Steps out of an Issue body. Items inside code fences do not count. */
export function parseSteps(body: string): Step[] {
  const steps: Step[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const item = CHECKLIST_ITEM.exec(line);
    if (item?.[1] !== undefined && item[2] !== undefined) {
      steps.push({ index: steps.length, text: item[2], done: item[1] !== " " });
    }
  }
  return steps;
}
