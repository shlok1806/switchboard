import type {
  ActionResult,
  AgentId,
  AgentsResponse,
  ClaimRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  Task,
  ChannelEvent,
  ChannelSnapshot,
  ErrorResponse,
  HistoryResponse,
  JoinResponse,
  Person,
  PersonAction,
  RelayResponse,
  StreamMessage,
  TaskActionResponse,
  TaskListResponse,
  TaskNumber,
  ClaimRefusal,
  Verdict,
} from "@shared/index";
import { LIVE_PING, MAX_HISTORY_LIMIT, claimPath, nicknamePath, releasePath } from "@shared/index";
import type { Capabilities, ChannelSource, ClaimResult, ConnectionState } from "./source";

/**
 * What the Worker on main can do today: join, Events, Updates, the stream (#5),
 * Tasks (#8), Agents with Presence (#6), Hook Captures (#7), Claims (#9),
 * which the Tasks board claims and releases through, and the Relay's Verdicts
 * (#12), Takeover of a Stale Claim (#11), and Proxy Capture with each Agent's
 * Proxy mode (#15), which also makes Captures comparable, and Directives from a
 * Person to one Agent (#14).
 */
const LIVE_CAPABILITIES: Capabilities = {
  agents: true,
  verdicts: true,
  captures: true,
  claims: true,
  takeover: true,
  directives: true,
  proxyMode: true,
  createTask: true,
};

/** What each Person action needs from the Worker, so a missing route explains itself. */
const ACTION_NAME: Record<PersonAction["type"], string> = {
  update: "Updates",
  directive: "Directives",
  takeover: "Takeover",
  "proxy-mode": "changing Proxy mode",
  rename: "renaming Agents",
};

/**
 * The real Channel client, matching worker/src (ADR 0007):
 * - the Channel of a repo lives at `/r/<owner>/<repo>/api/...`; `base` is that prefix;
 * - every call carries the Person's session in the HttpOnly `sb_session` cookie, which
 *   the browser sends by itself, the WebSocket's included;
 * - the WebSocket at `/api/stream` sends `?after=`;
 * - the history is `GET /api/events`, Tasks `GET /api/tasks`, Agents `GET /api/agents`.
 * - the Relay's settings are `GET /api/relay`.
 * The Worker has no `/api/snapshot`, so the snapshot is assembled from the routes that
 * exist, and an action whose route is missing answers with a readable refusal.
 */
export class HttpChannelSource implements ChannelSource {
  /** The signed-in Person, their GitHub login, as the Channel answered `join` with. */
  readonly me: string;
  readonly capabilities = LIVE_CAPABILITIES;
  readonly isMock = false;
  private readonly base: string;

  constructor(
    base: string,
    /** The Channel's repo, `owner/name`. */
    private readonly repo: string,
    me: string,
  ) {
    this.base = base.replace(/\/$/, "");
    this.me = me;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | ErrorResponse | null }> {
    // `include` also carries the cookie when VITE_CHANNEL_URL points at another origin.
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    return { status: res.status, body: body as T | ErrorResponse | null };
  }

  private async get<T>(path: string): Promise<T> {
    const { status, body } = await this.call<T>(path);
    if (status >= 400) {
      const reason = body && typeof body === "object" && "reason" in body ? body.reason : `HTTP ${status}`;
      throw new Error(`${path}: ${reason}`);
    }
    return body as T;
  }

