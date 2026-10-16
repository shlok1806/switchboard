import type {
  CreateTaskRequest,
  ActionResult,
  Agent,
  AgentId,
  AgentRole,
  ChannelEvent,
  ChannelSnapshot,
  Holder,
  Host,
  HostsResponse,
  MemoryQuery,
  MemoryResponse,
  PersonAction,
  SpawnAgentRequest,
  StreamMessage,
  Task,
  Verdict,
  VerdictProbabilities,
} from "@shared/index";
import {
  DEFAULT_HOST_AGENTS_LIVE_CAP,
  DEFAULT_PERMISSION_MODE,
  agentIdFor,
  cleanNickname,
  holderName,
  hostIdFor,
  noteFromEvent,
  notUnderRootsReason,
  MAX_MEMORY_LIMIT,
  permissionModeWithin,
  sameNickname,
  underRoots,
} from "@shared/index";
import {
  ALL_CAPABILITIES,
  type ChannelSource,
  type ClaimResult,
  type ConnectionState,
  type EventPage,
  type SpawnResult,
  type TerminalFrame,
  type TerminalLink,
} from "../source";
import { accounts, ME, REPO, agent as agentActor, agents as seedAgents, makeEvent, person, persons, tasks as seedTasks, T0, withCounts } from "./fixtures";
import { RELAY, relay } from "./relay";
import { AMBIENT, HISTORY, LIVE, type Beat } from "./script";
import { mockTerminal } from "./terminal";

const clone = <T,>(v: T): T => structuredClone(v);

/**
 * A simulated Channel. It replays a scripted history, then plays live Events on a
 * timer and answers Person actions the way the Worker will, including refusals.
 */
/**
 * The states every view must draw (`?state=`), for the screenshot tests. Any of them also
 * stops the timed live Events, so two runs draw the same page (the clock is frozen in main.tsx).
 */
export type MockState = "ready" | "loading" | "empty" | "error" | "read-error";

const READ_FAILED = "The Channel's Worker answered 500 to this read.";

export class MockChannelSource implements ChannelSource {
  readonly me = ME;
  readonly capabilities = ALL_CAPABILITIES;
  readonly isMock = true;
  private agents: Agent[];
  /** The demo Person's one Host, as `switchboard host install` would register it. */
  private host: Host = {
    id: hostIdFor(ME, "studio"),
    person: ME,
    name: "studio",
    roots: ["/work/switchboard"],
    maxPermissionMode: "acceptEdits",
    live: true,
    registeredAt: new Date(T0 - 12 * 86_400_000).toISOString(),
    lastSeenAt: new Date(T0).toISOString(),
  };
  private tasks: Task[] = clone(seedTasks);
  private events: ChannelEvent[] = [];
  private verdicts: Verdict[] = [];
  private listeners = new Set<(m: StreamMessage) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  private started = false;

  constructor(
    private readonly opts: {
      latencyMs?: number;
      speed?: number;
      /** Pads the fleet to this many Agents (`?agents=200`). */
      fleet?: number;
      /**
       * A Channel in one of the states every view must draw (`?state=`): as usual but still
       * (ready), still loading (the snapshot never comes), empty (no Agents, Tasks, Events or
       * Hosts), unreachable, or reachable with every read of its Hosts, notes and Events by ID
       * failing (read-error).
       */
      state?: MockState;
    } = {},
  ) {
    if (opts.state === "empty") {
      this.agents = [];
      this.tasks = [];
      return;
    }
    this.agents = withFleet(clone(seedAgents), opts.fleet ?? 0);
    for (const b of HISTORY) this.apply(b, new Date(T0 + b.t * 60_000).toISOString(), false);
  }

  async snapshot(): Promise<ChannelSnapshot> {
    if (this.opts.state === "loading") await new Promise(() => {});
    await new Promise((r) => setTimeout(r, this.opts.latencyMs ?? 700));
    if (this.opts.state === "error") throw new Error("The Channel's Worker answered 503: it is restarting after a deploy.");
    return clone({
      channel: { id: "main", repo: REPO, mainBranch: "main" },
      persons,
      agents: this.agents,
      tasks: this.tasks,
      events: this.events,
      verdicts: this.verdicts,
      relay: RELAY,
      accounts,
      cursor: this.events.at(-1)?.seq ?? 0,
    });
  }

  /** The simulated Channel's snapshot holds its whole history. */
  async olderEvents(): Promise<Pick<ChannelSnapshot, "events" | "verdicts" | "olderBefore">> {
    return { events: [], verdicts: [] };
  }

