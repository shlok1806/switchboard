// The Host's own check of what the Channel asks it to run (ADR 0017). The Channel's
// copy of the Host's folders and mode is advisory: the Person's session can widen it.
// So every spawn, and every resume, is checked here against the limits the Person
// gave `switchboard host install` on this machine, and nothing in a request is
// trusted to have the type it should. The same goes for who is asking (ADR 0028): the
// Channel names the requesting Person, and this machine's `--allow` list decides.

import { realpathSync } from "node:fs";
import type { AgentId, PermissionMode } from "../../../shared/src/index";
import {
  cleanAbsolutePath,
  isPermissionMode,
  LOGIN_PATTERN,
  MAX_BRIEF_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_NICKNAME_LENGTH,
  PERMISSION_MODES,
  permissionModeWithin,
  underRoots,
} from "../../../shared/src/index";

/** The limits this machine's Host was installed with. `roots` are already resolved (realpath). */
export interface LocalLimits {
  roots: readonly string[];
  maxPermissionMode: PermissionMode;
  /** How many Agents this Host runs at once, whatever the Channel's cap allows. */
  maxAgents: number;
  /** The Host's own Person: always allowed. */
  owner: string;
  /** The other Persons `--allow` named, and whether `--allow-channel` opened it to the Channel's members. */
  allow: readonly string[];
  allowChannel: boolean;
}

/** A spawn request, checked: every field has its type, the folder is resolved and allowed, the mode allowed. */
export interface CheckedSpawn {
  spawn: string;
  cli: "claude-code";
  cwd: string;
  nickname?: string;
  model?: string;
  brief?: string;
  permissionMode: PermissionMode;
  by: string;
  /** The lead that asked, for a lead's spawn (ADR 0018). */
  lead?: AgentId;
  /** The Agent it continues (ADR 0024): the wrapper starts with `--from`. */
  from?: AgentId;
}

type Refused = { ok: false; reason: string };

/**
 * Whether Person `by` may use this Host, by this machine's own file: its owner, anyone
 * `--allow` named, or any Channel member under `--allow-channel` (the Channel vouches that
 * `by` has write access, as it does for every Person it lets in).
 */
export function mayRequest(by: unknown, limits: LocalLimits): by is string {
  if (typeof by !== "string" || !LOGIN_PATTERN.test(by)) return false;
  return by === limits.owner || limits.allowChannel || limits.allow.includes(by);
}

/** Why Person `by` may not use this Host, in the words a refusal gives. */
export function notAllowedReason(by: unknown, owner: string): string {
  const who = typeof by === "string" && LOGIN_PATTERN.test(by) ? by : "that Person";
  return `${who} is not allowed on this Host: ${owner} has to run \`switchboard host install --allow ${who}\` on this machine`;
}

/** A stop, pause or resume frame, checked: the Agent it names, and the Person who asked, allowed here. */
export function checkControl(
  frame: Record<string, unknown>,
  limits: LocalLimits,
): { ok: true; agent: AgentId; by: string } | (Refused & { agent: AgentId | null; by: string }) {
  const agent = isAgentId(frame.agent) ? frame.agent : null;
  const by = typeof frame.by === "string" ? frame.by.slice(0, 40) : "unknown";
  if (agent === null) return { ok: false, agent, by, reason: "the request names no Agent" };
  if (!mayRequest(frame.by, limits)) return { ok: false, agent, by, reason: notAllowedReason(frame.by, limits.owner) };
  return { ok: true, agent, by: frame.by as string };
}

/** Resolves each root as the Host compares folders: through symlinks. A root that is gone stays as given. */
export function resolveRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
}

/**
 * Whether an Agent may run in `cwd` with `mode` on this Host. The folder is resolved
 * through symlinks first, so a link inside a root that points out of it does not count.
 */
export function checkFolderAndMode(
  cwd: unknown,
  mode: unknown,
  limits: LocalLimits,
): { ok: true; cwd: string; permissionMode: PermissionMode } | Refused {
  if (!isPermissionMode(mode))
    return { ok: false, reason: `the permission mode must be one of ${PERMISSION_MODES.join(", ")}` };
  if (!permissionModeWithin(mode, limits.maxPermissionMode)) {
    return { ok: false, reason: `this Host starts Agents in at most the "${limits.maxPermissionMode}" mode` };
  }
  const path = cleanAbsolutePath(cwd);
  if (path === null) return { ok: false, reason: "the folder must be an absolute path with no . or .. in it" };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, reason: `${path} does not exist on this Host` };
  }
  if (!underRoots(real, limits.roots)) return { ok: false, reason: `${path} is not under this Host's folders` };
  return { ok: true, cwd: real, permissionMode: mode };
}

/**
 * Text passed to `switchboard run claude` as a flag's value. One that starts with "-"
 * would read as a flag of its own (`--model -r` turns a new session into the picker),
 * and a line break has no place in either.
 */
function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= max && !value.startsWith("-") && !/[\r\n]/.test(value)
    ? value
    : null;
}

/** Checks a `host.spawn` frame as it came off the socket. `spawn` is null when even that is missing. */
export function checkSpawn(
  frame: Record<string, unknown>,
  limits: LocalLimits,
): { ok: true; request: CheckedSpawn } | (Refused & { spawn: string | null }) {
  const spawn = typeof frame.spawn === "string" && frame.spawn.length <= 100 ? frame.spawn : null;
  const refuse = (reason: string) => ({ ok: false as const, spawn, reason });
  if (spawn === null) return refuse("the request names no spawn");
  if (frame.cli !== "claude-code") return refuse("this Host starts only claude-code Agents");
  // The Person's name goes into the brief's heading, so it must be a name and nothing else.
  if (typeof frame.by !== "string" || !LOGIN_PATTERN.test(frame.by)) return refuse("the request names no Person");
  if (!mayRequest(frame.by, limits)) return refuse(notAllowedReason(frame.by, limits.owner));
  // An Agent ID is `<person>/<cli>/<suffix>`; the Host only names it in the brief.
  const lead = frame.lead;
  if (lead !== undefined && !isAgentId(lead)) return refuse("the lead is not an Agent ID");
  // Given to the wrapper as `--from`, so an Agent ID and nothing that reads as an option.
  const from = frame.from;
  if (from !== undefined && !isAgentId(from)) return refuse("the Agent it continues is not an Agent ID");
  const nickname = optionalText(frame.nickname, MAX_NICKNAME_LENGTH);
  const model = optionalText(frame.model, MAX_MODEL_LENGTH);
  const brief =
    frame.brief === undefined
      ? undefined
      : typeof frame.brief === "string" && frame.brief.length <= MAX_BRIEF_LENGTH
        ? frame.brief
        : null;
  if (nickname === null || model === null || brief === null)
    return refuse('the nickname, model or brief is not text, or starts with "-"');
  const place = checkFolderAndMode(frame.cwd, frame.permissionMode, limits);
  if (!place.ok) return refuse(place.reason);
  return {
    ok: true,
    request: {
      spawn,
      cli: "claude-code",
      cwd: place.cwd,
      ...(nickname === undefined ? {} : { nickname }),
      ...(model === undefined ? {} : { model }),
      ...(brief === undefined ? {} : { brief }),
      permissionMode: place.permissionMode,
      by: frame.by,
      ...(lead === undefined ? {} : { lead: lead as AgentId }),
      ...(from === undefined ? {} : { from: from as AgentId }),
    },
  };
}

/** An Agent ID: `<person>/<cli>/<suffix>`, none of it starting with "-". */
function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && /^[^/\s-][^/\s]*\/[^/\s]+\/[^/\s]+$/.test(value);
}
