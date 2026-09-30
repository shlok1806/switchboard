// What `switchboard run <cli>` needs to know about one agent CLI. The wrapper
// (run.ts) does the same for every CLI: registers the Agent, keeps its Presence,
// runs the Hook Capture's socket, gives it Switchboard's MCP tools, delivers
// Queued Events at its next turn and types Interrupts and Directives into its pty.
// An adapter says how that CLI does each of those, or that it cannot.

import type { Cli } from "../../../shared/src/index";
import type { HookCapture } from "../hooks/capture";
import type { ClaudeHookInput } from "../hooks/summarize";
import type { SessionTools } from "../mcp-config";
import type { ApiFormat } from "../proxy/api";

/** Which session a launch will be. */
export type SessionPlan =
  /** The session ID is known before launch. */
  | { kind: "known"; args: string[]; sessionId: string; resumed: boolean }
  /**
   * The session ID is only known once the CLI has started (a new Codex session, a
   * picker): from the first hook that reports it, or from the adapter's `discover`.
   */
  | { kind: "discover"; args: string[]; resumed: boolean }
  /** Not a session at all (`--help`, `--version`): run the CLI as is. */
  | { kind: "none"; args: string[] };

export interface SessionContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface InstallOptions extends SessionContext {
  /** The CLI's arguments, from the plan. */
  args: string[];
  /** A private directory for the session's files, removed when it ends. */
  dir: string;
  hooks: HookCapture;
  tools: SessionTools;
  /** The local Proxy Capture's URL, when it runs. Only for CLIs with `proxy`. */
  proxyUrl?: string;
  /** The route the Proxy Capture took for this session, when it runs. */
  proxyRoute?: ProxyRoute;
}

/** Where a session's model traffic really goes, and the API it speaks. */
export interface ProxyRoute {
  api: ApiFormat;
  /** The upstream base URL the proxy forwards to (a path prefix is kept). */
  upstream: string;
  /** The CLI setting that points the session at the proxy, when the adapter needs to know. */
  setting?: string;
}

/** Why the Proxy Capture cannot read a session's model traffic. */
export interface ProxyUnsupported {
  unsupported: string;
}

export interface Installed {
  args: string[];
  /** Added to the CLI's environment. */
  env: Record<string, string>;
}

export interface CliAdapter {
  cli: Cli;
  /** The CLI's name for people, such as "Codex". */
  label: string;
  /** The program to run, unless `binEnv` names another. */
  command: string;
  /** The environment variable that overrides `command` (tests point it at a fake CLI). */
  binEnv: string;
  /**
   * Whether the wrapper types Interrupts and Directives into this CLI's session:
   * true only where typing into its prompt mid-turn was seen to work with the real
   * CLI. When false, the Relay delivers them as Queue, labelled downgraded.
   */
  interrupts: boolean;
  /** Whether the Proxy Capture can read this CLI's model traffic. */
  proxy: boolean;
  /**
   * Where this session's model traffic goes without Switchboard, and in which API
   * format; or why the Proxy Capture cannot read it (another model provider, say),
   * and the session runs without it. `args` are the Person's arguments for the CLI.
   * Only for CLIs with `proxy`.
   */
  proxyRoute?(ctx: SessionContext, args: string[]): Promise<ProxyRoute | ProxyUnsupported>;
  /** Whether a `discover` session's ID can be taken from the first hook's `session_id`. */
  sessionFromHooks: boolean;
  /** Works out the session from the Person's arguments. Throws when it cannot. */
  plan(args: string[], ctx: SessionContext): Promise<SessionPlan>;
  /**
   * Finds a `discover` session's ID without hooks, such as from the session files
   * the CLI writes. Resolves null when `signal` aborts. For a CLI with
   * `sessionFromHooks`, used only once its hooks are seen not to run.
   */
  discover?(ctx: SessionContext, since: number, signal: AbortSignal, resumed: boolean): Promise<string | null>;
  /** Turns this CLI's hook input into Claude Code's shape. Claude Code's needs none. */
  translateHook?(raw: Record<string, unknown>): ClaudeHookInput | ClaudeHookInput[];
  /** Wraps the text a hook prints back the way this CLI reads it. Plain text by default. */
  hookAnswer?(hook: string | undefined, text: string): string;
  /** Installs the session's hooks and MCP tools, for this session only. */
  install(options: InstallOptions): Promise<Installed>;
  /**
   * Set when the CLI runs session hooks only once the Person trusts them. The
   * wrapper prints it when no SessionStart hook arrives in time, and until one
   * does, it leaves next-turn notices for the `read_channel` tool instead.
   */
  untrustedHooksHint?: string;
}
