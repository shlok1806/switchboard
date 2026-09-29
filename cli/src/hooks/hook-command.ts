#!/usr/bin/env node
// The command every Switchboard hook runs inside the wrapped Claude Code session:
//
//   node switchboard-hook.js <wrapper socket>
//
// Claude Code writes the hook's input as JSON on stdin. This hands it, unchanged,
// to the running wrapper over its local socket and exits 0 straight away. It never
// touches the network, prints nothing (SessionStart output would reach the model)
// and never fails the hook: if the wrapper is gone, the event is dropped.
//
// It is its own small bundle with no dependencies, so it starts fast.

import { connect } from "node:net";

/** The most a hook waits for stdin and the local socket together. */
const GIVE_UP_MS = 2000;

function done(): never {
  process.exit(0);
}

setTimeout(done, GIVE_UP_MS).unref();

const socketPath = process.argv[2];
if (!socketPath) done();

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("error", done);
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  if (input.length === 0) done();
  const socket = connect(socketPath);
  socket.on("error", done);
  socket.on("close", done);
  socket.end(input);
});
