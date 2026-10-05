// The model an Agent runs on (ADR 0010): what a request says, which turns count,
// when a change is reported, the configured fallback, and the readable name.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelLabel } from "../../shared/src/index";
import { configuredModel, ModelWatch, type ReportedModel } from "../src/model-watch";
import { anthropicMessages } from "../src/proxy/anthropic";
import { openaiResponses } from "../src/proxy/openai-responses";

describe("what a request says about its model", () => {
  it("reads only the model, the effort and whether Claude Code's main thread sent it", () => {
    const request = {
      model: "claude-opus-5-5",
      output_config: { effort: "high" },
      tools: [{ name: "Agent" }],
      system: "secret system prompt",
      messages: [{ role: "user", content: "secret prompt" }],
    };
    expect(anthropicMessages.requested?.(request)).toEqual({ model: "claude-opus-5-5", effort: "high", main: true });
    expect(anthropicMessages.requested?.({ model: "claude-haiku-4-5", tools: [{ name: "Read" }] })).toEqual({
      model: "claude-haiku-4-5",
      main: false,
    });
    expect(openaiResponses.requested?.({ model: "gpt-5-codex", reasoning: { effort: "medium" }, input: "x" })).toEqual({
      model: "gpt-5-codex",
      effort: "medium",
    });
  });
});

describe("ModelWatch", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  function watch(): { watch: ModelWatch; reports: ReportedModel[] } {
    const reports: ReportedModel[] = [];
    const w = new ModelWatch(async (model) => {
      reports.push(model);
      return true;
    }, 20);
    return { watch: w, reports };
  }

  it("reports a model once it holds, and a burst of turns once", async () => {
    const { watch: w, reports } = watch();
    w.known("claude-haiku-4-5", undefined);
    w.seen({ model: "claude-opus-5-5" });
    w.seen({ model: "claude-sonnet-5-5" });
    w.seen({ model: "claude-opus-5-5" });
    await settle();
    w.seen({ model: "claude-opus-5-5" });
    await settle();
    expect(reports).toEqual([{ model: "claude-opus-5-5", effort: null }]);
  });

  it("does not count a subagent's turns once the main thread has been seen", async () => {
    const { watch: w, reports } = watch();
    w.seen({ model: "claude-opus-5-5", main: true });
    await settle();
    w.seen({ model: "claude-haiku-4-5", main: false });
    await settle();
    w.seen({ model: "claude-sonnet-5-5", effort: "low", main: true });
    await settle();
    expect(reports.map((r) => [r.model, r.effort])).toEqual([
      ["claude-opus-5-5", null],
      ["claude-sonnet-5-5", "low"],
    ]);
  });

  it("tries again when the Channel could not be told", async () => {
    let up = false;
    const reports: string[] = [];
    const w = new ModelWatch(async ({ model }) => {
      if (up) reports.push(model);
      return up;
    }, 10);
    w.seen({ model: "gpt-5-codex" });
    await settle();
    up = true;
    await w.flush();
    expect(reports).toEqual(["gpt-5-codex"]);
  });
});

describe("configuredModel", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "switchboard-model-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("takes --model first, then the CLI's own config, and names nothing it is not told", async () => {
    await writeFile(join(home, "settings.json"), JSON.stringify({ model: "claude-sonnet-5-5", env: { KEY: "x" } }));
    const claude = { CLAUDE_CONFIG_DIR: home };
    expect(await configuredModel("claude-code", ["--model", "opus"], claude, home)).toEqual({ model: "opus" });
    expect(await configuredModel("claude-code", [], claude, home)).toEqual({ model: "claude-sonnet-5-5" });
    expect(await configuredModel("claude-code", [], { CLAUDE_CONFIG_DIR: join(home, "none") }, home)).toEqual({});

    await writeFile(
      join(home, "config.toml"),
      'model = "gpt-5-codex"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "o3"\n',
    );
    expect(await configuredModel("codex", [], { CODEX_HOME: home }, home)).toEqual({
      model: "gpt-5-codex",
      effort: "high",
    });
    expect(await configuredModel("codex", ["-m", "gpt-5"], { CODEX_HOME: home }, home)).toMatchObject({
      model: "gpt-5",
    });

    await mkdir(join(home, ".gemini"));
    await writeFile(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({ model: { name: "gemini-3-pro-preview" } }),
    );
    expect(await configuredModel("gemini", [], { GEMINI_CLI_HOME: home }, home)).toEqual({
      model: "gemini-3-pro-preview",
    });
  });
});

describe("modelLabel", () => {
  it("names the models people run, and leaves an unknown ID as it is", () => {
    expect(
      [
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-fable-5-1",
        "claude-haiku-4-5-20251001",
        "gpt-5-codex",
        "gemini-3-pro-preview",
        "gemini-2.5-flash",
        "o3",
      ].map(modelLabel),
    ).toEqual([
      "Opus 5.5",
      "Sonnet 5.5",
      "Fable 5.1",
      "Haiku 4.5",
      "GPT-5 Codex",
      "Gemini 3 Pro",
      "Gemini 2.5 Flash",
      "o3",
    ]);
  });
});
