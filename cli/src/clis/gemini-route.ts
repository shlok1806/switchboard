// Where a Gemini CLI session's model traffic really goes, so the Proxy Capture can
// forward it there unchanged. Gemini CLI (checked against @google/gemini-cli
// 0.62.0's source; it was not installed to run) picks its route by auth type:
//
// - Login with Google (`oauth-personal`), Compute ADC or Cloud Shell: Code Assist
//   at CODE_ASSIST_ENDPOINT, else https://cloudcode-pa.googleapis.com.
// - A Gemini API key (`gemini-api-key`) or a gateway: the Gemini API at
//   GOOGLE_GEMINI_BASE_URL, else https://generativelanguage.googleapis.com.
// - Vertex AI: a regional endpoint the Google GenAI SDK works out; not read.
//
// Both overrides are environment variables, so the proxy takes their place for the
// session only. The auth type comes from the settings Gemini CLI merges (system
// over workspace over user), else from the environment as Gemini CLI reads it.
// Setting GOOGLE_GEMINI_BASE_URL would change the environment's answer (it means
// "gateway"), so when the auth type came from the environment, the session's own
// system settings name it, as Gemini CLI would have picked it anyway.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { geminiGenerateContent } from "../proxy/gemini";
import type { ProxyRoute, ProxyUnsupported, SessionContext } from "./adapter";

export const CODE_ASSIST_DEFAULT = "https://cloudcode-pa.googleapis.com";
export const GEMINI_API_DEFAULT = geminiGenerateContent.defaultUpstream;

export async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function selectedType(settings: Record<string, unknown>): string | undefined {
  const security = (settings.security ?? {}) as { auth?: { selectedType?: unknown } };
  const type = security.auth?.selectedType ?? settings.selectedAuthType;
  return typeof type === "string" && type !== "" ? type : undefined;
}

/** Gemini CLI's own reading of the environment, when no settings name an auth type. */
function authTypeFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GOOGLE_GENAI_USE_GCA === "true") return "oauth-personal";
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") return "vertex-ai";
  if (env.GOOGLE_GEMINI_BASE_URL) return "gateway";
  if (env.GEMINI_API_KEY) return "gemini-api-key";
  if (env.CLOUD_SHELL === "true" || env.GEMINI_CLI_USE_COMPUTE_ADC === "true") return "compute-default-credentials";
  return undefined;
}

export interface GeminiAuth {
  type: string | undefined;
  /** Whether the settings named it; else it came from the environment. */
  fromSettings: boolean;
}

/** The auth type this Gemini CLI session will use. `system` is the Person's own system settings. */
export async function geminiAuth({ cwd, env }: SessionContext, system: Record<string, unknown>): Promise<GeminiAuth> {
  const home = env.GEMINI_CLI_HOME || homedir();
  for (const settings of [
    system,
    await readJson(join(cwd, ".gemini", "settings.json")),
    await readJson(join(home, ".gemini", "settings.json")),
  ]) {
    const type = selectedType(settings);
    if (type) return { type, fromSettings: true };
  }
  return { type: authTypeFromEnv(env), fromSettings: false };
}

/** Where this Gemini CLI session's turns go, or why the Proxy Capture cannot read them. */
export function geminiProxyRoute(auth: GeminiAuth, env: NodeJS.ProcessEnv): ProxyRoute | ProxyUnsupported {
  switch (auth.type) {
    case "oauth-personal":
    case "compute-default-credentials":
    case "cloud-shell":
      return {
        api: geminiGenerateContent,
        upstream: env.CODE_ASSIST_ENDPOINT || CODE_ASSIST_DEFAULT,
        setting: "CODE_ASSIST_ENDPOINT",
      };
    case "gemini-api-key":
    case "gateway":
      return {
        api: geminiGenerateContent,
        upstream: env.GOOGLE_GEMINI_BASE_URL || GEMINI_API_DEFAULT,
        setting: "GOOGLE_GEMINI_BASE_URL",
      };
    case "vertex-ai":
      return { unsupported: "Gemini CLI uses Vertex AI, whose regional endpoint is not read" };
    case undefined:
      return { unsupported: "Gemini CLI has no auth type chosen yet" };
    default:
      return { unsupported: `Gemini CLI's auth type "${auth.type}" is not known` };
  }
}
