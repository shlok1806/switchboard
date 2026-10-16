// Histories longer than what the Dashboard loads. The store holds only the Channel's
// latest Events (and older pages the feed asked for), so a view of one Agent or one
// Task reads that scope's own pages from the Channel and merges them with what is
// loaded, which also brings in new Events as they arrive.

import type { AgentId, ChannelEvent } from "@shared/index";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HistoryScope } from "./source";
import { useChannel, useStore } from "./store";

export interface ScopedHistory {
  /** The scope's Events known so far, oldest first. */
  events: ChannelEvent[];
  /** The Channel has older Events in this scope. */
  more: boolean;
  loading: boolean;
  loadOlder: () => void;
}

interface Pages {
  key: string;
  events: ChannelEvent[];
  olderBefore?: number;
  loading: boolean;
}

/** The Events of `scope`: those loaded that `matches` keeps, and the scope's own pages, oldest first. */
export function useScopedHistory(scope: HistoryScope, matches: (event: ChannelEvent) => boolean): ScopedHistory {
  const store = useStore();
  const { events } = useChannel();
  const key = "agent" in scope ? `agent:${scope.agent}` : `task:${scope.task}`;
  const [pages, setPages] = useState<Pages>({ key, events: [], loading: true });

  // Stable for one scope, so the effects do not run again on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the scope.
  const stableScope = useMemo(() => scope, [key]);

  const read = useCallback(
    async (before?: number): Promise<boolean> => {
      setPages((p) => (p.key === key ? { ...p, loading: true } : { key, events: [], loading: true }));
      try {
        const page = await store.source.scopedEvents(stableScope, before);
        setPages((p) =>
          p.key === key
            ? { key, events: [...page.events, ...p.events], olderBefore: page.olderBefore, loading: false }
            : p,
        );
        return true;
      } catch {
        // Showing what is loaded is still right; "Show older" tries again.
        setPages((p) => (p.key === key ? { ...p, loading: false } : p));
        return false;
      }
    },
    [store, stableScope, key],
  );

  // The first page is what the view is about, so a failed read is tried again, a few times, backing off.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (n: number) => {
      if (cancelled || (await read())) return;
      if (n < 3 && !cancelled) timer = setTimeout(() => void attempt(n + 1), 1000 * 2 ** n);
    };
    void attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [read]);

  const merged = useMemo(() => {
    const byId = new Map<string, ChannelEvent>();
    // The Channel's page for a scope may hold Events this view leaves out (a Task's Verdicts, say).
    if (pages.key === key) for (const e of pages.events) if (matches(e)) byId.set(e.id, e);
    for (const e of events) if (matches(e)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
  }, [pages, events, matches, key]);

  const current = pages.key === key;
  return {
    events: merged,
    more: current && pages.olderBefore !== undefined,
    loading: !current || pages.loading,
    loadOlder: () => {
      if (current && !pages.loading && pages.olderBefore !== undefined) void read(pages.olderBefore);
    },
  };
}

/** The Events with these IDs: those loaded, and the rest read from the Channel. */
export function useEventsById(ids: readonly string[]): Map<string, ChannelEvent> {
  const store = useStore();
  const { events } = useChannel();
  const [read, setRead] = useState<ChannelEvent[]>([]);
  const missing = useMemo(() => {
    const loaded = new Set(events.map((e) => e.id));
    return ids.filter((id) => !loaded.has(id));
  }, [ids, events]);
  const wanted = missing.join(",");

  useEffect(() => {
    if (wanted === "") return;
    let cancelled = false;
    store.source
      .eventsById(wanted.split(","))
      .then((found) => {
        if (!cancelled) setRead(found);
      })
      .catch(() => {
        // The links still work: each opens its Event by ID.
      });
    return () => {
      cancelled = true;
    };
  }, [store, wanted]);

  return useMemo(() => {
    const byId = new Map(read.map((e) => [e.id, e]));
    for (const e of events) if (ids.includes(e.id)) byId.set(e.id, e);
    return byId;
  }, [read, events, ids]);
}

/** Whether an Event's detail is on hand: still being read, not on the Channel, or unreadable. */
export type DetailStatus = "ready" | "reading" | "missing" | "failed";

/**
 * Event `id` and the Agents a Wake delivered it to. An Event older than those loaded
 * (a link to it) is read by ID, with the Wakes after it: they come soon after it.
 */
export function useEventDetail(id: string | undefined): { event?: ChannelEvent; woken: Set<AgentId>; loaded: boolean; status: DetailStatus } {
  const store = useStore();
  const { events } = useChannel();
  const loaded = id === undefined ? undefined : events.find((e) => e.id === id);
  const [read, setRead] = useState<{ id: string; event?: ChannelEvent; wakes: ChannelEvent[]; failed?: boolean }>();

  useEffect(() => {
    if (id === undefined || loaded !== undefined) return;
    let cancelled = false;
    (async () => {
      const [event] = await store.source.eventsById([id]);
      const wakes = event === undefined ? [] : await store.source.wakesAfter(event.seq);
      if (!cancelled) setRead({ id, event, wakes });
    })().catch(() => {
      // The Channel is unreachable: the detail says so rather than reading forever.
      if (!cancelled) setRead({ id, wakes: [], failed: true });
    });
    return () => {
      cancelled = true;
    };
  }, [store, id, loaded]);

  return useMemo(() => {
    if (id === undefined) return { woken: new Set(), loaded: true, status: "ready" as const };
    // Every Event after a loaded one is loaded too, so its Wakes and Verdicts are.
    if (loaded !== undefined) return { event: loaded, woken: wokenFor(events, id), loaded: true, status: "ready" as const };
    if (read?.id !== id) return { woken: new Set(), loaded: false, status: "reading" as const };
    if (read.failed) return { woken: new Set(), loaded: false, status: "failed" as const };
    if (!read.event) return { woken: new Set(), loaded: false, status: "missing" as const };
    return { event: read.event, woken: wokenFor([...read.wakes, ...events], id), loaded: false, status: "ready" as const };
  }, [id, loaded, events, read]);
}

/** The Agents a Wake delivered Event `id` to: their Queue on it did not wait for their next turn. */
export function wokenFor(events: readonly ChannelEvent[], id: string): Set<AgentId> {
  const woken = new Set<AgentId>();
  for (const e of events) {
    if (e.type === "wake" && e.actor.kind === "agent" && e.payload.events.includes(id)) woken.add(e.actor.agentId);
  }
  return woken;
}
