import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type {
  Agent,
  AgentId,
  ChannelEvent,
  ChannelSnapshot,
  StreamMessage,
  Task,
  TaskNumber,
  Verdict,
} from "@shared/index";
import type { ChannelSource, ConnectionState } from "./source";

export interface ChannelState {
  status: "loading" | "ready" | "error";
  error?: string;
  connection: ConnectionState;
  snapshot?: Omit<ChannelSnapshot, "events" | "verdicts" | "agents" | "tasks">;
  agents: Agent[];
  tasks: Task[];
  /** Oldest first. */
  events: ChannelEvent[];
  verdictsByEvent: Map<string, Verdict[]>;
  /** Event ids that arrived live in this session, for enter animations. */
  fresh: Set<string>;
}

type Listener = () => void;

/** Holds Channel state and applies stream messages. Views read it through hooks. */
export class ChannelStore {
  private state: ChannelState = {
    status: "loading",
    connection: "connecting",
    agents: [],
    tasks: [],
    events: [],
    verdictsByEvent: new Map(),
    fresh: new Set(),
  };
  private listeners = new Set<Listener>();
  private messageListeners = new Set<(m: StreamMessage) => void>();

  constructor(readonly source: ChannelSource) {}

  get = () => this.state;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /**
   * Take in a Task the Channel just answered with (a Claim or a release), so the
   * board settles without waiting for the stream to echo it.
   */
  applyTask(task: Task) {
    this.set({ tasks: upsert(this.state.tasks, task, (t) => t.number === task.number) });
  }

  /** For side effects such as toasts. */
  onMessage(l: (m: StreamMessage) => void) {
    this.messageListeners.add(l);
    return () => {
      this.messageListeners.delete(l);
    };
  }

  private set(patch: Partial<ChannelState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  start(): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    this.source
      .snapshot()
      .then((snap) => {
        if (cancelled) return;
        const { events, verdicts, agents, tasks, ...rest } = snap;
        const byEvent = new Map<string, Verdict[]>();
        for (const v of verdicts) byEvent.set(v.event, [...(byEvent.get(v.event) ?? []), v]);
        this.set({ status: "ready", snapshot: rest, events, agents, tasks, verdictsByEvent: byEvent });
        stop = this.source.subscribe(snap.cursor, (m) => this.apply(m), (connection) => this.set({ connection }));
      })
      .catch((e: unknown) => {
        if (!cancelled) this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  private apply(m: StreamMessage) {
    const s = this.state;
    switch (m.type) {
      case "event": {
        if (s.events.some((e) => e.id === m.event.id)) return;
        const fresh = new Set(s.fresh);
        fresh.add(m.event.id);
        this.set({ events: [...s.events, m.event], fresh });
        break;
      }
      case "verdict": {
        const map = new Map(s.verdictsByEvent);
        map.set(m.verdict.event, [...(map.get(m.verdict.event) ?? []), m.verdict]);
        this.set({ verdictsByEvent: map });
        break;
      }
      case "agent":
        this.set({ agents: upsert(s.agents, m.agent, (a) => a.id === m.agent.id) });
        break;
      case "task":
        this.set({ tasks: upsert(s.tasks, m.task, (t) => t.number === m.task.number) });
        break;
      case "person":
        if (s.snapshot)
          this.set({
            snapshot: { ...s.snapshot, persons: upsert(s.snapshot.persons, m.person, (p) => p.name === m.person.name) },
          });
        break;
    }
    for (const l of this.messageListeners) l(m);
  }
}

function upsert<T>(list: T[], item: T, match: (x: T) => boolean): T[] {
  const i = list.findIndex(match);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

const StoreContext = createContext<ChannelStore | null>(null);

export function ChannelProvider({ store, children }: { store: ChannelStore; children: ReactNode }) {
  useEffect(() => store.start(), [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): ChannelStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside ChannelProvider");
  return s;
}

export function useChannel(): ChannelState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMe(): string {
  return useStore().source.me;
}

/** What the Channel behind this Dashboard can do today. */
export function useCapabilities() {
  return useStore().source.capabilities;
}

/** Lookups that views use everywhere. */
export function useIndex() {
  const { agents, tasks } = useChannel();
  return useMemo(() => {
    const agentById = new Map<AgentId, Agent>(agents.map((a) => [a.id, a]));
    const taskByNumber = new Map<TaskNumber, Task>(tasks.map((t) => [t.number, t]));
    return { agentById, taskByNumber };
  }, [agents, tasks]);
}
