/*
 * The one state vocabulary (ADR 0023, design.md): shape says why, fill says whose, and the
 * signal colour means only that a Person is needed. Every view draws a state with these.
 */

import type { Agent } from "@shared/index";
import { useMemo } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { useChannel, useMe } from "@/data/store";
import { claimsByAgent } from "@/lib/canvas-layout";
import { needsYouCount } from "@/lib/queue";
import { type AgentState, type GlyphState, needsPerson, orbOf, stateOf, stateWord } from "@/lib/state";
import { cn } from "@/lib/utils";

/** The state's glyph: 12px, decorative (the word beside it carries the meaning). */
export function Glyph({ state, className }: { state: GlyphState; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      data-state={state}
      className={cn("inline-block size-3 shrink-0", needsPerson(state) ? "text-signal" : state === "running" ? "text-running" : "text-ink", className)}
    >
      {SHAPES[state]}
    </svg>
  );
}

const SHAPES: Record<GlyphState, React.ReactNode> = {
  needs: <rect x="1" y="1" width="10" height="10" fill="currentColor" />,
  "needs-other": <rect x="1.75" y="1.75" width="8.5" height="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  stale: <polygon points="6,1 11.5,11 0.5,11" fill="currentColor" />,
  review: <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" fill="currentColor" />,
  "review-other": <polygon points="6,1.5 10.5,6 6,10.5 1.5,6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  running: <circle cx="6" cy="6" r="5" fill="currentColor" />,
  idle: <circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--ink-3)" strokeWidth="1.5" />,
  // Two bars: stopped on purpose, kept for later. Neither the signal colour nor the running one.
  paused: (
    <>
      <rect x="2.25" y="1.5" width="2.5" height="9" fill="var(--ink-3)" />
      <rect x="7.25" y="1.5" width="2.5" height="9" fill="var(--ink-3)" />
    </>
  ),
  gone: <circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--ink-4)" strokeWidth="1.5" strokeDasharray="0.1 2.6" strokeLinecap="round" />,
  done: <polyline points="1.5,6.5 4.75,9.5 10.5,2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />,
};

/** A state as its glyph and its word: the form every table and inspector uses. */
export function State({
  state,
  person,
  word,
  glyph = true,
  className,
}: {
  state: GlyphState;
  /** Whose prompt waits, for "needs-other". */
  person?: string;
  /** Replaces the word, as on a board column ("In review"). */
  word?: string;
  /** False beside a heading that already draws the glyph. */
  glyph?: boolean;
  className?: string;
}) {
  const signal = needsPerson(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap",
        signal ? "font-semibold text-signal" : state === "gone" || state === "paused" ? "text-ink-3" : state === "idle" ? "text-ink-2" : "text-ink",
        className,
      )}
    >
      {glyph && <Glyph state={state} />}
      {word ?? stateWord(state, person)}
    </span>
  );
}

/**
 * The Agent's thinking orb (ADR 0047), beside its glyph and word and never instead of them,
 * so it is decorative. 20px in a line, 64px on the Agent's own page. The orb draws in ink and
 * follows the Dashboard's theme (lib/theme marks the root dark or light); under reduced motion
 * it holds one still frame, and offscreen it stops drawing. A state with no orb draws
 * nothing, or, with `reserve`, keeps the orb's room so the names in a list stay in line.
 */
export function Orb({ state, size = 20, reserve = false, className }: { state: AgentState; size?: 20 | 64; reserve?: boolean; className?: string }) {
  const orb = orbOf(state);
  if (!orb) return reserve ? <span aria-hidden className={cn("inline-block shrink-0", size === 64 ? "size-16" : "size-5", className)} /> : null;
  return <ThinkingOrb state={orb} size={size} aria-hidden data-orb={orb} className={cn("shrink-0", className)} />;
}

/** Every Agent's state, keyed by its ID, from one selector. */
export function useAgentStates(): Map<string, AgentState> {
  const { agents, tasks } = useChannel();
  const me = useMe();
  return useMemo(() => {
    const claims = claimsByAgent(tasks);
    return new Map(agents.map((a) => [a.id, stateOf(a, claims.get(a.id) ?? [], me)]));
  }, [agents, tasks, me]);
}

/** How many lines need you, from the one count the Now queue gives (lib/queue). */
export function useNeedsYou(): number {
  const { agents, tasks } = useChannel();
  const me = useMe();
  return useMemo(() => needsYouCount(agents, tasks, me), [agents, tasks, me]);
}

/** One Agent's state. */
export function useAgentState(agent: Agent): AgentState {
  return useAgentStates().get(agent.id) ?? "gone";
}
