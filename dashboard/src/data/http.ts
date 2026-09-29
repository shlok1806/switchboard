import type {
  ActionResult,
  ChannelEvent,
  ChannelSnapshot,
  ErrorResponse,
  HistoryResponse,
  JoinCredentials,
  JoinResponse,
  Person,
  PersonAction,
  StreamMessage,
  TaskListResponse,
} from "@shared/index";
import { LIVE_PING, MAX_HISTORY_LIMIT } from "@shared/index";
import type { ChannelSource, ConnectionState } from "./source";

/** Relay settings to show until the Worker exposes them. */
const DEFAULT_RELAY = { interruptThreshold: 0.6, model: "typesafe/jev" };

/** What each Person action needs from the Worker, so a missing route explains itself. */
const ACTION_NAME: Record<PersonAction["type"], string> = {
  update: "Updates",
  directive: "Directives",
  takeover: "Takeover",
  "proxy-mode": "changing Proxy mode",
  nickname: "Nicknames",
};

/**
 * The real Channel client, matching worker/src:
 * - every HTTP call sends `Authorization: Bearer <secret>` and `X-Switchboard-Person`;
 * - the WebSocket at `/api/stream` sends `?secret=`, `?person=` and `?after=`;
 * - the history is `GET /api/events`, Tasks are `GET /api/tasks`.
 * Routes the Worker does not have yet (`/api/snapshot`, Directives, Takeover,
 * Proxy mode, Nicknames) degrade: the snapshot is assembled from the routes that
 * exist, and the actions answer with a readable refusal.
 */
export class HttpChannelSource implements ChannelSource {
  readonly me: string;
  private readonly base: string;
  private readonly credentials: JoinCredentials;

  constructor(base: string, credentials: JoinCredentials) {
    this.base = base.replace(/\/$/, "");
    this.credentials = credentials;
    this.me = credentials.person;
  }

  private headers(): HeadersInit {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.credentials.secret}`,
      "x-switchboard-person": this.credentials.person,
    };
  }

  private async call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | ErrorResponse | null }> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers() });
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

  async snapshot(): Promise<ChannelSnapshot> {
    // A future Worker may serve the whole snapshot in one call.
    const direct = await this.call<ChannelSnapshot>("/api/snapshot");
    if (direct.status === 200 && direct.body && "events" in direct.body) return direct.body;
    if (direct.status === 401 || direct.status === 400) {
      throw new Error((direct.body as ErrorResponse | null)?.reason ?? "Could not sign in to the Channel.");
    }

    // Otherwise assemble it from the routes that exist today.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { status, body } = await this.call<JoinResponse>("/api/join", {
      method: "POST",
      body: JSON.stringify({ timeZone }),
    });
    if (status >= 400) throw new Error((body as ErrorResponse | null)?.reason ?? `Join failed: HTTP ${status}`);
    const me = (body as JoinResponse).person;

    const events = await this.allEvents();
    const tasks = await this.get<TaskListResponse>("/api/tasks")
      .then((r) => r.tasks)
      .catch(() => []);

    return {
      channel: { id: "main", repo: repoFromTasks(tasks) ?? "Channel", mainBranch: "main" },
      persons: personsFrom(events, me),
      // No Agents or Verdicts API yet: the views show their empty states.
      agents: [],
      verdicts: [],
      tasks,
      events,
      relay: DEFAULT_RELAY,
      cursor: events.at(-1)?.seq ?? 0,
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
      url.searchParams.set("person", this.credentials.person);
      url.searchParams.set("secret", this.credentials.secret);
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
        case "nickname":
          return { path: `/api/agents/${encodeURIComponent(action.agent)}/nickname`, body: { nickname: action.nickname } };
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

/** `owner/name` from an Issue URL such as https://github.com/owner/name/issues/12. */
function repoFromTasks(tasks: { url: string }[]): string | null {
  const m = tasks[0]?.url.match(/github\.com\/([^/]+\/[^/]+)\//);
  return m ? m[1] : null;
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
