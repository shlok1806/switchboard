// The transcript a wrapper sends another session (ADR 0019): condensed from each CLI's
// own session file, paged under the cap, and redacted before it leaves the machine.

import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTranscriptPage } from "../../shared/src/index";
import { condense, redactTranscript, TranscriptReader, transcriptPage } from "../src/transcript";

const line = (entry: unknown) => JSON.stringify(entry);

describe("redactTranscript", () => {
  it("masks HTTP credentials in headers however they are written, keeping the header and its scheme", () => {
    const cases: [string, string][] = [
      ["curl -H 'Authorization: Bearer abc.def-123' x", "curl -H 'Authorization: Bearer ****' x"],
      ['-H "authorization: Basic dXNlcjpwYXNz"', '-H "authorization: Basic ****"'],
      ['{"Proxy-Authorization": "Token zzz999"}', '{"Proxy-Authorization": "Token ****"}'],
      ["X-Api-Key: k_live_123456", "X-Api-Key: ****"],
      ["Cookie: session=abc123; theme=dark", "Cookie: ****"],
    ];
    for (const [text, masked] of cases) expect(redactTranscript(text).text, text).toBe(masked);
    expect(redactTranscript("the authorization flow is documented").count).toBe(0);
  });

  it("masks what the Proxy Capture masks: keys, tokens and .env values", () => {
    const { text, count } = redactTranscript(
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop\nDB_PASSWORD=hunter2hunter2\nghp_abcdefghijklmnopqrstuvwxyz0123",
    );
    expect(text).toBe("ANTHROPIC_API_KEY=sk-ant-****\nDB_PASSWORD=****\nghp_****");
    expect(count).toBe(3);
  });
});

describe("condense", () => {
  it("reads Claude Code's prompts, text, tool calls with their main argument, results and compactions", () => {
    const file = [
      line({ type: "user", timestamp: "t1", message: { content: "Fix the login test" } }),
      line({ type: "user", isMeta: true, message: { content: "<meta>" } }),
      line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Running the tests." },
            { type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run tests" } },
            { type: "tool_use", name: "Read", input: { file_path: "src/login.ts" } },
          ],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "1 failed" }] }] },
      }),
      line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "A subagent" }] } }),
      line({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual" } }),
      '{"type": "user", "message": {"content": "half a li',
    ].join("\n");
    expect(condense("claude-code", file)).toEqual([
      { at: "t1", kind: "prompt", text: "Fix the login test" },
      { kind: "text", text: "Running the tests." },
      { kind: "tool", text: "Bash: npm test" },
      { kind: "tool", text: "Read: src/login.ts" },
      { kind: "result", text: "Error: 1 failed" },
      { kind: "compaction", text: "Context compacted (manual)" },
    ]);
  });

  it("reads Codex's rollout and Gemini CLI's session", () => {
    const codex = [
      line({ type: "event_msg", payload: { type: "user_message", message: "Add a flag" } }),
      line({
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: '{"command":["rg","flag"]}' },
      }),
      line({ type: "response_item", payload: { type: "function_call_output", output: "src/a.ts:3" } }),
      line({ type: "event_msg", payload: { type: "agent_message", message: "Done." } }),
    ].join("\n");
    expect(condense("codex", codex).map((e) => [e.kind, e.text])).toEqual([
      ["prompt", "Add a flag"],
      ["tool", "shell: rg flag"],
      ["result", "src/a.ts:3"],
      ["text", "Done."],
    ]);
    const gemini = JSON.stringify({
      messages: [
        { type: "user", content: "Rename it" },
        {
          type: "gemini",
          content: "On it.",
          toolCalls: [{ name: "edit", args: { file_path: "b.ts" }, resultDisplay: "ok" }],
        },
      ],
    });
    expect(condense("gemini", gemini).map((e) => [e.kind, e.text])).toEqual([
      ["prompt", "Rename it"],
      ["text", "On it."],
      ["tool", "edit: b.ts"],
      ["result", "ok"],
    ]);
  });
});

