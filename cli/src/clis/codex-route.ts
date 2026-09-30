// Where a Codex session's model traffic really goes, so the Proxy Capture can
// forward it there unchanged. Codex's built-in `openai` provider sends turns to
// `<base>/responses`, where the base is `openai_base_url` when set, else the
// ChatGPT backend (`https://chatgpt.com/backend-api/codex`) when logged in with
// ChatGPT, else the OpenAI API (`https://api.openai.com/v1`). The proxy takes the
// session's place as `openai_base_url` (a `-c` override), so it must know which of
// those the session would have used. Any other model provider (`--oss`, a custom
// `model_provider`) is not read.
//
// Only three things are read: `openai_base_url`, `model_provider` and `profile`
// from config.toml (top level and the chosen profile), and `auth_mode` from
// auth.json. Nothing else in either file, and no credential, is read.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openaiResponses } from "../proxy/openai-responses";
import type { ProxyRoute, ProxyUnsupported } from "./adapter";

export const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const OPENAI_API_BASE = "https://api.openai.com/v1";

/** The Codex setting the proxy takes over for a session. */
export const CODEX_BASE_URL_KEY = "openai_base_url";

const KEYS = new Set(["openai_base_url", "model_provider", "profile"]);

/** A TOML basic or literal string value, or undefined for anything else. */
function tomlString(value: string): string | undefined {
  const text = value.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(text);
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`) as string;
    } catch {
      return undefined;
    }
  }
  return /^'([^']*)'\s*(#.*)?$/.exec(text)?.[1];
}

/**
 * The keys this module reads from a config.toml, by table: "" for the top level,
 * the profile's name for `[profiles.<name>]`. Dotted top-level forms
 * (`profiles.x.model_provider = ...`) are read too.
 */
export function readCodexConfig(toml: string): Map<string, Record<string, string>> {
  const tables = new Map<string, Record<string, string>>();
  const set = (table: string, key: string, value: string) => {
    tables.set(table, { ...tables.get(table), [key]: value });
  };
  let table: string | null = "";
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      const name = (header[1] ?? "").trim();
      const profile = /^profiles\.(?:"([^"]+)"|([\w-]+))$/.exec(name);
      table = profile ? (profile[1] ?? profile[2] ?? null) : null;
      continue;
    }
    if (table === null) continue;
    const pair = /^\s*([\w.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = (pair[1] ?? "").replace(/"/g, "");
    const value = tomlString(pair[2] ?? "");
    if (value === undefined) continue;
    const dotted = table === "" ? /^profiles\.([\w-]+)\.([\w-]+)$/.exec(key) : null;
    if (dotted && KEYS.has(dotted[2] ?? "")) set(dotted[1] ?? "", dotted[2] ?? "", value);
    else if (KEYS.has(key)) set(table, key, value);
  }
  return tables;
}

/** The Person's `-c key=value` overrides and `-p <profile>` for the keys this module reads. */
export function codexArgOverrides(args: string[]): { overrides: Record<string, string>; profile?: string } {
  const overrides: Record<string, string> = {};
  let profile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    let value: string | undefined;
    if (arg === "-c" || arg === "--config") value = args[++i];
    else if (arg.startsWith("--config=")) value = arg.slice("--config=".length);
    else if (arg === "-p" || arg === "--profile") profile = args[++i];
    else if (arg.startsWith("--profile=")) profile = arg.slice("--profile=".length);
    if (value === undefined) continue;
    const eq = value.indexOf("=");
    if (eq === -1) continue;
    const key = value.slice(0, eq).trim();
    if (!KEYS.has(key)) continue;
    const raw = value.slice(eq + 1);
    // `-c` values are TOML, or a plain string when they do not parse as TOML.
    overrides[key] = tomlString(raw) ?? raw.trim();
  }
  return profile === undefined ? { overrides } : { overrides, profile };
}

/** The Person's arguments without their `-c openai_base_url=...`, which the proxy takes the place of. */
export function withoutBaseUrlOverride(args: string[]): string[] {
  const out: string[] = [];
  const isBaseUrl = (value: string | undefined) => /^\s*openai_base_url\s*=/.test(value ?? "");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if ((arg === "-c" || arg === "--config") && isBaseUrl(args[i + 1])) {
      i++;
      continue;
    }
    if (arg.startsWith("--config=") && isBaseUrl(arg.slice("--config=".length))) continue;
    out.push(arg);
  }
  return out;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** How Codex is logged in, from auth.json's `auth_mode` only. */
async function authMode(home: string): Promise<string | undefined> {
  const text = await readText(join(home, "auth.json"));
  if (text === undefined) return undefined;
  try {
    const mode = (JSON.parse(text) as { auth_mode?: unknown }).auth_mode;
    return typeof mode === "string" ? mode : undefined;
  } catch {
    return undefined;
  }
}

/** Where this Codex session's turns go, or why the Proxy Capture cannot read them. */
export async function codexProxyRoute(home: string, args: string[]): Promise<ProxyRoute | ProxyUnsupported> {
  if (args.includes("--oss") || args.includes("--local-provider")) {
    return { unsupported: "Codex runs a local model (--oss)" };
  }
  const config = readCodexConfig((await readText(join(home, "config.toml"))) ?? "");
  const top = config.get("") ?? {};
  const { overrides, profile: profileArg } = codexArgOverrides(args);
  const profileName = profileArg ?? overrides.profile ?? top.profile;
  const profile = profileName === undefined ? {} : (config.get(profileName) ?? {});
  const pick = (key: string) => overrides[key] ?? profile[key] ?? top[key];

  const provider = pick("model_provider") ?? "openai";
  if (provider !== "openai") {
    return { unsupported: `Codex's model provider is "${provider}"; only the built-in openai provider is read` };
  }
  const route = (upstream: string): ProxyRoute => ({ api: openaiResponses, upstream, setting: CODEX_BASE_URL_KEY });
  const base = pick("openai_base_url");
  if (base) return route(base);
  const mode = await authMode(home);
  if (mode === "chatgpt" || mode === "chatgptAuthTokens") return route(CHATGPT_CODEX_BASE);
  if (mode === "apikey" || mode === "apiKey") return route(OPENAI_API_BASE);
  return {
    unsupported: "cannot tell from $CODEX_HOME/auth.json whether Codex is logged in with ChatGPT or an API key",
  };
}
