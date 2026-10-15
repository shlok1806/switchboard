// The Host commands (ADR 0015):
//
//   switchboard host install [--name N] [--root DIR]... [--max-permission-mode M] [--repo R]
//   switchboard host uninstall
//   switchboard host run       (what the LaunchAgent runs; tests run it directly)
//   switchboard host status
//   switchboard spawn [--host N] [--cwd DIR] [--nickname N] [--model M] [--permission-mode M] [--repo R] [brief...]
//   switchboard stop <agent> [--repo R]
//   switchboard role grant <agent> lead | revoke <agent> [--repo R]   (ADR 0018)
//
// `spawn` and `stop` work from anywhere: they ask the Channel, which asks the Host.
// `role` makes one of the Person's Agents a lead, which may spawn and stop on their
// Hosts, and send Directives, for the Agents it starts.

import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  Agent,
  AgentResponse,
  AgentsResponse,
  HostResponse,
  HostsResponse,
  PermissionMode,
  SpawnAgentResponse,
  StopAgentResponse,
} from "../../../shared/src/index";
import {
  AGENT_ROLES,
  agentPath,
  DEFAULT_PERMISSION_MODE,
  HOST_NAME_PATTERN,
  isAgentRole,
  isPermissionMode,
  PERMISSION_MODES,
  rolePath,
} from "../../../shared/src/index";
import { ChannelChoiceError, chooseChannel } from "../channel-choice";
import { ChannelClient, ChannelError, targetOf } from "../channel-client";
import { type Config, configDir, readConfig } from "../config";
import { matchAgents } from "../rename";
import {
  CappedLog,
  HOST_LOG_MAX_BYTES,
  type HostedAgent,
  hostDir,
  hostLogPath,
  launchdLogPath,
  pidPath,
  readAgents,
  readSettings,
  settingsPath,
  writeSettings,
} from "./files";
import { installLaunchAgent, LAUNCH_AGENT_LABEL, launchAgentLoaded, plistPath, uninstallLaunchAgent } from "./launchd";
import { HostSupervisor } from "./supervisor";

export const HOST_USAGE = `Usage:
  switchboard host install [--name <name>] [--root <folder>]... [--max-permission-mode <mode>] [--repo <owner>/<repo>]
  switchboard host uninstall
  switchboard host run
  switchboard host status`;

class CommandError extends Error {}

async function signedIn(): Promise<Config> {
  const config = await readConfig();
  if (!config) throw new CommandError("not logged in. Run `switchboard login` first.");
  return config;
}

async function channelFor(config: Config, repo: string | undefined): Promise<{ client: ChannelClient; repo: string }> {
  try {
    const choice = await chooseChannel(config, {
      ...(repo === undefined ? {} : { flag: repo }),
      env: process.env,
      cwd: process.cwd(),
    });
    return { client: new ChannelClient(targetOf(config, choice.repo)), repo: choice.repo };
  } catch (error) {
    if (error instanceof ChannelChoiceError) throw new CommandError(error.message);
    throw error;
  }
}

