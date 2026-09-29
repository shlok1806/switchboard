// Drives the public Channel API the way real clients do, against the real
// Worker and a real Channel Durable Object running in memory.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChannelEvent,
  ErrorResponse,
  HistoryResponse,
  JoinResponse,
  PostUpdateResponse,
  StreamMessage,
} from "../../shared/src/index";

const SECRET = "test-join-secret";
const BASE = "https://switchboard.test";

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

/** Summarizes an Event as [type, Person, Update text] for readable assertions. */
function brief(event: ChannelEvent): [string, string | null, string | null] {
  const person = event.actor.kind === "person" ? event.actor.person : null;
  return [event.type, person, event.type === "update" ? event.payload.text : null];
}

/** A fake client acting as one Person. */
class FakePerson {
  readonly received: StreamMessage[] = [];
  private socket: WebSocket | null = null;
  private wake: (() => void) | null = null;

  constructor(
    readonly name: string,
    private readonly secret = SECRET,
  ) {}

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.secret}`, "X-Switchboard-Person": this.name };
  }

  join(timeZone?: string): Promise<Response> {
    return call("/api/join", { method: "POST", headers: this.headers(), body: JSON.stringify({ timeZone }) });
  }

  /** Opens the live stream the way a browser does, with credentials in the query string. */
  async subscribe(after?: number): Promise<void> {
    const query = new URLSearchParams({ secret: this.secret, person: this.name });
    if (after !== undefined) query.set("after", String(after));
    const response = await call(`/api/stream?${query}`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("No WebSocket in the upgrade response");
    socket.addEventListener("message", (message) => {
      this.received.push(JSON.parse(message.data as string) as StreamMessage);
      this.wake?.();
    });
    socket.accept();
    this.socket = socket;
  }

  postUpdate(text: string): Promise<Response> {
    return call("/api/updates", { method: "POST", headers: this.headers(), body: JSON.stringify({ text }) });
  }

  async history(): Promise<ChannelEvent[]> {
    const response = await call("/api/events", { headers: this.headers() });
    expect(response.status).toBe(200);
    return (await response.json<HistoryResponse>()).events;
  }

  get events(): ChannelEvent[] {
    return this.received.flatMap((message) => (message.type === "event" ? [message.event] : []));
  }

  /** Waits until a live Event matching `predicate` has arrived. */
  async waitForEvent(predicate: (event: ChannelEvent) => boolean): Promise<ChannelEvent> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${this.name} timed out waiting for a live Event`);
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 50);
      });
    }
  }

  close(): void {
    this.socket?.close();
  }
}

const people: FakePerson[] = [];

function person(name: string, secret?: string): FakePerson {
  const fake = new FakePerson(name, secret);
  people.push(fake);
  return fake;
}

async function posted(response: Response): Promise<ChannelEvent> {
  expect(response.status).toBe(201);
  return (await response.json<PostUpdateResponse>()).event;
}

afterEach(async () => {
  for (const p of people.splice(0)) p.close();
  await reset();
});

describe("joining", () => {
  it("refuses a wrong join secret on every route", async () => {
    const mallory = person("mallory", "not-the-secret");

    const join = await mallory.join();
    expect(join.status).toBe(401);
    expect(await join.json<ErrorResponse>()).toEqual({ ok: false, reason: "Wrong join secret." });
    expect((await mallory.postUpdate("hi")).status).toBe(401);
    expect((await call("/api/events", { headers: { "X-Switchboard-Person": "mallory" } })).status).toBe(401);
    const stream = await call("/api/stream?person=mallory&secret=nope", { headers: { Upgrade: "websocket" } });
    expect(stream.status).toBe(401);

    // Nothing a refused client did reached the Channel.
    expect(await person("shlok").history()).toEqual([]);
  });

  it("joins a Person once, under the name they picked", async () => {
    const response = await person("  Shlok ").join("America/New_York");
    expect(response.status).toBe(200);
    expect((await response.json<JoinResponse>()).person).toMatchObject({ name: "shlok", timeZone: "America/New_York" });

    await person("shlok").join();
    const history = await person("shlok").history();
    expect(history.map(brief)).toEqual([["person.join", "shlok", null]]);
  });

  it("refuses a name that could not be part of an Agent ID", async () => {
    expect((await person("shlok/claude").join()).status).toBe(400);
  });
});

describe("live Events", () => {
  it("delivers a posted Update to every connected WebSocket as an Event naming its Person", async () => {
    const shlok = person("shlok");
    const alex = person("alex");
    await shlok.subscribe();
    await alex.subscribe();

    const update = await posted(await alex.postUpdate("  starting on the users page  "));

    for (const watcher of [shlok, alex]) {
      const event = await watcher.waitForEvent((e) => e.id === update.id);
      expect(event).toMatchObject({
        type: "update",
        actor: { kind: "person", person: "alex" },
        capture: null,
        payload: { text: "starting on the users page" },
      });
    }
  });

  it("refuses an empty Update", async () => {
    expect((await person("shlok").postUpdate("   ")).status).toBe(400);
  });
});

describe("history", () => {
  it("lets a late joiner read every earlier Event in order", async () => {
    const shlok = person("shlok");
    await shlok.join();
    await posted(await shlok.postUpdate("first"));
    await posted(await shlok.postUpdate("second"));

    const sam = person("sam");
    await sam.join();
    const history = await sam.history();

    expect(history.map(brief)).toEqual([
      ["person.join", "shlok", null],
      ["update", "shlok", "first"],
      ["update", "shlok", "second"],
      ["person.join", "sam", null],
    ]);
    expect(history.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("replays missed Events to a stream that resumes from a cursor, then continues live", async () => {
    const shlok = person("shlok");
    await posted(await shlok.postUpdate("while you were away"));

    const sam = person("sam");
    await sam.subscribe(0);
    const live = await posted(await shlok.postUpdate("welcome back"));
    await sam.waitForEvent((e) => e.id === live.id);

    expect(sam.events.map(brief)).toEqual([
      ["person.join", "shlok", null],
      ["update", "shlok", "while you were away"],
      ["person.join", "sam", null],
      ["update", "shlok", "welcome back"],
    ]);
  });
});
