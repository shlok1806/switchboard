// A WebSocket to the Channel can go half-open: the machine sleeps or changes networks
// under it, and neither end sees it close. The wrapper keeps believing it is attached,
// and the Channel keeps sending its Agent's screen and transcript requests into it, so
// they time out for good (ADR 0048). Every open socket pings the Channel, which answers
// each ping with a pong; one that hears nothing back for a few pings is given up.

import type WebSocket from "ws";
import { LIVE_PING } from "../../shared/src/index";

/** How often an open socket pings the Channel. */
export const STREAM_PING_MS = 30_000;

/** Ping intervals without a word from the Channel, a pong or any frame, before the socket is given up. */
const SILENT_PINGS = 2.5;

/** How long a socket may hear nothing, opening included, before it is given up (ADR 0048, ADR 0052). */
export function silentAfterMs(everyMs: number): number {
  return everyMs * SILENT_PINGS;
}

/** The ping interval: SWITCHBOARD_STREAM_PING_SECONDS when set, so a test need not wait minutes. */
export function streamPingMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.SWITCHBOARD_STREAM_PING_SECONDS);
  return Number.isFinite(value) && value > 0 ? value * 1000 : STREAM_PING_MS;
}

export interface Keepalive {
  /** The Channel said something on the socket: a pong or any frame. */
  heard(): void;
  stop(): void;
}

/**
 * Pings `ws` every `everyMs` once it is open. When the Channel has said nothing for
 * SILENT_PINGS intervals, it stops and calls `silent` with how long it waited: the
 * caller drops the socket and opens a new one, since its close may never arrive.
 */
export function keepalive(ws: WebSocket, everyMs: number, silent: (ms: number) => void): Keepalive {
  let last = Date.now();
  const timer = setInterval(() => {
    const quiet = Date.now() - last;
    if (quiet > everyMs * SILENT_PINGS) {
      clearInterval(timer);
      silent(quiet);
      return;
    }
    try {
      ws.send(LIVE_PING);
    } catch {
      // Closing already: its close event reconnects.
    }
  }, everyMs);
  return {
    heard: () => {
      last = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}
