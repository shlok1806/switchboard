import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type {
  AccountUsage,
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
  snapshot?: Omit<ChannelSnapshot, "events" | "verdicts" | "agents" | "tasks" | "accounts">;
  agents: Agent[];
  /** Seen Agents retained for direct pages and links after they leave the current roster. */
  historicalAgents: Agent[];
  /** Every account with usage readings (ADR 0011), most recently read first. */
  accounts: AccountUsage[];
  tasks: Task[];
  /** Oldest first. */
  events: ChannelEvent[];
  verdictsByEvent: Map<string, Verdict[]>;
  /** Event ids that arrived live in this session, for enter animations. */
  fresh: Set<string>;
  /** Set while the Channel has Events older than `events` to page back to: the `seq` to page back from. */
  olderBefore?: number;
  loadingOlder: boolean;
}

type Listener = () => void;

/** Holds Channel state and applies stream messages. Views read it through hooks. */
export class ChannelStore {
  private allAgents: Agent[] = [];
  private state: ChannelState = {
    status: "loading",
    connection: "connecting",
    agents: [],
    historicalAgents: [],
    accounts: [],
    tasks: [],
    events: [],
    verdictsByEvent: new Map(),
    fresh: new Set(),
    loadingOlder: false,
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
    const tasks = upsert(this.state.tasks, task, (t) => t.number === task.number);
    this.set({ tasks, agents: visibleAgents(this.allAgents, tasks) });
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
        const { events, verdicts, agents, tasks, accounts = [], olderBefore, ...rest } = snap;
        this.allAgents = agents;
        const byEvent = new Map<string, Verdict[]>();
        for (const v of verdicts) byEvent.set(v.event, [...(byEvent.get(v.event) ?? []), v]);
        this.set({
          status: "ready",
          snapshot: rest,
          events,
          agents: visibleAgents(agents, tasks),
          historicalAgents: agents,
          accounts,
          tasks,
          verdictsByEvent: byEvent,
          olderBefore,
        });
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

  /** Loads the page of Events before the oldest one loaded, if the Channel has older ones. */
  async loadOlder(): Promise<void> {
    const before = this.state.olderBefore;
    if (before === undefined || this.state.loadingOlder) return;
    this.set({ loadingOlder: true });
    try {
      const page = await this.source.olderEvents(before);
      const s = this.state;
      const known = new Set(s.events.map((e) => e.id));
      // The page's Verdicts are older than the loaded ones: they go first, in their own order.
      const older = new Map<string, Verdict[]>();
      for (const v of page.verdicts) older.set(v.event, [...(older.get(v.event) ?? []), v]);
      const byEvent = new Map(s.verdictsByEvent);
      for (const [event, vs] of older) byEvent.set(event, [...vs, ...(byEvent.get(event) ?? [])]);
      this.set({
        events: [...page.events.filter((e) => !known.has(e.id)), ...s.events],
        verdictsByEvent: byEvent,
        olderBefore: page.olderBefore,
        loadingOlder: false,
      });
    } catch {
      // Scrolling up again tries again.
      this.set({ loadingOlder: false });
    }
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
        this.allAgents = upsert(this.allAgents, m.agent, (a) => a.id === m.agent.id);
        this.set({ agents: visibleAgents(this.allAgents, s.tasks), historicalAgents: this.allAgents });
        break;
      case "account":
        this.set({ accounts: upsert(s.accounts, m.account, (a) => a.email === m.account.email) });
        break;
      case "task":
        {
          const tasks = upsert(s.tasks, m.task, (t) => t.number === m.task.number);
          this.set({ tasks, agents: visibleAgents(this.allAgents, tasks) });
        }
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

function visibleAgents(agents: Agent[], tasks: Task[]): Agent[] {
  const holders = new Set(tasks.flatMap((task) => task.claim?.holder.kind === "agent" ? [task.claim.holder.agentId] : []));
  return agents.filter((agent) => agent.presence !== "gone" || holders.has(agent.id));
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
  const { historicalAgents, tasks } = useChannel();
  return useMemo(() => {
    const agentById = new Map<AgentId, Agent>(historicalAgents.map((a) => [a.id, a]));
    const taskByNumber = new Map<TaskNumber, Task>(tasks.map((t) => [t.number, t]));
    return { agentById, taskByNumber };
  }, [historicalAgents, tasks]);
}
