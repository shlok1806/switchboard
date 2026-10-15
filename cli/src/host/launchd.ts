// The LaunchAgent that keeps `switchboard host run` going (ADR 0015): started at
// login, restarted when it dies, as a background process with no window or Dock icon.
// launchd gives a job an almost empty environment, so the plist records PATH and the
// config directory as they were when the Person installed it.
//
// $SWITCHBOARD_LAUNCH_AGENTS_DIR and $SWITCHBOARD_LAUNCHCTL let the tests install
// somewhere else and record the launchctl calls instead of loading anything.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const LAUNCH_AGENT_LABEL = "dev.switchboard.host";

export interface LaunchAgentSpec {
  /** The Node binary, then the CLI's entry script: `<node> <cli> host run`. */
  node: string;
  cli: string;
  /** Where the supervisor's stdout and stderr go. */
  logPath: string;
  workingDirectory: string;
  /** What launchd's empty environment needs: PATH, the config directory, HOME. */
  environment: Record<string, string>;
}

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The LaunchAgent's property list. */
export function launchAgentPlist(spec: LaunchAgentSpec): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const env = Object.entries(spec.environment)
    .map(([key, value]) => `\n      <key>${xml(key)}</key>\n      ${string(value)}`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${string(LAUNCH_AGENT_LABEL)}
    <key>ProgramArguments</key>
    <array>
      ${string(spec.node)}
      ${string(spec.cli)}
      ${string("host")}
      ${string("run")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>${env}
    </dict>
    <key>WorkingDirectory</key>
    ${string(spec.workingDirectory)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    ${string("Background")}
    <key>StandardOutPath</key>
    ${string(spec.logPath)}
    <key>StandardErrorPath</key>
    ${string(spec.logPath)}
  </dict>
</plist>
`;
}

export function launchAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWITCHBOARD_LAUNCH_AGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(launchAgentsDir(env), `${LAUNCH_AGENT_LABEL}.plist`);
}

const run = promisify(execFile);

function launchctl(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return run(env.SWITCHBOARD_LAUNCHCTL || "/bin/launchctl", args, { env });
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** Writes the LaunchAgent and loads it, replacing one loaded before. */
export async function installLaunchAgent(spec: LaunchAgentSpec, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = plistPath(env);
  await mkdir(launchAgentsDir(env), { recursive: true });
  await writeFile(path, launchAgentPlist(spec), { mode: 0o644 });
  await launchctl(["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`], env).catch(() => {
    // It was not loaded.
  });
  await launchctl(["bootstrap", domain(), path], env);
  return path;
}

/** Unloads the LaunchAgent and removes it. */
export async function uninstallLaunchAgent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await launchctl(["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`], env).catch(() => {
    // It was not loaded.
  });
  await rm(plistPath(env), { force: true });
}

/** Whether launchd has the LaunchAgent loaded. */
export async function launchAgentLoaded(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await launchctl(["print", `${domain()}/${LAUNCH_AGENT_LABEL}`], env);
    return true;
  } catch {
    return false;
  }
}
