import type {
  Agent,
  ChannelEvent,
  Overlap,
  RelayConfig,
  Task,
  Verdict,
  VerdictOption,
  VerdictProbabilities,
} from "@shared/index";
import { AGENT_FILES, AGENT_SYMBOLS } from "./fixtures";

export const RELAY: RelayConfig = { interruptThreshold: 0.6, model: "typesafe/jev" };

function eventFiles(event: ChannelEvent): string[] {
  switch (event.type) {
    case "push":
      return event.payload.files.map((f) => f.path);
    case "merge":
      return event.payload.files;
    case "file.edit":
      return [event.payload.path];
    default:
      return [];
  }
}

/** Symbols a push removed or renamed: names on `-` lines that are gone from `+` lines. */
function removedSymbols(event: ChannelEvent): string[] {
  if (event.type !== "push") return [];
  const ident = /\b(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)|\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
  const collect = (type: "add" | "del") => {
    const out = new Set<string>();
    for (const f of event.payload.files)
      for (const h of f.hunks)
        for (const l of h.lines)
          if (l.type === type) for (const m of l.text.matchAll(ident)) out.add(m[1] ?? m[2]);
    return out;
  };
  const added = collect("add");
  return [...collect("del")].filter((s) => !added.has(s));
}

function overlapFor(event: ChannelEvent, agent: Agent): Overlap {
  const mine = AGENT_FILES[agent.id] ?? [];
  const used = AGENT_SYMBOLS[agent.id] ?? [];
  return {
    files: eventFiles(event).filter((f) => mine.includes(f)),
    symbols: removedSymbols(event).filter((s) => used.includes(s)),
  };
}

const pick = (p: VerdictProbabilities): VerdictOption =>
  (Object.entries(p) as [VerdictOption, number][]).sort((a, b) => b[1] - a[1])[0][0];

/**
 * A stand-in for the Relay: overlap in code first, skip Jev when there is none,
 * otherwise use scripted or heuristic probabilities, then apply the threshold
 * and the CLI downgrade exactly as the spec describes.
 */
export function relay(
  event: ChannelEvent,
  agents: Agent[],
  tasks: Task[],
  scripted: Record<string, VerdictProbabilities> = {},
): Verdict[] {
  const verdicts: Verdict[] = [];
  const senderAgent = event.actor.kind === "agent" ? event.actor.agentId : null;

  for (const agent of agents) {
    if (agent.presence === "gone" || agent.id === senderAgent) continue;
    const overlap = overlapFor(event, agent);
    const addressed = event.type === "directive" && event.payload.to === agent.id;
    const heldTask = tasks.find((t) => t.claim?.holder.kind === "agent" && t.claim.holder.agentId === agent.id);
    const sameTask =
      event.task !== undefined &&
      heldTask !== undefined &&
      (event.task === heldTask.number || tasks.find((t) => t.number === event.task)?.parent === heldTask.parent);
    const hasOverlap = overlap.files.length > 0 || overlap.symbols.length > 0;

    let probabilities = scripted[agent.id];
    if (!probabilities) {
      if (addressed) probabilities = { drop: 0.01, queue: 0.05, interrupt: 0.94 };
      else if (hasOverlap && event.type === "push") probabilities = { drop: 0.06, queue: 0.61, interrupt: 0.33 };
      else if (hasOverlap) probabilities = { drop: 0.35, queue: 0.58, interrupt: 0.07 };
      else if (sameTask && (event.type === "update" || event.type === "takeover" || event.type === "merge"))
        probabilities = { drop: 0.22, queue: 0.74, interrupt: 0.04 };
    }

    if (!probabilities) {
      verdicts.push({ event: event.id, agent: agent.id, at: event.at, option: "drop", source: "skipped", overlap });
      continue;
    }

    let option = pick(probabilities);
    let downgraded: Verdict["downgraded"];
    if (option === "interrupt" && probabilities.interrupt < RELAY.interruptThreshold) {
      option = "queue";
      downgraded = { from: "interrupt", reason: "below-threshold" };
    } else if (option === "interrupt" && !agent.canReceiveInterrupts) {
      option = "queue";
      downgraded = { from: "interrupt", reason: "cli-cannot-interrupt" };
    }
    verdicts.push({
      event: event.id,
      agent: agent.id,
      at: event.at,
      option,
      source: "jev",
      probabilities,
      downgraded,
      overlap,
      latencyMs: 170 + Math.round(Math.random() * 60),
    });
  }
  return verdicts;
}