/** Runs `body`, saying why on failure. */
async function command(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CommandError || error instanceof ChannelError) {
      console.error(`switchboard: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function mode(value: string | undefined, flag: string): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (!isPermissionMode(value)) throw new CommandError(`${flag} must be one of ${PERMISSION_MODES.join(", ")}.`);
  return value;
}

/**
 * The variables from the installing shell that change how the Agents run, carried into
 * the LaunchAgent, which otherwise starts with launchd's bare environment.
 */
const PASSED_ON = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"] as const;

function passedOn(): Record<string, string> {
  return Object.fromEntries(PASSED_ON.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

/** This machine's short host name, as a Host name. */
function defaultName(): string {
  return (
    hostname()
      .split(".")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 40) || "host"
  );
}

async function install(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      root: { type: "string", multiple: true },
      "max-permission-mode": { type: "string" },
      repo: { type: "string" },
    },
  });
  const config = await signedIn();
  const name = values.name ?? defaultName();
  if (!HOST_NAME_PATTERN.test(name)) {
    throw new CommandError('--name must be lower-case letters, digits and "-", at most 40.');
  }
  const roots = (values.root ?? []).map((root) => {
    const path = resolve(root);
    if (!existsSync(path)) throw new CommandError(`--root ${root} does not exist.`);
    return realpathSync(path);
  });
  if (roots.length === 0) throw new CommandError("Name at least one folder Agents may run in with --root.");
  const maxPermissionMode = mode(values["max-permission-mode"], "--max-permission-mode") ?? DEFAULT_PERMISSION_MODE;
  const { client, repo } = await channelFor(config, values.repo);
  const { host } = await client.request<HostResponse>("/api/hosts", {
    method: "POST",
    body: JSON.stringify({ name, roots, maxPermissionMode }),
  });
  // The limits this machine keeps are the ones typed here, not the Channel's answer:
  // the Host checks every spawn against them (ADR 0017).
  writeSettings({ name, repo, roots, maxPermissionMode });
  const plist = await installLaunchAgent({
    node: process.execPath,
    cli: realpathSync(process.argv[1] ?? ""),
    logPath: launchdLogPath(),
    workingDirectory: homedir(),
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: homedir(),
      SWITCHBOARD_CONFIG_DIR: configDir(),
      ...passedOn(),
    },
  });
  console.log(`${host.id} is installed for ${repo}.`);
  console.log(`  Starts Agents under: ${roots.join(", ")}`);
  console.log(`  Permission mode: at most "${maxPermissionMode}"`);
  console.log(`  LaunchAgent: ${plist}`);
  console.log(`  Log: ${hostLogPath()}`);
  return 0;
}

async function uninstall(): Promise<number> {
  const config = await signedIn();
  const settings = readSettings();
  await uninstallLaunchAgent();
  if (settings !== null) {
    const client = new ChannelClient(targetOf(config, settings.repo));
    await client.request(`/api/hosts/${encodeURIComponent(settings.name)}`, { method: "DELETE" }).catch((error) => {
      if (!(error instanceof ChannelError) || error.status !== 404) throw error;
    });
    unlinkSync(settingsPath());
  }
  console.log(settings === null ? "No Host was installed here." : `${config.person}/${settings.name} is uninstalled.`);
  return 0;
}

/** The supervisor's process ID, when one runs. */
function runningPid(): number | null {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function run(): Promise<number> {
  // Under launchd the log is the Host's own capped file; stdout goes to launchd.log,
  // which then holds only what escaped it, such as a crash.
  const underLaunchd = process.env.XPC_SERVICE_NAME === LAUNCH_AGENT_LABEL;
  const file = new CappedLog(hostLogPath(), HOST_LOG_MAX_BYTES);
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    file.append(stamped);
    if (!underLaunchd) process.stdout.write(stamped);
  };
  // Reasons a restart cannot help. launchd restarts only a failed exit, so under it these exit 0.
  const cannotRun = (reason: string) => {
    log(`not starting: ${reason}`);
    if (!underLaunchd) console.error(`switchboard: ${reason}`);
    return underLaunchd ? 0 : 1;
  };
  const config = await readConfig();
  if (!config) return cannotRun("not logged in. Run `switchboard login` first.");
  const settings = readSettings();
  if (settings === null)
    return cannotRun(`no Host is installed here (no ${settingsPath()}). Run \`switchboard host install\`.`);
  const other = runningPid();
  if (other !== null && other !== process.pid) return cannotRun(`a Host supervisor already runs here (pid ${other}).`);
  writeFileSync(pidPath(), `${process.pid}\n`, { mode: 0o600 });
  const supervisor = new HostSupervisor({
    config,
    settings,
    node: process.execPath,
    cli: realpathSync(process.argv[1] ?? ""),
    env: process.env,
    log,
  });
  supervisor.start();
  await new Promise<void>((done) => {
    const stop = (signal: string) => {
      log(`${signal}: ending the Agents; they resume when the Host starts again`);
      supervisor.shutdown().then(done, done);
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
  try {
    if (runningPid() === process.pid) unlinkSync(pidPath());
  } catch {
    // Gone already.
  }
  return 0;
}

async function status(): Promise<number> {
  const settings = readSettings();
  if (settings === null) {
    console.log(`No Host is installed here (no ${settingsPath()}).`);
    return 1;
  }
  const config = await readConfig();
  const pid = runningPid();
  console.log(`Host ${config?.person ?? "?"}/${settings.name} for ${settings.repo}`);
  console.log(`  Folders: ${settings.roots.join(", ")}`);
  console.log(`  Permission mode: at most "${settings.maxPermissionMode}"`);
  console.log(`  LaunchAgent: ${(await launchAgentLoaded()) ? `loaded (${plistPath()})` : "not loaded"}`);
  console.log(`  Supervisor: ${pid === null ? "not running" : `running (pid ${pid})`}; log ${hostLogPath()}`);
  if (config !== null) {
    const client = new ChannelClient(targetOf(config, settings.repo));
    const listed = await client.request<HostsResponse>("/api/hosts").catch(() => null);
    const host = listed?.hosts.find((h) => h.person === config.person && h.name === settings.name);
    console.log(`  On the Channel: ${host === undefined ? "unknown" : host.live ? "Live" : "Offline"}`);
  }
  let agents: HostedAgent[];
  try {
    agents = readAgents();
  } catch (error) {
    console.log(`  Agents: cannot read them (${(error as Error).message})`);
    agents = [];
  }
  console.log(agents.length === 0 ? "  No Agents." : `  Agents (${agents.length}):`);
  for (const a of agents)
    console.log(`    ${a.agent}${a.nickname ? ` "${a.nickname}"` : ""} in ${a.cwd} (${a.permissionMode})`);
  console.log(`  Files: ${hostDir()}`);
  return 0;
}

export function hostCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  return command(async () => {
    switch (sub) {
      case "install":
        return install(rest);
      case "uninstall":
        return uninstall();
      case "run":
        return run();
      case "status":
        return status();
      default:
        console.error(HOST_USAGE);
        return 2;
    }
  });
}

export function spawnCommand(args: string[]): Promise<number> {
  return command(async () => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        host: { type: "string" },
        cwd: { type: "string" },
        nickname: { type: "string" },
        model: { type: "string" },
        "permission-mode": { type: "string" },
        repo: { type: "string" },
      },
    });
    const config = await signedIn();
    const { client } = await channelFor(config, values.repo);
    const permissionMode = mode(values["permission-mode"], "--permission-mode");
    const brief = positionals.join(" ").trim();
    const answer = await client.request<SpawnAgentResponse>(
      "/api/agents/spawn",
      {
        method: "POST",
        body: JSON.stringify({
          ...(values.host === undefined ? {} : { host: values.host }),
          cli: "claude-code",
          cwd: resolve(values.cwd ?? process.cwd()),
          ...(values.nickname === undefined ? {} : { nickname: values.nickname }),
          ...(values.model === undefined ? {} : { model: values.model }),
          ...(brief === "" ? {} : { brief }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
        }),
      },
      60_000,
    );
    console.log(
      answer.agent === undefined
        ? `${answer.host} is still starting it (spawn ${answer.spawn}). The Channel says when it is on.`
        : `${answer.agent.id}${answer.agent.nickname ? ` "${answer.agent.nickname}"` : ""} is running on ${answer.host}.`,
    );
    return 0;
  });
}