  /**
   * `POST /api/join` with the session cookie: joins (or rejoins) the Channel of `repo`.
   * `status` tells a missing session (401) from a Person without write access (403)
   * and a Worker without the GitHub App (503).
   */
  static async join(
    base: string,
    repo: string,
  ): Promise<{ ok: true; source: HttpChannelSource } | { ok: false; status: number; reason: string }> {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(`${base.replace(/\/$/, "")}/api/join`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone }),
      });
      const body = (await res.json().catch(() => null)) as JoinResponse | ErrorResponse | null;
      if (res.ok && body && "person" in body) return { ok: true, source: new HttpChannelSource(base, repo, body.person.name) };
      const reason = body && "reason" in body ? String(body.reason) : `HTTP ${res.status}`;
      return { ok: false, status: res.status, reason };
    } catch {
      return { ok: false, status: 0, reason: "The Channel could not be reached." };
    }
  }

  /** `POST /api/join`: joins (or rejoins) the Channel, answering with the Person. */
  async join(): Promise<{ ok: true; person: Person } | { ok: false; reason: string }> {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { status, body } = await this.call<JoinResponse>("/api/join", {
        method: "POST",
        body: JSON.stringify({ timeZone }),
      });
      if (status < 400 && body && "person" in body) return { ok: true, person: body.person };
      const reason = body && typeof body === "object" && "reason" in body ? String(body.reason) : `HTTP ${status}`;
      return { ok: false, reason };
    } catch {
      return { ok: false, reason: "The Channel could not be reached." };
    }
  }

  async snapshot(): Promise<ChannelSnapshot> {
    // The Worker has no /api/snapshot yet, so assemble it from the routes it has.
    const joined = await this.join();
    if (!joined.ok) throw new Error(joined.reason);
    const me = joined.person;

    // The Relay records each Verdict as an Event; views show Verdicts next to their Event.
    const all = await this.allEvents();
    const { events, verdicts } = splitVerdicts(all);
    // Tasks need GitHub; if it is unreachable the board is empty, not broken.
    const [tasks, agents, relay] = await Promise.all([
      this.get<TaskListResponse>("/api/tasks")
        .then((r) => r.tasks)
        .catch((): Task[] => []),
      this.get<AgentsResponse>("/api/agents")
        .then((r) => r.agents)
        .catch(() => []),
      this.get<RelayResponse>("/api/relay").then((r) => r.relay),
    ]);

    return {
      channel: { id: this.repo, repo: this.repo, mainBranch: "main" },
      persons: personsFrom(events, me),
      agents,
      verdicts,
      tasks,
      events,
      relay,
      cursor: all.at(-1)?.seq ?? 0,
    };
  }

  /** Page through `GET /api/events` from the start. */
  private async allEvents(): Promise<ChannelEvent[]> {
    const out: ChannelEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await this.get<HistoryResponse>(`/api/events?after=${after}&limit=${MAX_HISTORY_LIMIT}`);
      out.push(...page.events);
      if (page.events.length < MAX_HISTORY_LIMIT) return out;
      after = page.cursor;
    }
  }

  subscribe(
    cursor: number,
    onMessage: (message: StreamMessage) => void,
    onState: (state: ConnectionState) => void,
  ): () => void {
    let socket: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let last = cursor;
    let retry = 0;

    const open = () => {
      onState(retry === 0 ? "connecting" : "reconnecting");
      const url = new URL(`${this.base}/api/stream`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      // The Worker replays every Event after `after`, so a reconnect misses nothing.
      url.searchParams.set("after", String(last));
      socket = new WebSocket(url);
      socket.onopen = () => {
        retry = 0;
        onState("live");
        ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(LIVE_PING), 25_000);
      };
      socket.onmessage = (e) => {
        let message: StreamMessage;
        try {
          message = JSON.parse(String(e.data)) as StreamMessage;
        } catch {
          return; // the "pong" keepalive answer
        }
        if (message.type === "event") last = Math.max(last, message.event.seq);
        // A Verdict Event reaches the views as a Verdict, next to the Event it is about.
        if (message.type === "event" && message.event.type === "verdict") {
          onMessage({ type: "verdict", verdict: message.event.payload });
          return;
        }
        onMessage(message);
      };
      socket.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        retry += 1;
        onState("reconnecting");
        setTimeout(open, Math.min(10_000, 500 * 2 ** retry));
      };
    };

    open();
    return () => {
      closed = true;
      clearInterval(ping);
      socket?.close();
    };
  }

  async createTask(request: CreateTaskRequest): Promise<{ ok: true; task: Task } | { ok: false; reason: string }> {
    try {
      const { status, body } = await this.call<CreateTaskResponse>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(request),
      });
      if (status < 400 && body && "task" in body) return { ok: true, task: body.task };
      const reason = body && typeof body === "object" && "reason" in body ? String(body.reason) : `HTTP ${status}`;
      return { ok: false, reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "The Channel could not be reached." };
    }
  }

  claim(task: TaskNumber, forAgent?: AgentId): Promise<ClaimResult> {
    const body: ClaimRequest = forAgent === undefined ? {} : { for: forAgent };
    return this.claimAction(claimPath(task), body);
  }

  release(task: TaskNumber): Promise<ClaimResult> {
    return this.claimAction(releasePath(task));
  }

  /** Claim and release answer with the Task, or a refusal that names the holder in `heldBy`. */
  private async claimAction(path: string, request: ClaimRequest = {}): Promise<ClaimResult> {
    try {
      const { status, body } = await this.call<TaskActionResponse | ClaimRefusal>(path, {
        method: "POST",
        body: JSON.stringify(request),
      });
      if (status < 400 && body && "task" in body) return { ok: true, task: body.task };
      if (body && typeof body === "object" && "reason" in body) {
        const refusal = body as ClaimRefusal;
        return { ok: false, reason: String(refusal.reason), ...(refusal.heldBy ? { heldBy: refusal.heldBy } : {}) };
      }
      return { ok: false, reason: `HTTP ${status}` };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "The Channel could not be reached." };
    }
  }

  async act(action: PersonAction): Promise<ActionResult> {
    const route = (() => {
      switch (action.type) {
        case "update":
          return { path: "/api/updates", body: { text: action.text, task: action.task } };
        case "directive":
          return { path: "/api/directives", body: { to: action.to, text: action.text } };
        case "takeover":
          return { path: `/api/tasks/${action.task}/takeover`, body: { to: action.to } };
        case "proxy-mode":
          return { path: `/api/agents/${encodeURIComponent(action.agent)}/proxy-mode`, body: { mode: action.mode } };
        case "rename":
          return { path: nicknamePath(action.agent), body: { nickname: action.nickname } };
      }
    })();
    try {
      const { status, body } = await this.call<unknown>(route.path, { method: "POST", body: JSON.stringify(route.body) });
      if (status < 400) return { ok: true };
      if (status === 404) return { ok: false, reason: `This Channel does not support ${ACTION_NAME[action.type]} yet.` };
      const reason = body && typeof body === "object" && "reason" in body ? String(body.reason) : `HTTP ${status}`;
      return { ok: false, reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "The Channel could not be reached." };
    }
  }
}

/** Separates the Relay's Verdict Events from the rest, keeping order. */
function splitVerdicts(all: ChannelEvent[]): { events: ChannelEvent[]; verdicts: Verdict[] } {
  const events: ChannelEvent[] = [];
  const verdicts: Verdict[] = [];
  for (const e of all) {
    if (e.type === "verdict") verdicts.push(e.payload);
    else events.push(e);
  }
  return { events, verdicts };
}


/** Persons come from `person.join` Events until the Worker lists them. */
function personsFrom(events: ChannelEvent[], me: Person): Person[] {
  const byName = new Map<string, Person>();
  for (const e of events) {
    if (e.type === "person.join" && e.actor.kind === "person") {
      byName.set(e.actor.person, { name: e.actor.person, timeZone: e.payload.timeZone, joinedAt: e.at });
    }
  }
  byName.set(me.name, me);
  return [...byName.values()];
}
