import { execFile } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentContext, Cli, ReportedUsage, UsageLimit } from "../../shared/src/index";
import { claudeConfigDir, projectDir } from "./claude-session";
import { maskSecrets } from "./proxy/mask";

const run = promisify(execFile);
const number = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
interface Part {
  text?: string;
  type?: string;
  name?: string;
}
interface TokenUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  context_window?: number;
  total_tokens?: number;
}
interface RateWindow {
  used_percent?: number;
  resets_at?: number;
}
interface Message {
  model?: string;
  usage?: TokenUsage;
  content?: string | Part[];
}
interface Entry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  cwd?: string;
  gitBranch?: string;
  subtype?: string;
  compactMetadata?: { trigger?: string };
  message?: Message;
  timestamp?: string;
  payload?: {
    type?: string;
    trigger?: string;
    cwd?: string;
    model?: string;
    message?: string;
    role?: string;
    content?: Part[];
    name?: string;
    info?: { last_token_usage?: TokenUsage; model_context_window?: number };
    rate_limits?: { limit_id?: string; plan_type?: string; primary?: RateWindow; secondary?: RateWindow };
  };
  model?: string;
  content?: string | Part[];
  contextWindow?: number;
  tokens?: { input?: number; contextWindow?: number };
  toolCalls?: { name?: string }[];
}
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p: Part) => p?.text ?? "")
          .filter(Boolean)
          .join("\n")
      : "";

/** Claude Code's documented default windows; unknown models remain unknown.
 * https://code.claude.com/docs/en/model-config#extended-context-with-1m
 */
export function claudeWindow(model: string, env: NodeJS.ProcessEnv): number | undefined {
  const override = number(Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS));
  if (override && override > 0 && (env.DISABLE_COMPACT === "1" || !model.startsWith("claude-"))) return override;
  if (env.CLAUDE_CODE_DISABLE_1M_CONTEXT === "1") return 200_000;
  if (model.includes("[1m]")) return 1_000_000;
  if (/claude-(opus|sonnet)-5|claude-(fable|mythos)-5|claude-haiku-5-5|claude-opus-4-[78]/.test(model))
    return 1_000_000;
  if (/claude-(opus|sonnet|haiku)-(3|4)/.test(model)) return 200_000;
  return undefined;
}

/** Consumes main-session entries only. Never sends tool arguments or tool results. */
export class ContextParser {
  readonly context: AgentContext = { readAt: new Date(0).toISOString() };
  usage?: ReportedUsage;
  private compactionsKnown = true;
  constructor(
    private cli: Cli,
    private env: NodeJS.ProcessEnv = {},
    private accountId?: string,
  ) {}

  private prompt(value: unknown): void {
    const brief = text(value);
    if (!brief || this.context.brief || brief.startsWith("<local-command") || brief.startsWith("<command-")) return;
    // Mask before clipping: clipping a secret can make it no longer recognisable.
    this.context.brief = maskSecrets(brief).text;
    this.context.task = this.context.brief
      .split("\n")
      .find((line) => line.trim())
      ?.slice(0, 160);
  }
  private activity(value: unknown): void {
    const line = text(value).trim().split("\n").filter(Boolean).at(-1);
    if (line) this.context.activity = maskSecrets(line).text.slice(0, 120);
  }
  entry(e: Entry): void {
    if (this.cli === "claude-code") {
      if (e.isSidechain) return;
      if (e.cwd) this.context.cwd = e.cwd;
      if (e.gitBranch) this.context.branch = e.gitBranch;
      if (e.type === "user" && !e.isMeta) this.prompt(e.message?.content);
      if (e.type === "system" && e.subtype === "compact_boundary" && e.compactMetadata?.trigger === "auto")
        this.context.autoCompactions = (this.context.autoCompactions ?? 0) + 1;
      if (e.type === "assistant") {
        const m = e.message;
        if (m?.model && !m.model.startsWith("<")) {
          this.context.model = m.model;
          this.context.window = number(m.usage?.context_window) ?? claudeWindow(m.model, this.env);
        }
        if (m?.usage)
          this.context.tokens =
            (number(m.usage.input_tokens) ?? 0) +
            (number(m.usage.cache_read_input_tokens) ?? 0) +
            (number(m.usage.cache_creation_input_tokens) ?? 0);
        for (const part of Array.isArray(m?.content) ? m.content : []) {
          if (part.type === "tool_use") this.context.activity = maskSecrets(`Tool: ${part.name}`).text.slice(0, 120);
          if (part.type === "text") this.activity(part.text);
        }
      }
      this.context.autoCompactions ??= 0;
    } else if (this.cli === "codex") {
      const p = e.payload ?? {};
      if (this.compactionsKnown) this.context.autoCompactions ??= 0;
      if (e.type === "compacted" || (e.type === "event_msg" && p.type === "context_compacted")) {
        if (p.trigger === "auto" && this.compactionsKnown)
          this.context.autoCompactions = (this.context.autoCompactions ?? 0) + 1;
        else if (p.trigger !== "manual") {
          this.compactionsKnown = false;
          delete this.context.autoCompactions;
        }
      }
      if (e.type === "session_meta" && p.cwd) this.context.cwd = p.cwd;
      if (e.type === "turn_context" && p.model) this.context.model = p.model;
      if (e.type === "event_msg") {
        if (p.type === "user_message") this.prompt(p.message);
        if (p.type === "agent_message") this.activity(p.message);
        if (p.type === "token_count") {
          if (p.info) {
            this.context.tokens = number(p.info.last_token_usage?.total_tokens);
            this.context.window = number(p.info.model_context_window);
          }
          const r = p.rate_limits;
          if (r && (!r.limit_id || r.limit_id === "codex")) {
            const limit = (l: RateWindow | undefined): UsageLimit | undefined =>
              typeof l?.used_percent === "number"
                ? {
                    percent: l.used_percent,
                    ...(number(l.resets_at) === undefined
                      ? {}
                      : { resetsAt: new Date((l.resets_at ?? 0) * 1000).toISOString() }),
                  }
                : undefined;
            this.usage = {
              accountId: this.accountId,
              plan: r.plan_type,
              limits: {
                readAt: e.timestamp ?? new Date().toISOString(),
                session: limit(r.primary),
                week: limit(r.secondary),
                models: [],
              },
            };
          }
        }
      }
      if (e.type === "response_item") {
        if (p.type === "message" && p.role === "user") {
          // Some rollouts have no user_message event. Initial injected instructions
          // and environment blocks are user-role items too, but are not the brief.
          this.prompt(
            p.content?.filter(
              (part) =>
                part.text &&
                !part.text.startsWith("# AGENTS.md instructions") &&
                !part.text.startsWith("<environment_context>"),
            ),
          );
        }
        if (p.type === "function_call" || p.type === "custom_tool_call")
          this.context.activity = maskSecrets(`Tool: ${p.name}`).text.slice(0, 120);
      }
      // Older logs record compaction without an auto/manual reason. Do not label those auto.
    } else {
      if (e.type === "user") this.prompt(e.content);
      if (e.type === "gemini") {
        if (e.model) this.context.model = e.model;
        const n = number(e.tokens?.input);
        if (n !== undefined) this.context.tokens = n;
        this.context.window = number(e.contextWindow ?? e.tokens?.contextWindow);
        this.activity(e.content);
        for (const t of e.toolCalls ?? []) this.context.activity = maskSecrets(`Tool: ${t.name}`).text.slice(0, 120);
      }
    }
  }
}

