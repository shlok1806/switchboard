import type {
  CreateTaskRequest,
  ActionResult,
  Agent,
  ChannelEvent,
  ChannelSnapshot,
  PersonAction,
  StreamMessage,
  Task,
  Verdict,
  VerdictProbabilities,
} from "@shared/index";
import { ALL_CAPABILITIES, type ChannelSource, type ConnectionState } from "../source";
import { ME, REPO, agent as agentActor, agents as seedAgents, makeEvent, person, persons, tasks as seedTasks, T0, withCounts } from "./fixtures";
import { RELAY, relay } from "./relay";
import { AMBIENT, HISTORY, LIVE, type Beat } from "./script";

const clone = <T,>(v: T): T => structuredClone(v);

/**
 * A simulated Channel. It replays a scripted history, then plays live Events on a
 * timer and answers Person actions the way the Worker will, including refusals.
 */
export class MockChannelSource implements ChannelSource {
  readonly me = ME;
  readonly capabilities = ALL_CAPABILITIES;
  readonly isMock = true;
  private agents: Agent[] = clone(seedAgents);
  private tasks: Task[] = clone(seedTasks);
  private events: ChannelEvent[] = [];
  private verdicts: Verdict[] = [];
  private listeners = new Set<(m: StreamMessage) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;

  constructor(private readonly opts: { latencyMs?: number; speed?: number } = {}) {
    for (const b of HISTORY) this.apply(b, new Date(T0 + b.t * 60_000).toISOString(), false);
  }

  async snapshot(): Promise<ChannelSnapshot> {
    await new Promise((r) => setTimeout(r, this.opts.latencyMs ?? 700));
    return clone({
      channel: { id: "main", repo: REPO, mainBranch: "main" },
      persons,
      agents: this.agents,
      tasks: this.tasks,
      events: this.events,
      verdicts: this.verdicts,
      relay: RELAY,
      cursor: this.events.at(-1)?.seq ?? 0,
    });
  }

  subscribe(_cursor: number, onMessage: (m: StreamMessage) => void, onState: (s: ConnectionState) => void) {
    this.listeners.add(onMessage);
    onState("connecting");
    const ready = setTimeout(() => onState("live"), 250);
    if (!this.started) {
      this.started = true;
      this.play();
    }
    return () => {
      clearTimeout(ready);
      this.listeners.delete(onMessage);
      if (this.listeners.size === 0) {
        this.timers.forEach(clearTimeout);
        this.timers = [];
        this.started = false;
      }
    };
  }

