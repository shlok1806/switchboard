// The model an Agent runs on (ADR 0010). The source of truth is the model the agent
// CLI actually asks for: the Proxy Capture reads it from each model request, so it
// follows a Person switching models mid-session (/model) and whatever default the
// CLI picks. Before the first turn, or without the proxy, the wrapper falls back to
// the CLI's `--model` argument or its config default, and to nothing when neither
// names one: it never guesses. Only the model ID and the reasoning effort leave the
// laptop, never anything else from a request.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cli } from "../../shared/src/index";
import { claudeConfigDir } from "./claude-session";
import { codexHome } from "./clis/codex";

/** What one turn's request said about its model. */
export interface SeenModel {
  model?: string;
  effort?: string;
  /** Whether the turn came from the session's main thread, when the request can tell. */
  main?: boolean;
}

export interface ReportedModel {
  model: string;
  effort: string | null;
}

/** How long a model must stay the latest before it is reported, so a burst of turns reports once. */
export const MODEL_DEBOUNCE_MS = 2000;

/**
 * Follows the model of each turn and reports a change once it has held for
 * `debounceMs`. Once a turn is known to be the main thread's, turns known to be a
 * subagent's do not count: a subagent on another model is not a model switch.
 */
export class ModelWatch {
  private sawMain = false;
  private reported: ReportedModel | null = null;
  private candidate: ReportedModel | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Tells the Channel; resolves false when it could not, so the next turn tries again. */
    private readonly report: (model: ReportedModel) => Promise<boolean>,
    private readonly debounceMs = MODEL_DEBOUNCE_MS,
  ) {}

  /** What the Channel has now, so the same model is not reported again. */
  known(model: string | undefined, effort: string | undefined): void {
    this.reported = model === undefined ? null : { model, effort: effort ?? null };
  }

  seen(turn: SeenModel): void {
    if (turn.model === undefined) return;
    if (turn.main === true) this.sawMain = true;
    else if (turn.main === false && this.sawMain) return;
    const next = { model: turn.model, effort: turn.effort ?? null };
    clearTimeout(this.timer);
    this.candidate = next;
    if (same(next, this.reported)) return;
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  /** Reports the latest model now, if it is new. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const next = this.candidate;
    if (next === null || same(next, this.reported)) return;
    if (await this.report(next)) this.reported = next;
  }

  close(): void {
    clearTimeout(this.timer);
  }
}

function same(a: ReportedModel, b: ReportedModel | null): boolean {
  return b !== null && a.model === b.model && a.effort === b.effort;
}

/** The value of `--<long>`, `-<short>` or `--<long>=` in the agent CLI's arguments, the last one winning. */
function flag(args: readonly string[], long: string, short?: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    if (arg === `--${long}` || (short !== undefined && arg === `-${short}`)) value = args[++i];
    else if (arg.startsWith(`--${long}=`)) value = arg.slice(long.length + 3);
  }
  return value?.trim() || undefined;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A top-level `key = "value"` in a TOML file, before its first table. */
function tomlTop(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`).exec(line);
    if (match) return str(match[1]);
  }
  return undefined;
}

/**
 * The model the agent CLI will start on, as its arguments or its own config name it:
 * the fallback until the Proxy Capture sees a request (ADR 0010). Undefined when
 * neither names one; a CLI's built-in default is not guessed.
 */
export async function configuredModel(
  cli: Cli,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ model?: string; effort?: string }> {
  switch (cli) {
    case "claude-code": {
      const model =
        flag(args, "model") ??
        str(env.ANTHROPIC_MODEL) ??
        str((await readJson(join(cwd, ".claude", "settings.local.json"))).model) ??
        str((await readJson(join(cwd, ".claude", "settings.json"))).model) ??
        str((await readJson(join(claudeConfigDir(env), "settings.json"))).model);
      return model === undefined ? {} : { model };
    }
    case "codex": {
      const override = (key: string) =>
        args
          .flatMap((arg, i) => (args[i - 1] === "-c" || args[i - 1] === "--config" ? [arg] : []))
          .map((pair) => new RegExp(`^${key}\\s*=\\s*"?([^"]*)"?$`).exec(pair)?.[1])
          .filter((value): value is string => value !== undefined)
          .at(-1);
      let toml = "";
      try {
        toml = await readFile(join(codexHome(env), "config.toml"), "utf8");
      } catch {
        // No config: nothing named.
      }
      const model = flag(args, "model", "m") ?? str(override("model")) ?? tomlTop(toml, "model");
      const effort = str(override("model_reasoning_effort")) ?? tomlTop(toml, "model_reasoning_effort");
      return model === undefined ? {} : { model, ...(effort === undefined ? {} : { effort }) };
    }
    case "gemini": {
      const named = (settings: Record<string, unknown>) =>
        str(settings.model) ?? str((settings.model as { name?: unknown } | undefined)?.name);
      const model =
        flag(args, "model", "m") ??
        str(env.GEMINI_MODEL) ??
        named(await readJson(join(cwd, ".gemini", "settings.json"))) ??
        named(await readJson(join(env.GEMINI_CLI_HOME || homedir(), ".gemini", "settings.json")));
      return model === undefined ? {} : { model };
    }
  }
}
