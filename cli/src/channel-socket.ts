// The CLI's WebSockets to a Channel (ADR 0052): each one has a deadline to open and to
// close, after which its connection is destroyed, and closes with a code the Channel
// can answer. A close nobody answers otherwise keeps the connection open on both ends.

import WebSocket from "ws";

/** The close code every Switchboard socket closes with: a code-less close cannot be echoed (ADR 0052). */
export const NORMAL_CLOSE = 1000;

/** How long a closing socket waits for the Channel's close before it is destroyed. */
const CLOSE_DEADLINE_MS = 3_000;

/**
 * Opens a WebSocket that gives up, and is destroyed, when it has not opened within
 * `handshakeMs`: a Channel that takes the connection and never answers must not hold
 * the wrapper's socket forever.
 */
export function openSocket(url: string, handshakeMs: number): WebSocket {
  return new WebSocket(url, { handshakeTimeout: handshakeMs });
}

/**
 * Closes `ws` with a code the Channel can answer, and destroys its connection if the
 * Channel has not answered within a few seconds. A close nobody answers otherwise keeps
 * the connection open on both ends for as long as this process runs (ADR 0052).
 */
export function closeSocket(ws: WebSocket, reason = ""): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
    return;
  }
  try {
    ws.close(NORMAL_CLOSE, reason);
  } catch {
    ws.terminate();
    return;
  }
  const deadline = setTimeout(() => ws.terminate(), CLOSE_DEADLINE_MS);
  deadline.unref();
  ws.once("close", () => clearTimeout(deadline));
}

/** Destroys `ws`'s connection now: for a socket that has gone silent, whose close nobody would answer. */
export function dropSocket(ws: WebSocket): void {
  ws.terminate();
}

export { WebSocket };
