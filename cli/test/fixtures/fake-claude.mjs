#!/usr/bin/env node
// A stand-in for `claude` in the end-to-end test. It reads the session ID the way
// Claude Code does (`--session-id` or `--resume`), writes a session file where
// Claude Code would, reports what it got, then answers typed lines:
//   work  -> prints some output
//   quit  -> exits 0

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const sessionId = flagValue("--session-id") ?? flagValue("--resume");
if (!sessionId) {
  console.log("FAKE-CLAUDE no session id");
  process.exit(3);
}

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const project = join(claudeDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(project, { recursive: true });
appendFileSync(join(project, `${sessionId}.jsonl`), `${JSON.stringify({ at: Date.now() })}\n`);

console.log(`FAKE-CLAUDE args=${JSON.stringify(args)}`);
console.log(`FAKE-CLAUDE agent=${process.env.SWITCHBOARD_AGENT_ID ?? ""}`);
console.log(`FAKE-CLAUDE session=${sessionId}`);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = line.trim();
  if (command === "quit") {
    console.log("FAKE-CLAUDE bye");
    process.exit(0);
  }
  if (command === "work") console.log("FAKE-CLAUDE working on it");
});
