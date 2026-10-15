// The Host's own check of what the Channel asks it to run (ADR 0017). The Channel's
// copy of the Host's folders and mode is advisory: the Person's session can widen it.
// So every spawn, and every resume, is checked here against the limits the Person
// gave `switchboard host install` on this machine, and nothing in a request is
// trusted to have the type it should.

import { realpathSync } from "node:fs";
import type { PermissionMode } from "../../../shared/src/index";
import {
  cleanAbsolutePath,
  isPermissionMode,
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
}

type Refused = { ok: false; reason: string };

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

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= max ? value : null;
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
  if (typeof frame.by !== "string") return refuse("the request names no Person");
  const nickname = optionalText(frame.nickname, MAX_NICKNAME_LENGTH);
  const model = optionalText(frame.model, MAX_MODEL_LENGTH);
  const brief = optionalText(frame.brief, MAX_BRIEF_LENGTH);
  if (nickname === null || model === null || brief === null) return refuse("the nickname, model or brief is not text");
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
    },
  };
}