  private emit(m: StreamMessage) {
    for (const l of this.listeners) l(clone(m));
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms / (this.opts.speed ?? 1)));
  }

  private play() {
    for (const b of LIVE) this.later(b.t * 1000, () => this.apply(b, new Date().toISOString(), true));
    const end = (LIVE.at(-1)?.t ?? 0) * 1000;
    let i = 0;
    const ambient = () => {
      const a = AMBIENT[i++ % AMBIENT.length];
      const live = this.agents.find((x) => x.id === a.agent)?.presence === "live";
      if (live) {
        this.apply(
          {
            t: 0,
            build: (at) =>
              makeEvent("tool.call", agentActor(a.agent as Agent["id"]), "hook", {
                tool: a.tool,
                arg: a.arg,
                ok: true,
                durationMs: 10 + Math.round(Math.random() * 400),
              }, { at, task: a.task }),
          },
          new Date().toISOString(),
          true,
        );
      }
      this.later(9000 + Math.random() * 7000, ambient);
    };
    this.later(end + 3000, ambient);
  }

  /** Record one Event, run the Relay, apply side effects, and broadcast. */
  private apply(b: Beat, at: string, broadcast: boolean, jev?: Record<string, VerdictProbabilities>) {
    const event = b.build(at);
    this.record(event, jev ?? b.jev, broadcast);
    const e = b.effect;
    if (e?.kind === "step") {
      const task = this.tasks.find((t) => t.number === e.task);
      const step = task?.steps.find((s) => s.index === e.step);
      if (task && step) {
        step.done = true;
        task.updatedAt = at;
        task.stepsDone = task.steps.filter((x) => x.done).length;
        if (broadcast) this.emit({ type: "task", task });
      }
    }
    return event;
  }

  private record(event: ChannelEvent, jev: Record<string, VerdictProbabilities> | undefined, broadcast: boolean) {
    this.events.push(event);
    if (event.actor.kind === "agent") {
      const id = event.actor.agentId;
      const a = this.agents.find((x) => x.id === id);
      if (a) {
        a.lastSeenAt = event.at;
        if (event.type === "presence") a.presence = event.payload.presence;
        if (broadcast) this.emit({ type: "agent", agent: a });
      }
    }
    const vs = relay(event, this.agents, this.tasks, jev);
    this.verdicts.push(...vs);
    if (broadcast) {
      this.emit({ type: "event", event });
      for (const v of vs) this.emit({ type: "verdict", verdict: v });
    }
  }

  async act(action: PersonAction): Promise<ActionResult> {
    await new Promise((r) => setTimeout(r, 180));
    const at = new Date().toISOString();
    const me = person(this.me);
    switch (action.type) {
      case "update": {
        const text = action.text.trim();
        if (!text) return { ok: false, reason: "An Update needs some text." };
        this.record(makeEvent("update", me, null, { text }, { at, task: action.task }), undefined, true);
        return { ok: true };
      }
      case "directive": {
        const target = this.agents.find((a) => a.id === action.to);
        if (!target) return { ok: false, reason: `No Agent ${action.to} on this Channel.` };
        if (!action.text.trim()) return { ok: false, reason: "A Directive needs some text." };
        this.record(makeEvent("directive", me, null, { to: action.to, text: action.text.trim() }, { at }), undefined, true);
        return { ok: true };
      }
      case "takeover": {
        const task = this.tasks.find((t) => t.number === action.task);
        if (!task?.claim) return { ok: false, reason: `Task #${action.task} has no Claim.` };
        if (!task.claim.stale) return { ok: false, reason: "Only a Stale Claim can be taken over." };
        const from = task.claim.holder;
        const lastUpdate = [...this.events]
          .reverse()
          .find((e) => e.type === "update" && e.task === task.number && e.actor.kind === "agent");
        const event = makeEvent("takeover", me, null, {
          from,
          to: action.to,
          stepsCompleted: task.steps.filter((s) => s.done).map((s) => s.text),
          lastUpdate: lastUpdate?.type === "update" ? lastUpdate.payload.text : undefined,
        }, { at, task: task.number });
        task.claim = { task: task.number, holder: action.to, claimedAt: at, stale: false };
        task.updatedAt = at;
        this.record(event, undefined, true);
        this.emit({ type: "task", task });
        return { ok: true };
      }
      case "proxy-mode": {
        const a = this.agents.find((x) => x.id === action.agent);
        if (!a) return { ok: false, reason: "Unknown Agent." };
        if (a.person !== this.me) return { ok: false, reason: `Only ${a.person} can change this Agent's Proxy mode.` };
        a.proxyMode = action.mode;
        this.emit({ type: "agent", agent: a });
        return { ok: true };
      }
      case "nickname": {
        const a = this.agents.find((x) => x.id === action.agent);
        if (!a) return { ok: false, reason: "Unknown Agent." };
        if (a.person !== this.me) return { ok: false, reason: `Only ${a.person} can name this Agent.` };
        a.nickname = action.nickname ?? undefined;
        this.emit({ type: "agent", agent: a });
        return { ok: true };
      }
    }
  }

  async createTask(request: CreateTaskRequest): Promise<{ ok: true; task: Task } | { ok: false; reason: string }> {
    await new Promise((r) => setTimeout(r, 300));
    const title = request.title.trim();
    if (!title) return { ok: false, reason: "A Task needs a title." };
    const number = Math.max(...this.tasks.map((t) => t.number)) + 1;
    const at = new Date().toISOString();
    const task = withCounts(
      {
        number,
        title,
        description: request.description ?? "",
        labels: request.labels ?? [],
        blockedBy: [],
        subtasks: [],
        steps: [],
        status: "open",
        updatedAt: at,
      },
      this.tasks,
    );
    this.tasks.push(task);
    this.emit({ type: "task", task });
    this.record(
      makeEvent("task.create", person(this.me), null, { title, url: task.url, via: "channel" }, { at, task: number }),
      undefined,
      true,
    );
    return { ok: true, task };
  }
}