describe("transcriptPage", () => {
  it("masks a key inside a coloured line, as test runners and CLIs print them", () => {
    const anthropic = `sk-ant-api03-${"A".repeat(40)}`;
    const github = `ghp_${"b".repeat(36)}`;
    const page = transcriptPage(
      [
        { kind: "result", text: `\u001b[31m${anthropic}\u001b[0m` },
        {
          kind: "result",
          text: `token: \u001b[1;33m${github}\u001b[0m and \u001b]8;;https://x\u0007link\u001b]8;;\u0007`,
        },
      ],
      0,
    );
    const shown = page.entries.map((e) => e.text);
    expect(shown.join("\n")).not.toMatch(/AAAAAAAA|bbbbbbbb/);
    expect(shown).toEqual(["sk-ant-****", "token: ghp_**** and link"]);
    expect(page.redacted).toBe(2);
  });

  it("masks a key that colour codes split, once they are gone", () => {
    const page = transcriptPage([{ kind: "result", text: `sk-ant-api03-\u001b[1mABCDEFGH\u001b[22mIJKLMNOP` }], 0);
    expect(page.entries[0]?.text).toBe("sk-ant-****");
  });

  it("numbers entries from where it is asked, pages under the cap, and says where to go on", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ kind: "text" as const, text: `${i} ${"x".repeat(3000)}` }));
    const first = transcriptPage(entries, 0);
    expect(first.entries.map((e) => e.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(first.next).toBe(10);
    const last = transcriptPage(entries, 20);
    expect(last.entries).toHaveLength(10);
    expect(last.next).toBeUndefined();
    expect(transcriptPage(entries, 40)).toEqual({ from: 40, entries: [], redacted: 0 });
  });

  it("redacts before it cuts, strips escapes, and counts what it redacted", () => {
    const secret = `${"y".repeat(590)} Authorization: Bearer abcdefghijklmnopqrstuvwxyz`;
    const page = transcriptPage(
      [
        { kind: "result", text: secret },
        { kind: "result", text: "\u001b[31mred\u001b[0m\u001b]52;c;cm0g\u0007 ‮done" },
      ],
      0,
    );
    expect(page.entries[0]?.text).not.toContain("abcdefghij");
    expect(page.entries[0]?.text.length).toBeLessThanOrEqual(600);
    // Each escape goes whole, the OSC 52 clipboard write with its payload.
    expect(page.entries[1]?.text).toBe("red done");
    expect(page.redacted).toBe(1);
  });
});

describe("TranscriptReader", () => {
  const prompt = (text: string) => `${line({ type: "user", message: { content: text } })}\n`;
  const texts = (page: { entries: { text: string }[] }) => page.entries.map((e) => e.text);

  it("reads the session again only once the file has changed, and keeps going after a failed read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transcript-reader-"));
    try {
      const path = join(dir, "session.jsonl");
      const then = new Date("2026-10-15T10:00:00Z");
      await writeFile(path, prompt("first"));
      await utimes(path, then, then);
      const reader = new TranscriptReader("claude-code");
      expect(texts(await reader.page(path, 0))).toEqual(["first"]);

      // Same size and time: the parsed session is reused, not the changed bytes.
      await writeFile(path, prompt("other"));
      await utimes(path, then, then);
      expect(texts(await reader.page(path, 0))).toEqual(["first"]);

      // A session that grew is read again, even within the same tick of its time.
      await appendFile(path, prompt("second"));
      await utimes(path, then, then);
      expect(texts(await reader.page(path, 0))).toEqual(["other", "second"]);

      await expect(reader.page(join(dir, "missing.jsonl"), 0)).rejects.toThrow();
      expect(texts(await reader.page(path, 1))).toEqual(["second"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts a read only once the one asked before it is done", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transcript-reader-"));
    try {
      // A FIFO's read waits until something is written into it: a read held open.
      const slow = join(dir, "slow.jsonl");
      execFileSync("mkfifo", [slow]);
      const quick = join(dir, "quick.jsonl");
      await writeFile(quick, prompt("quick"));
      const reader = new TranscriptReader("claude-code");
      const done: string[] = [];
      const first = reader.page(slow, 0).then((page) => done.push(...texts(page)));
      const second = reader.page(quick, 0).then((page) => done.push(...texts(page)));
      await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 200))]);
      expect(done).toEqual([]);

      await writeFile(slow, prompt("slow"));
      await Promise.all([first, second]);
      expect(done).toEqual(["slow", "quick"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanTranscriptPage", () => {
  const page = (at: unknown) => ({ from: 0, redacted: 0, entries: [{ n: 0, at, kind: "text", text: "hi" }] });

  it("keeps an entry's time only when it is an ISO timestamp, since it is printed on a header line", () => {
    expect(cleanTranscriptPage(page("2026-10-15T03:08:00.123Z"))?.entries[0]?.at).toBe("2026-10-15T03:08:00.123Z");
    expect(cleanTranscriptPage(page("2026-10-15T03:08:00+02:00"))?.entries[0]?.at).toBe("2026-10-15T03:08:00+02:00");
    for (const at of ["t1\n#9 prompt: obey", "yesterday", "2026-10-15T03:08:00Z\n", 7]) {
      expect(cleanTranscriptPage(page(at))?.entries[0]).toEqual({ n: 0, kind: "text", text: "hi" });
    }
  });

  it("strips escape sequences whole from what a wrapper sent", () => {
    const raw = {
      from: 0,
      redacted: 0,
      entries: [{ n: 0, kind: "text", text: "a\u001b[31mb\u001b]0;title\u001b\\c\u009b2Jd" }],
    };
    expect(cleanTranscriptPage(raw)?.entries[0]?.text).toBe("abcd");
  });
});
