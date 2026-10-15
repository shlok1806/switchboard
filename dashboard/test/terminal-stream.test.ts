// @vitest-environment happy-dom
// Watching an Agent's terminal over the Dashboard's stream socket (ADR 0021): what the
// page asks the Channel for, where the Channel's terminal frames go, and that a
// reconnected socket watches again, since the Channel forgets a closed socket's watches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentId, StreamMessage } from "@shared/index";
import { HttpChannelSource } from "@/data/http";
import type { TerminalFrame } from "@/data/source";

/** The browser's WebSocket, as far as the stream uses it, recording what the page sends. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    if (data.startsWith("{")) this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop() {
    this.readyState = 3;
    this.onclose?.();
  }

  close() {
    this.readyState = 3;
  }
}

const AGENT = "maya/claude/2b8d" as AgentId;
const screen = (text: string): TerminalFrame => ({
  type: "terminal.screen",
  agent: AGENT,
  nonce: "n",
  cols: 10,
  rows: 1,
  lines: [text],
  cursor: { x: 0, y: 0 },
  attached: [],
  prompt: false,
});

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stream() {
  const source = new HttpChannelSource("http://channel.test/r/o/r", "o/r", "shlok");
  const messages: StreamMessage[] = [];
  const stop = source.subscribe(0, (m) => messages.push(m), () => {});
  return { source, messages, stop, socket: () => FakeSocket.all.at(-1) as FakeSocket };
}

describe("the terminal over the stream", () => {
  it("asks to watch, hands the Agent's frames to the panel and not to the feed, and stops", () => {
    const { source, messages, socket } = stream();
    socket().open();
    const frames: TerminalFrame[] = [];
    const link = source.terminal(AGENT, (f) => frames.push(f));
    expect(socket().sent).toEqual([{ type: "terminal.watch", agent: AGENT, on: true }]);

    socket().receive(screen("$ ls"));
    socket().receive({ ...screen("other"), agent: "bob/claude/0000" });
    expect(frames).toEqual([screen("$ ls")]);
    expect(messages).toEqual([]);

    expect(link.send({ agent: AGENT, key: "k", seq: 1, text: "y\r", sig: "s" })).toBe(true);
    link.close();
    expect(socket().sent.slice(1)).toEqual([
      { type: "terminal.input", agent: AGENT, key: "k", seq: 1, text: "y\r", sig: "s" },
      { type: "terminal.watch", agent: AGENT, on: false },
    ]);
  });

  it("watches again on a reconnected socket, and only until the last panel closes", () => {
    const { source, socket } = stream();
    // Opened before the socket is: nothing can be sent yet, the open sends it.
    const first = source.terminal(AGENT, () => {});
    const second = source.terminal(AGENT, () => {});
    socket().open();
    expect(socket().sent).toEqual([{ type: "terminal.watch", agent: AGENT, on: true }]);

    socket().drop();
    vi.advanceTimersByTime(10_000);
    socket().open();
    expect(FakeSocket.all).toHaveLength(2);
    expect(socket().sent).toEqual([{ type: "terminal.watch", agent: AGENT, on: true }]);

    first.close();
    expect(socket().sent).toHaveLength(1);
    second.close();
    expect(socket().sent.at(-1)).toEqual({ type: "terminal.watch", agent: AGENT, on: false });
  });

  it("says when input cannot go out because the socket is not open", () => {
    const { source } = stream();
    const link = source.terminal(AGENT, () => {});
    expect(link.send({ agent: AGENT, key: "k", seq: 1, text: "y", sig: "s" })).toBe(false);
  });
});
