#!/usr/bin/env node
// The command every Switchboard hook runs inside the wrapped Claude Code session:
//
//   node switchboard-hook.js <wrapper socket>
//   node switchboard-hook.js            (the socket in $SWITCHBOARD_HOOK_SOCKET)
//   node switchboard-hook.js <wrapper socket> --hold
//
// Claude Code writes the hook's input as JSON on stdin. This hands it, unchanged,
// to the running wrapper over its local socket, prints the wrapper's answer and
// exits 0. The wrapper answers at once from what it already holds, so this never
// waits on the network. The answer is empty except for the hooks whose output
// Claude Code adds to the model's context (SessionStart, UserPromptSubmit), when
// the Agent has something to be told, such as a Claim it lost while it was away.
// It never fails the hook: if the wrapper is gone, the event is dropped.
//
// `--hold` is for Claude Code's PermissionRequest only (ADR 0014): the wrapper holds
// that answer until the prompt is denied from the Channel or closes, so the hook
// waits for it, up to HOLD_MS. Giving up prints nothing: no decision, and Claude
// Code's own dialog, which it shows meanwhile, stays in charge. A held hook keeps
// its side of the socket open, so the wrapper sees it end however it ends (it gave
// up, or Claude Code killed it): it ends its input with a NUL byte instead of
// closing, and once it has printed an answer it sends ACK, so the wrapper knows the
// answer reached Claude Code.
//
// It is its own small bundle with no dependencies, so it starts fast.

import { connect } from "node:net";

/** The most a hook waits for stdin and the local socket together. */
const GIVE_UP_MS = 2000;
/** The most a held hook waits: under the 600 s timeout its settings give it, so it ends first. */
const HOLD_MS = 590_000;

function done(): never {
  process.exit(0);
}

const args = process.argv.slice(2);
const hold = args.includes("--hold");
setTimeout(done, hold ? HOLD_MS : GIVE_UP_MS).unref();

const socketPath = args.find((arg) => arg !== "--hold") || process.env.SWITCHBOARD_HOOK_SOCKET;
if (!socketPath) done();

/** Ends a held hook's input; JSON text never holds a NUL byte. */
const END_OF_INPUT = "\0";
/** What a held hook sends once it has printed its answer. */
const ACK = "\x06";

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("error", done);
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  if (input.length === 0) done();
  const socket = connect({ path: socketPath, allowHalfOpen: true });
  const answer: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => answer.push(chunk));
  socket.on("error", done);
  // The wrapper sent its whole answer.
  socket.on("end", () => {
    const text = Buffer.concat(answer);
    if (text.length === 0) done();
    process.stdout.write(text, () => {
      if (hold) socket.end(ACK, done);
      else done();
    });
  });
  if (hold) socket.write(Buffer.concat([input, Buffer.from(END_OF_INPUT)]));
  else socket.end(input);
});