export const ROLE_USAGE = `Usage:
  switchboard role grant <agent> lead [--repo <owner>/<repo>]
  switchboard role revoke <agent> [--repo <owner>/<repo>]`;

/** The one Agent `name` names, by Agent ID or Nickname, among `agents`. */
function oneAgent(agents: Agent[], name: string): Agent {
  const found = matchAgents(agents, name);
  if (found.length !== 1) {
    throw new CommandError(
      found.length === 0
        ? `no Agent is called ${name}. Name it by its Agent ID or Nickname.`
        : `${name} could be ${found.map((a) => a.id).join(", ")}. Use the full Agent ID.`,
    );
  }
  return found[0] as Agent;
}

/** Grants one of the Person's Agents a role, or takes it back (ADR 0018). */
export function roleCommand(args: string[]): Promise<number> {
  return command(async () => {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repo: { type: "string" } } });
    const [verb, name, role, ...extra] = positionals;
    const granting = verb === "grant" && role !== undefined && extra.length === 0;
    const revoking = verb === "revoke" && role === undefined;
    if (name === undefined || (!granting && !revoking)) {
      console.error(ROLE_USAGE);
      return 2;
    }
    if (granting && !isAgentRole(role)) throw new CommandError(`the role must be one of ${AGENT_ROLES.join(", ")}.`);
    const config = await signedIn();
    const { client } = await channelFor(config, values.repo);
    const { agents } = await client.request<AgentsResponse>("/api/agents");
    const agent = oneAgent(agents, name);
    const { agent: after } = await client.request<AgentResponse>(
      rolePath(agent.id),
      granting ? { method: "PUT", body: JSON.stringify({ role }) } : { method: "DELETE" },
    );
    console.log(
      after.role === undefined
        ? `${after.id} has no role now.`
        : `${after.id} is a ${after.role} now: it may start Agents on your Hosts, and stop and direct the ones it starts.`,
    );
    return 0;
  });
}

export function stopCommand(args: string[]): Promise<number> {
  return command(async () => {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repo: { type: "string" } } });
    const [name, ...extra] = positionals;
    if (name === undefined || extra.length > 0) {
      console.error("Usage: switchboard stop <agent> [--repo <owner>/<repo>]");
      return 2;
    }
    const config = await signedIn();
    const { client } = await channelFor(config, values.repo);
    const { agents } = await client.request<AgentsResponse>("/api/agents");
    const found = matchAgents(
      agents.filter((a) => a.presence !== "gone"),
      name,
    );
    if (found.length !== 1) {
      throw new CommandError(
        found.length === 0
          ? `no running Agent is called ${name}. Name it by its Agent ID or Nickname.`
          : `${name} could be ${found.map((a) => a.id).join(", ")}. Use the full Agent ID.`,
      );
    }
    const [agent] = found as [Agent];
    const answer = await client.request<StopAgentResponse>(`${agentPath(agent.id)}/stop`, { method: "POST" });
    console.log(`Asked ${answer.host} to stop ${answer.agent}.`);
    return 0;
  });
}
