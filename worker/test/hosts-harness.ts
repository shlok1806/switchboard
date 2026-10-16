// The Host test harness (ADR 0015): the Channel API as a Host, its wrappers and the
// Dashboard call it, for hosts.test.ts and roles.test.ts.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, vi } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ChannelEvent,
  HistoryResponse,
  HostSpawnMessage,
  HostsResponse,
} from "../../shared/src/index";
import { bearer, forgetTokens, remember, streamQuery, url } from "./client";

export async function call(
  path: string,
  person: string,
  init: { method?: string; body?: unknown } = {},
  agent?: AgentId,
) {
  const response = await exports.default.fetch(
    new Request(url(path), {
      method: init.method ?? "GET",
      headers: {
        Authorization: await bearer({ person, ...(agent === undefined ? {} : { agent }) }),
        "Content-Type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  if (path === "/api/agents" && response.ok) remember(await response.clone().json<AgentResponse>());
  return response;
}

export const post = (path: string, person: string, body: unknown = {}, agent?: AgentId) =>
  call(path, person, { method: "POST", body }, agent);

export async function events(): Promise<ChannelEvent[]> {
  return (await (await call("/api/events", "dashboard")).json<HistoryResponse>()).events;
}

export async function hosts(): Promise<HostsResponse> {
  return (await call("/api/hosts", "dashboard")).json<HostsResponse>();
}

export async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const open: WebSocket[] = [];

/** A socket a test opened itself, closed with the harness's own after the test. */
export function closeAfterTest(socket: WebSocket): void {
  open.push(socket);
}

/** One Host: registered, and with its socket attached when `connect` is called. */
export class FakeHost {
  readonly frames: Array<{ type: string } & Record<string, unknown>> = [];
  private socket: WebSocket | null = null;

  constructor(
    readonly person: string,
    readonly name: string,
  ) {}

  get id(): string {
    return `${this.person}/${this.name}`;
  }

  static async registered(
    person: string,
    name: string,
    roots = ["/work"],
    maxPermissionMode?: string,
    options: { allow?: string[]; allowChannel?: boolean } = {},
  ) {
    const response = await post("/api/hosts", person, {
      name,
      roots,
      ...(maxPermissionMode === undefined ? {} : { maxPermissionMode }),
      ...options,
    });
    expect(response.status).toBe(200);
    return new FakeHost(person, name);
  }

  async connect(): Promise<void> {
    const query = await streamQuery(this.person, { host: this.name });
    const response = await exports.default.fetch(
      new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } }),
    );
    const socket = response.webSocket;
    if (!socket) throw new Error(`No WebSocket: ${response.status} ${await response.text()}`);
    socket.accept();
    socket.addEventListener("message", (message) => this.frames.push(JSON.parse(message.data as string)));
    this.socket = socket;
    open.push(socket);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  send(frame: unknown): void {
    this.socket?.send(JSON.stringify(frame));
  }

  spawns(): HostSpawnMessage[] {
    return this.frames.filter((f) => f.type === "host.spawn") as unknown as HostSpawnMessage[];
  }

  nextSpawn(): Promise<HostSpawnMessage> {
    const seen = this.spawns().length;
    return waitFor(() => this.spawns()[seen]);
  }
}

let sessions = 0;

/** What `switchboard run claude` does when a Host starts it: registers with the Host and the spawn. */
export async function wrapperRegisters(person: string, host?: string, spawn?: string): Promise<AgentResponse> {
  sessions += 1;
  const response = await post("/api/agents", person, {
    cli: "claude-code",
    sessionId: `${sessions.toString(16).padStart(4, "0")}eeee-0000-4000-8000-000000000000`,
    resumed: false,
    cwd: "/work/app",
    ...(host === undefined ? {} : { host }),
    ...(spawn === undefined ? {} : { spawn }),
  });
  expect(response.status).toBe(200);
  return response.json<AgentResponse>();
}

/**
 * Starts an Agent on `host` the way the Host does when the spawn reaches it: for the
 * Host's own Person, or for `by` when it is another Person the Host allows (name it `person/name`).
 */
export async function spawnAndStart(host: FakeHost, body: Record<string, unknown> = {}, by = host.person) {
  const spawning = post("/api/agents/spawn", by, {
    cli: "claude-code",
    cwd: "/work/app",
    ...(by === host.person ? {} : { host: host.id }),
    ...body,
  });
  const spawn = await host.nextSpawn();
  const registered = await wrapperRegisters(host.person, host.name, spawn.spawn);
  const response = await spawning;
  return { spawn, registered, response };
}

/** Closes every socket the harness opened, and resets the Channel. Run after each test. */
export async function cleanUp(): Promise<void> {
  vi.useRealTimers();
  forgetTokens();
  for (const socket of open.splice(0)) {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
  await reset();
}
