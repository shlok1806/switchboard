import type { NativeResult } from "../../shared/src/m1";
import type { ChannelAuthorization } from "./organization";
import { AuthorityUnavailable, authorityRequest } from "./policy-permits";

export interface ManagedReadRoute {
  action: string;
  targetId: string;
  operation: string;
}
/** Explicit read inventory. Every other managed operation remains closed until implemented. */
export function managedReadRoute(method: string, path: string): ManagedReadRoute | null {
  if (method !== "GET") return null;
  if (["/api/skills", "/api/artifacts", "/api/brief"].includes(path))
    return { action: "channel.update.read", targetId: path.slice(5), operation: "content.list" };
  const content = /^\/api\/(skills|artifacts|brief)\/([^/]+)(\/page)?$/.exec(path);
  if (content?.[1] && content[2]) {
    try {
      const name = decodeURIComponent(content[2]);
      if (
        !name ||
        /[/\\]/.test(name) ||
        [...name].some((character) => character.charCodeAt(0) < 32) ||
        (content[3] && content[1] !== "artifacts")
      )
        return null;
      return {
        action: "channel.update.read",
        targetId: `${content[1]}/${name}`,
        operation: content[3] ? "content.page" : "content.read",
      };
    } catch {
      return null;
    }
  }
  if (path === "/api/agents") return { action: "agent.view", targetId: "agents", operation: "agents.list" };
  const summary = /^\/api\/agents\/([^/]+)\/summary$/.exec(path);
  if (summary?.[1]) {
    try {
      const id = decodeURIComponent(summary[1]);
      if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(id)) return null;
      return { action: "agent.view", targetId: id, operation: "agent.summary" };
    } catch {
      return null;
    }
  }

  const privateRead = /^\/api\/agents\/([^/]+)\/(transcript|terminal|touched-files)$/.exec(path);
  if (privateRead?.[1] && privateRead[2]) {
    try {
      const id = decodeURIComponent(privateRead[1]);
      if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(id)) return null;
      return {
        action: privateRead[2] === "terminal" ? "agent.private_screen.read" : "agent.private_transcript.read",
        targetId: id,
        operation: privateRead[2],
      };
    } catch {
      return null;
    }
  }

  const task = /^\/api\/tasks\/([1-9]\d{0,9})$/.exec(path);
  if (path === "/api/tasks" || task)
    return { action: "task.read", targetId: task?.[1] ?? "tasks", operation: "task.read" };
  if (path === "/api/relay") return { action: "workspace.read", targetId: "relay", operation: "relay.read" };
  return null;
}

export class ManagedReadFailure extends Error {
  constructor(readonly status: 404 | 502 | 503) {
    super("managed_read_unavailable");
  }
}

export function managedError(status: number, reason: string): Response {
  return Response.json({ ok: false, reason }, { status, headers: { "Cache-Control": "no-store" } });
}

/** No cache: check before the read and again after every asynchronous read/preparation. */
export async function managedRead<T>(options: {
  input: ChannelAuthorization;
  current(): boolean;
  authorize(input: ChannelAuthorization): Promise<NativeResult<unknown>>;
  read(): Promise<T>;
}): Promise<Response> {
  try {
    const admitted = await authorityRequest(() => options.authorize(options.input));
    if (!admitted.ok || !options.current()) return managedError(404, "resource_denied");
    const value = await options.read();
    const released = await authorityRequest(() => options.authorize(options.input));
    if (!released.ok || !options.current()) return managedError(404, "resource_denied");
    return value instanceof Response ? value : Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ManagedReadFailure)
      return managedError(error.status, error.status === 404 ? "resource_denied" : "managed_read_unavailable");
    if (error instanceof AuthorityUnavailable) return managedError(503, "authority_unavailable");
    // Do not expose external error messages, paths or partially prepared content.
    return managedError(503, "managed_read_unavailable");
  }
}

/** Only implemented mutations are admitted; an unrecognized router path remains denied. */
export function managedWriteRoute(method: string, path: string): ManagedReadRoute | null {
  if (method === "DELETE") {
    const read = managedReadRoute("GET", path);
    return read?.operation === "content.read" && read.targetId.startsWith("artifacts/")
      ? { ...read, action: "channel.update.write", operation: "artifact.delete" }
      : null;
  }
  if (method !== "POST") return null;
  if (path === "/api/directives")
    return { action: "agent.directive.send", targetId: "directives", operation: "directive.send" };
  if (path === "/api/updates") return { action: "channel.update.write", targetId: "updates", operation: "update.post" };
  const task =
    /^\/api\/tasks\/([1-9]\d{0,9})\/(claim|release|branch|finish|takeover|steps\/(0|[1-9]\d{0,4})\/complete)$/.exec(
      path,
    );
  if (!task?.[1] || !task[2]) return null;
  return {
    action: task[2] === "claim" ? "task.claim" : "task.update",
    targetId: task[1],
    operation: `task.${task[2]}`,
  };
}
