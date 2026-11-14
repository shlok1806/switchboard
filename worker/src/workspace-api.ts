import { SESSION_COOKIE } from "../../shared/src/index";
import type { OrganizationCommand } from "../../shared/src/m1";
import { channelRepo, devMode, readCookie, readNativeActor, sessionSecret } from "./auth";
import { canonical } from "./organization";
import { workspaceParent } from "./policy";
import { signPayload, tokenHash, verifyPayload } from "./session";

/** Native administration only. No Channel content or P2/P3 action is exposed here. */
export async function handleWorkspaceApi(request: Request, url: URL, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const reply = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  const error = (status: number, reason: string, policyRevision = 0, operationId?: string) =>
    reply(
      {
        error: { code: status === 404 || status === 403 ? "RESOURCE_DENIED" : "REQUEST_FAILED", reason },
        policyRevision,
        requestId,
        ...(operationId ? { operationId } : {}),
      },
      status,
    );
  try {
    const actor = await readNativeActor(request, url, env);
    if (!actor) return error(401, "native_authentication_required");
    const directory = env.IDENTITY_DIRECTORY.getByName("directory-v1");
    const secret = sessionSecret(env, devMode(env, url));
    if (!secret) return error(503, "authority_unavailable");
    const scope = `${actor.personId}:${url.pathname}`;
    let after = "";
    const rawCursor = url.searchParams.get("cursor");
    if (rawCursor) {
      if (rawCursor.length > 2048) return error(400, "invalid_cursor");
      const cursor = await verifyPayload(secret, rawCursor);
      if (
        cursor?.kind !== "m1-cursor" ||
        cursor.scope !== scope ||
        typeof cursor.after !== "string" ||
        cursor.after.length > 100 ||
        typeof cursor.exp !== "number" ||
        cursor.exp * 1000 <= Date.now()
      )
        return error(400, "invalid_cursor");
      after = cursor.after;
    }
    const page = async (items: unknown[], next: string | null, policyRevision = 0) =>
      reply({
        items,
        cursor: next
          ? await signPayload(secret, {
              kind: "m1-cursor",
              scope,
              after: next,
              exp: Math.floor(Date.now() / 1000) + 600,
            })
          : null,
        policyRevision,
        requestId,
      });
    if (url.pathname === "/api/m1") return error(404, "resource_denied");
    let parts: string[];
    try {
      parts = url.pathname.slice("/api/m1/".length).split("/").map(decodeURIComponent);
    } catch {
      return error(400, "invalid_path");
    }
    const [collection, id, sub, target] = parts;
    if (parts.length > 4) return error(404, "resource_denied");
    const write = request.method !== "GET";
    const rawKey = request.headers.get("Idempotency-Key") ?? "";
    const key = await tokenHash(canonical([url.pathname, rawKey]));
    if (write && (!rawKey.trim() || rawKey.length > 128)) return error(400, "idempotency_key_required");
    let body: Record<string, unknown> = {};
    if (write) {
      const raw = await request.text();
      if (raw.length > 16_384) return error(400, "invalid_body");
      if (raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return error(400, "invalid_body");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(400, "invalid_body");
        body = parsed as Record<string, unknown>;
      }
    }
    let expectedRevision: number | undefined;
    if (request.method === "PATCH" || request.method === "DELETE") {
      const match = /^(?:"([0-9]+)"|([0-9]+))$/.exec(request.headers.get("If-Match") ?? "");
      expectedRevision = match ? Number(match[1] ?? match[2]) : undefined;
      if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision))
        return error(400, "revision_required");
    }
    if (collection === "organizations" && !id) {
      if (request.method === "GET") {
        const result = await directory.organizations(actor, after);
        return page(result.organizations, result.next);
      }
      if (
        request.method === "POST" &&
        typeof body.name === "string" &&
        Object.keys(body).every((k) => ["name", "actor"].includes(k))
      ) {
        const result = await directory.createOrganization(actor, body.name, key, requestId);
        return result.ok
          ? reply({ ...result, requestId }, 201)
          : error(result.status, result.reason, result.policyRevision);
      }
      return error(400, "invalid_request");
    }
    if (collection === "operations" && id && !sub && request.method === "GET") {
      const parent = workspaceParent(id);
      if (!parent) return error(404, "resource_denied");
      using value = await env.ORGANIZATION.getByName(parent).bindingOperation(actor, id);
      return value ? reply({ value, requestId }) : error(404, "resource_denied");
    }
    let organizationId =
      collection === "organizations" && id && /^[0-9a-f-]{36}$/.test(id)
        ? id
        : collection === "workspaces" && id
          ? workspaceParent(id)
          : null;
    if (collection === "invitations" && id && sub === "accept" && request.method === "POST" && !target)
      organizationId = await directory.invitationOrganization(actor, id);
    if (!organizationId) return error(404, "resource_denied");
    const org = env.ORGANIZATION.getByName(organizationId);
    using metadata = await org.metadata(actor);
    if (!metadata && collection !== "invitations") return error(404, "resource_denied");
    const revision = metadata?.policyRevision ?? 0;
    if (collection === "workspaces" && sub === "channel" && !target && ["POST", "DELETE"].includes(request.method)) {
      if (
        typeof body.repo !== "string" ||
        !channelRepo(env, body.repo) ||
        Object.keys(body).some((k) => !["repo", "operationId", "acknowledgeLegacyAccess"].includes(k)) ||
        (body.operationId !== undefined && typeof body.operationId !== "string")
      )
        return error(400, "invalid_binding");
      const authorization = request.headers.get("Authorization");
      const token = authorization ? authorization.slice(7).trim() : readCookie(request, SESSION_COOKIE);
      const session = token ? await verifyPayload(secret, token) : null;
      if (typeof session?.login !== "string") return error(401, "native_authentication_required");
      using result = await org.coordinateBinding({
        actor,
        login: session.login,
        workspaceId: id ?? "",
        repo: channelRepo(env, body.repo) ?? "",
        mode: request.method === "DELETE" ? "unbind" : "bind",
        key,
        requestId,
        operationId: body.operationId as string | undefined,
        expectedRevision,
        acknowledgeLegacyAccess: body.acknowledgeLegacyAccess === true,
      });
      return result.ok
        ? reply({ ...result, requestId })
        : error(result.status, result.reason, result.policyRevision, result.operationId);
    }

    if (request.method === "GET") {
      if (target) return error(404, "resource_denied");
      if (collection === "organizations" && !sub)
        return reply({ value: metadata, policyRevision: revision, requestId });
      if (collection === "workspaces" && !sub) {
        const value = await org.workspace(actor, id ?? "", true);
        return value ? reply({ value, policyRevision: revision, requestId }) : error(404, "resource_denied");
      }
      if (sub === "audit" && collection === "organizations") {
        if (after && !/^\d+:[0-9a-f-]{36}$/.test(after)) return error(400, "invalid_cursor");
        const records = await org.auditRecords(actor, Number(after.split(":")[0] || 0), after.split(":")[1] ?? "");
        return records
          ? page(
              records,
              records.length === 100 ? `${records.at(-1)?.timestamp}:${records.at(-1)?.id}` : null,
              revision,
            )
          : error(404, "resource_denied");
      }
      if (sub === "members" || (sub === "workspaces" && collection === "organizations")) {
        const result = await org.catalog(
          actor,
          sub === "workspaces" ? "workspaces" : collection === "workspaces" ? "workspace-members" : "members",
          collection === "workspaces" ? id : undefined,
          after,
        );
        return result ? page(result.items, result.next, result.policyRevision) : error(404, "resource_denied");
      }
      return error(404, "resource_denied");
    }
    // Construct commands from an explicit field allowlist; never accept actor/command from the body.
    let command: unknown;
    let fields: string[] = [];
    if (request.method === "PATCH" && !sub) {
      if (!Object.keys(body).some((k) => ["name", "description", "status"].includes(k)))
        return error(400, "invalid_body");
      const currentWorkspace = collection === "workspaces" ? await org.workspace(actor, id ?? "", true) : null;
      if (collection === "workspaces" && !currentWorkspace) return error(404, "resource_denied");
      fields = collection === "organizations" ? ["name"] : ["name", "description", "status"];
      command =
        collection === "organizations"
          ? { kind: "organization.rename", name: body.name }
          : {
              kind: "workspace.update",
              workspaceId: id,
              name: body.name ?? currentWorkspace?.name,
              description: body.description ?? currentWorkspace?.description,
              status: body.status ?? currentWorkspace?.status,
            };
    } else if (collection === "organizations" && sub === "workspaces" && !target && request.method === "POST") {
      fields = ["name", "description", "acceptManager"];
      command = {
        kind: "workspace.create",
        name: body.name,
        description: body.description ?? "",
        acceptManager: body.acceptManager,
      };
    } else if (collection === "invitations" && sub === "accept" && !target && request.method === "POST") {
      command = { kind: "invitation.accept", invitationId: id };
    } else if (sub === "members" && !target && request.method === "POST") {
      if (collection === "organizations" || body.githubId !== undefined) {
        fields = ["githubId", "organizationRole", "workspaceRole"];
        if (typeof body.githubId !== "string") return error(400, "invalid_body");
        command = {
          kind: "invitation.create",
          githubId: body.githubId,
          organizationRole: body.organizationRole,
          ...(collection === "workspaces" ? { workspaceId: id, workspaceRole: body.workspaceRole } : {}),
        };
      } else {
        fields = ["personId", "role", "reason"];
        command = {
          kind: "workspace.member",
          workspaceId: id,
          personId: body.personId,
          role: body.role,
          status: "active",
          reason: body.reason,
        };
        // S1 membership commands require a revision even for an explicit grant.
        const revisionHeader = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
        expectedRevision = revisionHeader && /^\d+$/.test(revisionHeader) ? Number(revisionHeader) : undefined;
      }
    } else if (sub === "members" && target && ["PATCH", "DELETE"].includes(request.method)) {
      fields = ["role", "reason"];
      const members =
        request.method === "DELETE" && body.role === undefined
          ? await org.catalog(
              actor,
              collection === "organizations" ? "members" : "workspace-members",
              collection === "workspaces" ? id : undefined,
              target.slice(0, -1),
            )
          : null;
      const existingRole = members?.items.find((member) => "personId" in member && member.personId === target);
      command = {
        kind: collection === "organizations" ? "organization.member" : "workspace.member",
        ...(collection === "workspaces" ? { workspaceId: id, reason: body.reason } : {}),
        personId: target,
        role: body.role ?? (existingRole && "role" in existingRole ? existingRole.role : undefined),
        status: request.method === "DELETE" ? "revoked" : "active",
      };
    }
    if (!command) return error(404, "resource_denied");
    if (Object.keys(body).some((k) => !fields.includes(k) && k !== "actor")) return error(400, "invalid_body");
    const result = await org.mutate({
      actor,
      command: command as OrganizationCommand,
      key,
      requestId,
      expectedRevision,
      requestFingerprint: await tokenHash(
        canonical([
          request.method,
          url.pathname,
          Object.fromEntries(Object.entries(body).filter(([k]) => k !== "actor")),
          expectedRevision,
        ]),
      ),
    });
    if (!result.ok)
      return error(
        result.status,
        result.status === 403 || result.status === 404 ? "resource_denied" : result.reason,
        result.status === 403 || result.status === 404 ? 0 : result.policyRevision,
      );
    await org.repairDirectory();
    return reply({ ...result, requestId });
  } catch {
    return error(503, "authority_unavailable");
  }
}
