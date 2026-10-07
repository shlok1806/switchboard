import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIdFor } from "../../shared/src/index";
import { AgentLink } from "../src/agent-link";
import { ChannelClient } from "../src/channel-client";
import { ContextParser, SessionContextReader } from "../src/session-context";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fixture = async (name: string) =>
  (await readFile(new URL(`./fixtures/context/${name}`, import.meta.url), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("main-session context", () => {
  it("uses the latest Claude request including caches, excludes sidechains, and counts automatic boundaries only", async () => {
    const p = new ContextParser("claude-code");
    for (const e of await fixture("claude.jsonl")) p.entry(e);
    expect(p.context).toMatchObject({
      tokens: 93385,
      window: 1_000_000,
      autoCompactions: 1,
      task: "Fix the login redirect",
      activity: "Tool: Read",
      model: "claude-sonnet-5-5",
    });
    expect(p.context.brief).toContain("DB_PASSWORD=****");
    expect(p.context.brief).not.toContain("private-value");
  });
  it("uses Codex's latest context rather than cumulative tokens and reads both account limits with resets", async () => {
    const p = new ContextParser("codex", {}, "Codex · work");
    for (const e of await fixture("codex.jsonl")) p.entry(e);
    expect(p.context).toMatchObject({
      tokens: 78173,
      window: 258400,
      task: "Add context to Agents",
      activity: "Tool: exec_command",
      model: "gpt-6.1",
    });
    expect(p.usage).toMatchObject({
      accountId: "Codex · work",
      plan: "plus",
      limits: {
        session: { percent: 5, resetsAt: new Date(1791424142 * 1000).toISOString() },
        week: { percent: 31, resetsAt: new Date(1791962569 * 1000).toISOString() },
      },
    });
    expect(p.context.autoCompactions).toBeUndefined();
  });
  it("retains partial appended lines, reads after completion, and keeps the first brief", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-test-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    const rows = await fixture("codex.jsonl");
    await writeFile(path, `${JSON.stringify(rows[0])}\n`);
    const reader = new SessionContextReader("codex", "id", dir, {});
    reader.follow(path);
    expect((await reader.read()).context.tokens).toBeUndefined();
    const last = JSON.stringify(rows.find((r) => r.payload?.type === "token_count"));
    await appendFile(path, last.slice(0, 50));
    expect((await reader.read()).context.tokens).toBeUndefined();
    await appendFile(path, `${last.slice(50)}\n`);
    expect((await reader.read()).context.tokens).toBe(78173);
    await appendFile(
      path,
      `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Second prompt" } })}\n`,
    );
    expect((await reader.read()).context.task).toBe("Second prompt");
  });
  it("does not invent a Gemini window, and masks message text before clipping", () => {
    const p = new ContextParser("gemini");
    p.entry({ type: "user", content: "Review\nDB_PASSWORD=private-value" });
    p.entry({ type: "gemini", model: "gemini-3-pro", content: "Done", tokens: { input: 15000 } });
    expect(p.context).toMatchObject({ tokens: 15000, task: "Review", activity: "Done" });
    expect(p.context.window).toBeUndefined();
    expect(p.context.brief).not.toContain("private-value");
  });
  it("reads fresh context on every heartbeat and serializes it with Codex limits", async () => {
    const bodies: Record<string, unknown>[] = [];
    const id = agentIdFor("ana", "codex", "session1234");
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ agent: { id, person: "ana", cli: "codex", presence: "live" } });
    });
    const client = new ChannelClient({ url: "https://example.test", repo: "ana/repo", credential: "test" });
    const link = new AgentLink(
      client,
      { cli: "codex", sessionId: "session1234", resumed: false, cwd: "/repo" },
      1000,
      () => {},
    );
    let tokens = 10;
    link.readContext = async () => ({
      context: { readAt: new Date().toISOString(), tokens: tokens++, window: 100 },
      usage: {
        accountId: "Codex · ana",
        limits: { readAt: new Date().toISOString(), session: { percent: 25 }, models: [] },
      },
    });
    await link.register();
    link.report("live");
    link.report("idle");
    await link.end(1000);
    expect(bodies.filter((b) => b.context).map((b) => (b.context as { tokens: number }).tokens)).toEqual([10, 11, 12]);
    expect(bodies.find((b) => b.context)?.usage).toMatchObject({
      accountId: "Codex · ana",
      limits: { session: { percent: 25 } },
    });
  });
});