async function findSession(dir: string, id: string, depth = 0): Promise<string | undefined> {
  if (depth > 4) return undefined;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries)
    if (e.isFile() && e.name.includes(id) && /\.(jsonl|json)$/.test(e.name)) return join(dir, e.name);
  for (const e of entries)
    if (e.isDirectory()) {
      const found = await findSession(join(dir, e.name), id, depth + 1);
      if (found) return found;
    }
  // Gemini filenames carry only the short ID; validate the full session ID inside.
  if (depth > 0)
    for (const e of entries)
      if (e.isFile() && e.name.endsWith(".json")) {
        const path = join(dir, e.name);
        try {
          if (JSON.parse(await readFile(path, "utf8")).sessionId === id) return path;
        } catch {
          /* still being written */
        }
      }
  return undefined;
}

/** Reads only appended JSONL bytes, retaining partial lines until the next heartbeat. */
export class SessionContextReader {
  private path?: string;
  private offset = 0;
  private partial = "";
  private parser: ContextParser;
  constructor(
    private cli: Cli,
    private id: string,
    private cwd: string,
    private env: NodeJS.ProcessEnv,
    private accountId?: string,
  ) {
    this.parser = new ContextParser(cli, env, accountId);
  }
  follow(path: string): void {
    if (this.path !== path) {
      this.path = path;
      this.offset = 0;
      this.partial = "";
      this.parser = new ContextParser(this.cli, this.env, this.accountId);
    }
  }
  async read(): Promise<{ context: AgentContext; usage?: ReportedUsage }> {
    if (!this.path)
      this.path =
        this.cli === "claude-code"
          ? join(projectDir(claudeConfigDir(this.env), this.cwd), `${this.id}.jsonl`)
          : await findSession(
              this.cli === "codex"
                ? join(this.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
                : join(this.env.GEMINI_CLI_HOME || homedir(), ".gemini", "tmp"),
              this.id,
            );
    if (this.path) {
      if (this.cli === "gemini") {
        try {
          const data = JSON.parse(await readFile(this.path, "utf8"));
          this.parser = new ContextParser(this.cli, this.env, this.accountId);
          for (const m of data.messages ?? []) this.parser.entry(m);
        } catch {
          /* Missing or partially written session. */
        }
      } else {
        const handle = await open(this.path, "r").catch(() => undefined);
        if (handle)
          try {
            const { size } = await handle.stat();
            if (size < this.offset) {
              this.offset = 0;
              this.partial = "";
              this.parser = new ContextParser(this.cli, this.env, this.accountId);
            }
            if (size > this.offset) {
              const buffer = Buffer.alloc(size - this.offset);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
              this.offset += bytesRead;
              const lines = (this.partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
              this.partial = lines.pop() ?? "";
              for (const line of lines)
                try {
                  this.parser.entry(JSON.parse(line));
                } catch {
                  /* malformed entry */
                }
            }
          } finally {
            await handle.close();
          }
      }
    }
    const branch = await run("git", ["branch", "--show-current"], { cwd: this.cwd, timeout: 2000 })
      .then((r) => r.stdout.trim())
      .catch(() => undefined);
    return {
      context: {
        ...this.parser.context,
        cwd: this.cwd,
        ...(branch ? { branch } : {}),
        readAt: new Date().toISOString(),
      },
      ...(this.env.SWITCHBOARD_USAGE === "off" ? {} : { usage: this.parser.usage }),
    };
  }
}
