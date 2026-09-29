// The wrapper's Proxy Capture flags, and where the agent CLI's model traffic
// really goes.
//
//   --proxy raw|digest|off  the starting Proxy mode; off launches without the proxy
//   --no-mask               turns secret masking off

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROXY_MODE, PROXY_MODES } from "../../../shared/src/index";
import type { ProxySetting } from "./capture";

export interface ProxyFlags {
  /** Only set when the Person gave `--proxy`. */
  proxy?: ProxySetting;
  mask: boolean;
  rest: string[];
}

const SETTINGS: readonly string[] = [...PROXY_MODES, "off"];

/** Takes `--proxy` and `--no-mask` out of the arguments meant for the agent CLI. Throws on a bad `--proxy`. */
export function takeProxyFlags(args: string[]): ProxyFlags {
  const rest: string[] = [];
  let proxy: string | undefined;
  let mask = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === "--proxy") {
      proxy = args[i + 1] ?? "";
      i++;
    } else if (arg.startsWith("--proxy=")) {
      proxy = arg.slice("--proxy=".length);
    } else if (arg === "--no-mask") {
      mask = false;
    } else {
      rest.push(arg);
    }
  }
  if (proxy !== undefined && !SETTINGS.includes(proxy)) {
    throw new Error(`--proxy must be one of ${SETTINGS.join(", ")}, not "${proxy}".`);
  }
  return proxy === undefined ? { mask, rest } : { proxy: proxy as ProxySetting, mask, rest };
}

/** The starting Proxy mode when `--proxy` was not given. */
export const DEFAULT_PROXY_SETTING: ProxySetting = DEFAULT_PROXY_MODE;

/**
 * Where the agent CLI would send its model traffic without Switchboard: its own
 * ANTHROPIC_BASE_URL from the environment, else from the Person's Claude Code
 * settings, else undefined (the Anthropic API).
 */
export async function originalBaseUrl(env: NodeJS.ProcessEnv, claudeConfigDir: string): Promise<string | undefined> {
  if (env.ANTHROPIC_BASE_URL) return env.ANTHROPIC_BASE_URL;
  try {
    const settings = JSON.parse(await readFile(join(claudeConfigDir, "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    const url = settings.env?.ANTHROPIC_BASE_URL;
    return typeof url === "string" && url !== "" ? url : undefined;
  } catch {
    return undefined;
  }
}
