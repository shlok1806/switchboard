// The machine's local store of Local Events (ADR 0037): what it keeps, the pages it
// answers history reads with, and how long it keeps them.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AgentId, ChannelEvent } from "../../shared/src/index";
import { LOCAL_RETENTION_DAYS } from "../../shared/src/index";
import { LocalStore } from "../src/local-store";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12);
const SHLOK = "shlok/claude/7f3a" as AgentId;
const MAYA = "maya/claude/0b1c" as AgentId;

async function openStore(now = NOW): Promise<{ store: LocalStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "local-store-"));
  const path = join(dir, "events.db");
  const opened = LocalStore.open(path, now);
  if ("error" in opened) throw new Error(opened.error);
  onTestFinished(async () => {
    opened.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store: opened, path };
}

let made = 0;
function toolCall(agent: AgentId, seq: number, at = NOW - 60_000, task?: number): ChannelEvent {
  made += 1;
  return {
    id: `e${made}`,
    seq,
    at: new Date(at).toISOString(),
    type: "tool.call",
    actor: { kind: "agent", agentId: agent },
    capture: "hook",
    payload: { tool: "Read", arg: `f${made}.ts`, ok: true },
    ...(task === undefined ? {} : { task }),
  } as ChannelEvent;
}

function ruleDrop(about: ChannelEvent, seq: number): ChannelEvent {
  made += 1;
  return {
    id: `v${made}`,
    seq,
    at: about.at,
    type: "verdict",
    actor: { kind: "relay" },
    capture: "tool",
    payload: { event: about.id, source: "rule", verdict: "drop", local: true },
  } as unknown as ChannelEvent;
}

describe("the local store", () => {
  it("keeps only Local Events, and answers a page newest-last below the cursor", async () => {
    const { store } = await openStore();
    const events = [1, 2, 3, 4].map((seq) => toolCall(SHLOK, seq));
    const update = { ...toolCall(SHLOK, 5), type: "update", capture: "tool", payload: { text: "hi" } } as ChannelEvent;
    expect(store.put("o/app", [...events, update])).toBe(4);

    expect(store.page("o/app", { before: 4, limit: 2 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.has("o/app", update.id)).toBe(false);
    // Another Channel's store is separate.
    expect(store.page("o/other", { before: 100, limit: 10 })).toEqual([]);
  });

  it("files a rule Drop under the Agent whose Event it is about", async () => {
    const { store } = await openStore();
    const mine = toolCall(SHLOK, 1);
    const theirs = toolCall(MAYA, 2);
    store.put("o/app", [mine, theirs]);
    const drop = ruleDrop(mine, 3);
    store.put("o/app", [drop]);

    expect(store.page("o/app", { agent: SHLOK, before: 100, limit: 10 }).map((e) => e.id)).toEqual([mine.id, drop.id]);
    expect(store.page("o/app", { agent: MAYA, before: 100, limit: 10 }).map((e) => e.id)).toEqual([theirs.id]);
  });

  it("narrows a page to one Task", async () => {
    const { store } = await openStore();
    const onTask = toolCall(SHLOK, 1, NOW, 12);
    store.put("o/app", [onTask, toolCall(SHLOK, 2, NOW, 13), toolCall(SHLOK, 3)]);
    expect(store.page("o/app", { task: 12, before: 100, limit: 10 }).map((e) => e.id)).toEqual([onTask.id]);
  });

  it(`forgets what is older than ${LOCAL_RETENTION_DAYS} days when it is opened again`, async () => {
    const { store, path } = await openStore();
    const old = toolCall(SHLOK, 1, NOW - (LOCAL_RETENTION_DAYS + 1) * DAY);
    const recent = toolCall(SHLOK, 2, NOW - (LOCAL_RETENTION_DAYS - 1) * DAY);
    store.put("o/app", [old, recent]);
    store.close();

    const reopened = LocalStore.open(path, NOW);
    if ("error" in reopened) throw new Error(reopened.error);
    expect(reopened.page("o/app", { before: 100, limit: 10 }).map((e) => e.id)).toEqual([recent.id]);
    reopened.close();
  });
});
