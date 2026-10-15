/*
 * The one state vocabulary (ADR 0023, design.md): shape says why, fill says whose, and the
 * signal colour means only that a Person is needed. Every view draws a state with these.
 */
import { useMemo } from "react";
import type { Agent } from "@shared/index";
import { useChannel, useMe } from "@/data/store";
import { claimsByAgent } from "@/lib/canvas-layout";
import { needsYouCount } from "@/lib/queue";
import { needsPerson, stateOf, stateWord, type AgentState, type GlyphState } from "@/lib/state";
import { cn } from "@/lib/utils";

/** The state's glyph: 12px, decorative (the word beside it carries the meaning). */
export function Glyph({ state, className }: { state: GlyphState; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      data-state={state}
      className={cn("inline-block size-3 shrink-0", needsPerson(state) ? "text-signal" : "text-ink", className)}
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
        signal ? "font-semibold text-signal" : state === "gone" ? "text-ink-3" : state === "idle" ? "text-ink-2" : "text-ink",
        className,
      )}
    >
      {glyph && <Glyph state={state} />}
      {word ?? stateWord(state, person)}
    </span>
  );
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
