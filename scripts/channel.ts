// A tiny terminal client for the Channel: join, watch live Events, type Updates.
//
//   npx tsx scripts/channel.ts --url https://switchboard.<account>.workers.dev --secret <join secret> --name shlok
//
// Needs Node 22 or newer (built-in fetch and WebSocket), and nothing else.

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { ChannelEvent, ErrorResponse, HistoryResponse, JoinResponse, StreamMessage } from "../shared/src/index";
import { LIVE_PING, LIVE_PONG } from "../shared/src/index";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.SWITCHBOARD_URL },
    secret: { type: "string", default: process.env.SWITCHBOARD_SECRET },
    name: { type: "string" },
    history: { type: "string", default: "20" },
  },
});

if (!values.url || !values.secret || !values.name) {
  console.error(
    "Usage: npx tsx scripts/channel.ts --url <channel url> --secret <join secret> --name <your name> [--history 20]\n" +
      "(--url and --secret can also come from SWITCHBOARD_URL and SWITCHBOARD_SECRET)",
  );
  process.exit(2);
}

const base = values.url.replace(/\/+$/, "");
const secret = values.secret;
const historyCount = Math.max(0, Number(values.history) || 0);
const colors = [31, 32, 33, 34, 35, 36];
let name = values.name;
let lastSeq = 0;

function colorFor(person: string): number {
  let hash = 0;
  for (const char of person) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length] ?? 36;
}

function actorName(event: ChannelEvent): string {
  switch (event.actor.kind) {
    case "person":
      return event.actor.person;
    case "agent":
      return event.actor.agentId;
    case "github":
      return "github";
  }
}

function format(event: ChannelEvent): string {
  const time = new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const who = `\x1b[1;${colorFor(actorName(event))}m${actorName(event)}\x1b[0m`;
  const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
  switch (event.type) {
    case "person.join":
      return `${dim(time)} ${who} ${dim("joined the Channel")}`;
    case "update":
      return `${dim(time)} ${who}: ${event.payload.text}`;
    default:
      return `${dim(time)} ${who} ${dim(event.type)}`;
  }
}

const prompt = createInterface({ input: process.stdin, output: process.stdout });

/** Prints a line above the prompt without clobbering what the Person is typing. */
function print(line: string): void {
  process.stdout.write("\r\x1b[2K");
  console.log(line);
  prompt.prompt(true);
}

function show(event: ChannelEvent): void {
  if (event.seq <= lastSeq) return;
  lastSeq = event.seq;
  print(format(event));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${secret}`);
  headers.set("X-Switchboard-Person", name);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await response.json().catch(() => ({ ok: false, reason: response.statusText }))) as T | ErrorResponse;
  if (!response.ok) throw new Error(`${response.status}: ${(body as ErrorResponse).reason}`);
  return body as T;
}

function connect(): void {
  const query = new URLSearchParams({ after: String(lastSeq), person: name, secret });
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/stream?${query}`);
  let keepalive: ReturnType<typeof setInterval> | undefined;
  socket.addEventListener("open", () => {
    keepalive = setInterval(() => socket.send(LIVE_PING), 30_000);
  });
  socket.addEventListener("message", (message) => {
    if (message.data === LIVE_PONG) return;
    const frame = JSON.parse(String(message.data)) as StreamMessage;
    if (frame.type === "event") show(frame.event);
  });
  socket.addEventListener("close", () => {
    clearInterval(keepalive);
    print("\x1b[2m(disconnected, reconnecting in 2s)\x1b[0m");
    setTimeout(connect, 2000);
  });
  socket.addEventListener("error", () => {
    // "close" follows and reconnects.
  });
}

/** Reads the whole history, a page at a time, so we can show just its tail. */
async function readHistory(): Promise<ChannelEvent[]> {
  const events: ChannelEvent[] = [];
  for (let cursor = 0; ; ) {
    const page = await request<HistoryResponse>(`/api/events?after=${cursor}`);
    events.push(...page.events);
    if (page.events.length === 0) return events;
    cursor = page.cursor;
  }
}

async function main(): Promise<void> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { person } = await request<JoinResponse>("/api/join", { method: "POST", body: JSON.stringify({ timeZone }) });
  name = person.name;
  prompt.setPrompt(`\x1b[1;${colorFor(name)}m${name}\x1b[0m> `);

  // Show the tail of the history, then follow live from there.
  const history = await readHistory();
  const tail = historyCount === 0 ? [] : history.slice(-historyCount);
  const first = tail[0];
  lastSeq = first ? first.seq - 1 : (history.at(-1)?.seq ?? 0);
  for (const event of tail) show(event);
  print(`\x1b[2m(you are ${name}. Type an Update and press Enter. Ctrl-C to leave.)\x1b[0m`);
  connect();

  prompt.on("line", async (line) => {
    const text = line.trim();
    if (text.length === 0) return prompt.prompt();
    // Clear the typed line; the Update comes back as a live Event.
    process.stdout.write("\x1b[1A\x1b[2K");
    try {
      await request("/api/updates", { method: "POST", body: JSON.stringify({ text }) });
    } catch (error) {
      print(`\x1b[31mCould not post: ${(error as Error).message}\x1b[0m`);
    }
  });
  prompt.on("close", () => process.exit(0));
}

main().catch((error: Error) => {
  console.error(`\x1b[31m${error.message}\x1b[0m`);
  process.exit(1);
});