  // The simulated Channel's whole history is in its snapshot.
  async scopedEvents(): Promise<EventPage> {
    return { events: [] };
  }

  async eventsById(): Promise<ChannelEvent[]> {
    if (this.opts.state === "read-error") throw new Error(READ_FAILED);
    return [];
  }

  async wakesAfter(): Promise<ChannelEvent[]> {
    return [];
  }

  subscribe(_cursor: number, onMessage: (m: StreamMessage) => void, onState: (s: ConnectionState) => void) {
    this.listeners.add(onMessage);
    onState("connecting");
    const ready = setTimeout(() => onState("live"), 250);
    if (!this.started && this.opts.state === undefined) {
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

  terminal(agent: AgentId, onFrame: (frame: TerminalFrame) => void): TerminalLink {
    return mockTerminal(agent, this.me, onFrame, () => this.agents.find((a) => a.id === agent)?.approval);
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
            // As the Hook Capture records them: a shell call is its command, any other tool a tool.call.
            build: (at) =>
              a.tool === "Bash"
                ? makeEvent("command", agentActor(a.agent as Agent["id"]), "hook", { command: a.arg }, { at, task: a.task })
                : makeEvent("tool.call", agentActor(a.agent as Agent["id"]), "hook", {
                    tool: a.tool,
                    arg: a.arg,
                    ok: true,
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
        const unknown = action.to?.filter((id) => !this.agents.some((a) => a.id === id)) ?? [];
        if (unknown.length > 0) return { ok: false, reason: `No Agent on this Channel is called ${unknown.join(", ")}.` };
        const payload = action.to ? { text, to: [...new Set(action.to)] } : { text };
        this.record(makeEvent("update", me, null, payload, { at, task: action.task }), undefined, true);
        return { ok: true };
      }
      case "directive": {
        const target = this.agents.find((a) => a.id === action.to);
        if (!target) return { ok: false, reason: `No Agent ${action.to} on this Channel.` };
        if (!action.text.trim()) return { ok: false, reason: "A Directive needs some text." };
        const directive = makeEvent("directive", me, null, { to: action.to, text: action.text.trim() }, { at });
        this.record(directive, undefined, true);
        // Like the Worker: typed right away when the Agent's wrapper can take it, else held for its next turn.
        const typed = target.canReceiveInterrupts && target.presence !== "gone";
        this.record(
          makeEvent(
            "directive.delivery",
            { kind: "agent", agentId: target.id },
            null,
            typed
              ? { directive: directive.id, from: this.me, delivered: "interrupt" }
              : {
                  directive: directive.id,
                  from: this.me,
                  delivered: "queue",
                  reason: target.presence === "gone" ? "wrapper-offline" : "cli-cannot-interrupt",
                },
            { at },
          ),
          undefined,
          true,
        );
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
      case "deny-approval": {
        // Like the Worker (ADR 0014): the Agent's own Person, a deniable prompt, once.
        const a = this.agents.find((x) => x.id === action.agent);
        if (!a) return { ok: false, reason: "Unknown Agent." };
        if (a.person !== this.me) return { ok: false, reason: `Agent ${a.id} belongs to ${a.person}.` };
        if (a.approval?.id !== action.id) return { ok: false, reason: `Agent ${a.id} is not waiting on that prompt any more.` };
        if (!a.approval.deniable) return { ok: false, reason: "That prompt can be answered only at the Agent's terminal." };
        if (a.approval.deniedBy) return { ok: false, reason: `${a.approval.deniedBy} already denied that prompt.` };
        a.approval = { ...a.approval, deniedBy: this.me };
        this.emit({ type: "agent", agent: a });
        return { ok: true };
      }
      case "rename": {
        // Like the Worker (ADR 0009): anyone may rename any Agent; a running Agent's name is taken, a Gone one's is free.
        const a = this.agents.find((x) => x.id === action.agent);
        if (!a) return { ok: false, reason: "Unknown Agent." };
        const nickname = action.nickname === null ? null : cleanNickname(action.nickname);
        if (nickname === undefined) return { ok: false, reason: "A Nickname is at most 40 characters." };
        if ((a.nickname ?? null) === nickname) return { ok: true };
        const holders = nickname === null ? [] : this.agents.filter((x) => x.id !== a.id && x.nickname && sameNickname(x.nickname, nickname));
        const live = holders.find((x) => x.presence !== "gone");
        if (live) return { ok: false, reason: `The Nickname "${live.nickname}" is taken by Agent ${live.id} on this Channel. Pick another one.` };
        for (const gone of holders) {
          this.record(makeEvent("agent.rename", me, null, { agent: gone.id, from: gone.nickname }, { at }), undefined, true);
          delete gone.nickname;
          this.emit({ type: "agent", agent: gone });
        }
        this.record(
          makeEvent("agent.rename", me, null, { agent: a.id, ...(a.nickname ? { from: a.nickname } : {}), ...(nickname ? { to: nickname } : {}) }, { at }),
          undefined,
          true,
        );
        if (nickname === null) delete a.nickname;
        else a.nickname = nickname;
        this.emit({ type: "agent", agent: a });
        return { ok: true };
      }
    }
  }

  /**
   * Claim for the Person, or for one of their own Agents, refused the way the
   * Worker refuses it (worker/src/claims.ts).
   */
  async claim(number: number, forAgent?: AgentId): Promise<ClaimResult> {
    await new Promise((r) => setTimeout(r, 350));
    let holder: Holder = { kind: "person", person: this.me };
    if (forAgent !== undefined) {
      const agent = this.agents.find((a) => a.id === forAgent);
      if (!agent) return { ok: false, reason: `No Agent ${forAgent} on this Channel.` };
      if (agent.person !== this.me) {
        return { ok: false, reason: `Agent ${forAgent} belongs to ${agent.person}. You can claim for yourself or your own Agents.` };
      }
      holder = { kind: "agent", agentId: forAgent };
    }
    const task = this.tasks.find((t) => t.number === number);
    if (!task) return { ok: false, reason: `No Task #${number}.` };
    if (task.status === "done") return { ok: false, reason: `Task #${number} is done.` };
    const me = person(this.me);
    if (task.claim) {
      const h = task.claim.holder;
      if (h.kind === holder.kind && holderName(h) === holderName(holder)) return { ok: true, task: clone(task) };
      this.record(makeEvent("claim.refused", me, null, { heldBy: h }, { task: number }), undefined, true);
      const stale = task.claim.stale ? " Its Claim is Stale: only a Person can take it over." : "";
      return { ok: false, reason: `Task #${number} is held by ${holderName(h)}.${stale}`, heldBy: h };
    }
    if (task.blockedBy.length > 0) {
      return { ok: false, reason: `Task #${number} is blocked by ${task.blockedBy.map((n) => `#${n}`).join(", ")}.` };
    }
    const at = new Date().toISOString();
    task.status = "claimed";
    task.claim = { task: number, holder, claimedAt: at, stale: false };
    task.updatedAt = at;
    this.record(makeEvent("claim", me, null, { holder }, { at, task: number }), undefined, true);
    this.emit({ type: "task", task });
    return { ok: true, task: clone(task) };
  }

  /** Release, only by the holder or the holding Agent's Person. */
  async release(number: number): Promise<ClaimResult> {
    await new Promise((r) => setTimeout(r, 350));
    const task = this.tasks.find((t) => t.number === number);
    if (!task) return { ok: false, reason: `No Task #${number}.` };
    if (task.status === "done") return { ok: false, reason: `Task #${number} is done.` };
    if (!task.claim) return { ok: false, reason: `Task #${number} is not claimed.` };
    const h = task.claim.holder;
    const mine =
      h.kind === "person" ? h.person === this.me : this.agents.find((a) => a.id === h.agentId)?.person === this.me;
    if (!mine) {
      const name = h.kind === "agent" ? h.agentId : h.person;
      return { ok: false, reason: `Task #${number} is held by ${name}. Only its holder can release it.`, heldBy: h };
    }
    const at = new Date().toISOString();
    delete task.claim;
    task.status = "open";
    task.updatedAt = at;
    this.record(makeEvent("claim.release", person(this.me), null, { holder: h }, { at, task: number }), undefined, true);
    this.emit({ type: "task", task });
    return { ok: true, task: clone(task) };
  }

  async hosts(): Promise<HostsResponse> {
    await new Promise((r) => setTimeout(r, 120));
    if (this.opts.state === "read-error") throw new Error(READ_FAILED);
    const running = this.agents.filter((a) => a.host !== undefined && a.presence !== "gone").length;
    // The other Persons' Hosts the demo Agents run on (a Person starts Agents only on their
    // own), and a laptop of shlok's that has been Offline for two days.
    if (this.opts.state === "empty") return { hosts: [], cap: DEFAULT_HOST_AGENTS_LIVE_CAP, running: 0 };
    const host = (id: `${string}/${string}`, roots: string[], extra: Partial<Host> = {}): Host => ({ ...this.host, id, person: id.split("/")[0]!, name: id.split("/")[1]!, roots, ...extra });
    const twoDays = new Date(T0 - 2 * 86_400_000).toISOString();
    const others = [
      host("shlok/laptop", ["/Users/shlok/code"], { live: false, lastSeenAt: twoDays, registeredAt: new Date(T0 - 40 * 86_400_000).toISOString(), maxPermissionMode: "default" }),
      host("maya/maya-mbp", ["/Users/maya/src/app", "/Users/maya/src/design"], { maxPermissionMode: "default" }),
      host("dev/devbox", ["/home/dev/app"], { maxPermissionMode: "auto" }),
    ];
    return clone({ hosts: [this.host, ...others], cap: DEFAULT_HOST_AGENTS_LIVE_CAP, running });
  }

  /**
   * Like the Worker: newest first, or for a search, notes holding every word of `q` as a whole
   * word, best match first (more of the words in a shorter note), as its full-text rank does.
   */
  async memory(query: MemoryQuery): Promise<MemoryResponse> {
    await new Promise((r) => setTimeout(r, 120));
    if (this.opts.state === "read-error") throw new Error(READ_FAILED);
    const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    const words = query.q === undefined ? [] : tokens(query.q);
    const limit = Math.min(query.limit ?? 20, MAX_MEMORY_LIMIT);
    const notes = this.events
      .map(noteFromEvent)
      .filter((n) => n !== null)
      .filter((n) => (query.tag ? n.tags.includes(query.tag) : true))
      .filter((n) => (query.task !== undefined ? n.task === query.task : true))
      .filter((n) => (query.author ? n.author === query.author : true))
      .filter((n) => (query.before !== undefined ? n.seq < query.before : true))
      .map((n) => {
        const have = tokens(`${n.text} ${(n.files ?? []).join(" ")}`);
        const hits = words.map((w) => have.filter((t) => t === w).length);
        return { n, hit: hits.every((h) => h > 0), score: hits.reduce((x, y) => x + y, 0) / Math.sqrt(have.length) };
      })
      .filter((m) => m.hit)
      .sort((a, b) => (words.length > 0 ? b.score - a.score : 0) || b.n.seq - a.n.seq)
      .map((m) => m.n);
    return clone({ notes: notes.slice(0, limit), ...(notes.length > limit ? { more: true as const } : {}) });
  }

  /** Like the Worker and the Host: checked, then an Agent that registers a moment later. */
  async spawnAgent(request: SpawnAgentRequest): Promise<SpawnResult> {
    await new Promise((r) => setTimeout(r, 900));
    const host = this.host;
    if (request.host !== undefined && request.host !== host.name) {
      return { ok: false, reason: `You have no Host named ${request.host}. Run \`switchboard host install\` on it.` };
    }
    if (!underRoots(request.cwd, host.roots)) {
      return { ok: false, reason: notUnderRootsReason(request.cwd, host.name, host.roots) };
    }
    const mode = request.permissionMode ?? DEFAULT_PERMISSION_MODE;
    if (!permissionModeWithin(mode, host.maxPermissionMode)) {
      return { ok: false, reason: `${host.name} starts Agents in at most the "${host.maxPermissionMode}" permission mode.` };
    }
    if (request.from && !this.agents.some((a) => a.id === request.from)) {
      return { ok: false, reason: `No Agent ${request.from} on this Channel to continue.` };
    }
    const at = new Date().toISOString();
    const me = person(this.me);
    const spawn = makeEvent(
      "agent.spawn",
      me,
      null,
      {
        host: host.id,
        cli: request.cli,
        cwd: request.cwd,
        permissionMode: mode,
        ...(request.nickname ? { nickname: request.nickname } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.brief ? { brief: request.brief } : {}),
        ...(request.from ? { from: request.from } : {}),
      },
      { at },
    );
    this.record(spawn, undefined, true);
    const sessionId = crypto.randomUUID();
    const agent: Agent = {
      id: agentIdFor(this.me, request.cli, sessionId),
      person: this.me,
      cli: request.cli,
      presence: "live",
      startedAt: at,
      lastSeenAt: at,
      proxyMode: "digest",
      secretMasking: true,
      canReceiveInterrupts: true,
      host: host.id,
      ...(request.nickname ? { nickname: request.nickname } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.from ? { continues: request.from } : {}),
      // What its session reports once it starts: the brief's first line is its task.
      context: {
        readAt: at,
        cwd: request.cwd,
        ...(request.brief ? { task: request.brief.split("\n")[0], brief: request.brief } : {}),
      },
    };
    this.agents.push(agent);
    this.emit({ type: "agent", agent: clone(agent) });
    this.record(
      makeEvent("agent.spawned", agentActor(agent.id), null, { spawn: spawn.id, host: host.id, agent: agent.id }, { at }),
      undefined,
      true,
    );
    // Its wrapper started with `--from`: the Channel records the Hand-off as it registers (ADR 0024).
    if (request.from) this.record(makeEvent("agent.handoff", agentActor(agent.id), null, { from: request.from }, { at }), undefined, true);
    return { ok: true, answer: { ok: true, spawn: spawn.id, host: host.id, agent: clone(agent) } };
  }

  async stopAgent(id: AgentId): Promise<ActionResult> {
    await new Promise((r) => setTimeout(r, 400));
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return { ok: false, reason: `No Agent ${id} on this Channel.` };
    if (agent.person !== this.me) return { ok: false, reason: `${id} is ${agent.person}'s Agent. Only its own Person may stop it.` };
    if (agent.host === undefined) return { ok: false, reason: `${id} runs in a terminal, not on a Host. Stop it there.` };
    if (agent.presence === "gone") return { ok: false, reason: `${id} is Gone already.` };
    const at = new Date().toISOString();
    this.record(makeEvent("agent.stop", person(this.me), null, { agent: id, host: agent.host }, { at }), undefined, true);
    // Like a real Host: the session takes a moment to end, then the Agent goes Gone.
    setTimeout(() => {
      agent.presence = "gone";
      agent.lastSeenAt = new Date().toISOString();
      this.emit({ type: "agent", agent: clone(agent) });
    }, 1500);
    return { ok: true };
  }

  async setRole(id: AgentId, role: AgentRole | null): Promise<ActionResult> {
    await new Promise((r) => setTimeout(r, 300));
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return { ok: false, reason: `No Agent ${id} on this Channel.` };
    if (agent.person !== this.me) {
      return { ok: false, reason: `${id} is ${agent.person}'s Agent. Only its own Person grants or revokes its role.` };
    }
    const had = agent.role ?? null;
    if (had === role) return { ok: true };
    const at = new Date().toISOString();
    if (had !== null) this.record(makeEvent("agent.role.revoked", person(this.me), null, { agent: id, role: had }, { at }), undefined, true);
    if (role !== null) this.record(makeEvent("agent.role.granted", person(this.me), null, { agent: id, role }, { at }), undefined, true);
    if (role === null) delete agent.role;
    else agent.role = role;
    this.emit({ type: "agent", agent: clone(agent) });
    return { ok: true };
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

// Words for the extra Agents' Nicknames, so a long fleet reads like one.
const FLEET_WORDS = ["atlas", "birch", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lumen", "meadow", "nimbus", "onyx", "pebble", "quartz", "raven", "sable", "tundra"];

/**
 * The seed Agents and generated ones up to `size`, spread over the three People, mostly Live,
 * some Idle and a few Gone. The same every time, so screenshots and timings compare.
 */
function withFleet(seed: Agent[], size: number): Agent[] {
  const out = [...seed];
  const people = ["shlok", "maya", "dev"];
  const at = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString();
  for (let i = out.length; out.length < size; i++) {
    const person = people[i % people.length]!;
    const codex = i % 5 === 4;
    const presence: Agent["presence"] = i % 9 === 0 ? "gone" : i % 4 === 0 ? "idle" : "live";
    out.push({
      id: `${person}/${codex ? "codex" : "claude"}/${(0x2000 + i * 37).toString(16)}` as Agent["id"],
      person,
      cli: codex ? "codex" : "claude-code",
      nickname: `${FLEET_WORDS[i % FLEET_WORDS.length]}-${i}`,
      model: codex ? "gpt-5.3-codex" : "claude-opus-5-5",
      presence,
      proxyMode: "digest",
      secretMasking: true,
      canReceiveInterrupts: true,
      lastSeenAt: at(i % 50),
      startedAt: at(30 + ((i * 7) % 600)),
      context: { readAt: at(i % 50), tokens: 40_000 + ((i * 7919) % 800_000), window: 1_000_000, activity: i % 3 === 0 ? "Running the tests" : "Reading the code" },
    } as Agent);
  }
  return out;
}
