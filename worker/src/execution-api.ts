import type { IdentityCommand } from "../../shared/src/m1";
import { devMode, readExecutionActor, readNativeActor, sessionSecret } from "./auth";
import { canonical } from "./organization";
import { workspaceParent } from "./policy";
import { signPayload, tokenHash, verifyPayload } from "./session";

export function isExecutionPath(path: string) {
  return /^\/api\/m1\/(organizations\/[^/]+\/agents(?:\/[^/]+)?|workspaces\/[^/]+\/(?:grants\/[^/]+|executions)|executions\/[^/]+(?:\/(?:redemption|rotate))?)$/.test(
    path,
  );
}

/** Only native Persons can mutate managed identities. All secrets are one-response values. */
export async function handleExecutionApi(request: Request, url: URL, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const reply = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  const error = (status: number, reason: string, policyRevision = 0) =>
    reply(
      {
        error: {
          code: reason.startsWith("CODE_")
            ? reason
            : status === 403 || status === 404
              ? "RESOURCE_DENIED"
              : "REQUEST_FAILED",
          reason,
        },
        requestId,
        policyRevision,
      },
      status,
    );
  try {
    let parts: string[];
    try {
      parts = url.pathname.slice(8).split("/").map(decodeURIComponent);
    } catch {
      return error(400, "invalid_path");
    }
    const [collection, id = "", sub, target] = parts;
    const organizationId = collection === "organizations" && /^[0-9a-f-]{36}$/.test(id) ? id : workspaceParent(id);
    if (!organizationId) return error(404, "resource_denied");
    const org = env.ORGANIZATION.getByName(organizationId);
    if (request.headers.get("Authorization")?.startsWith("Bearer m1.")) {
      const actor = await readExecutionActor(request, env);
      if (!actor) return error(401, "invalid_credential");
      if (workspaceParent(actor.principalId) !== organizationId) return error(404, "resource_denied");
      if (request.method !== "GET" || collection !== "organizations" || sub !== "agents" || target) {
        const action =
          collection === "organizations"
            ? request.method === "POST"
              ? "principal.create"
              : "principal.update"
            : collection === "workspaces"
              ? sub === "grants"
                ? request.method === "PUT"
                  ? "grant.put"
                  : "grant.revoke"
                : "execution.start"
              : sub === "rotate"
                ? "execution.rotate"
                : sub === "redemption"
                  ? "execution.redeem"
                  : "execution.revoke";
        await org.auditExecutionDenial(request.headers.get("Authorization")?.slice(7).trim() ?? "", requestId, action);
        return error(403, "resource_denied");
      }
      const principal = await org.executionPrincipal(request.headers.get("Authorization")?.slice(7).trim() ?? "");
      return principal ? reply({ items: [principal], cursor: null, requestId }) : error(403, "resource_denied");
    }
    const actor = await readNativeActor(request, url, env);
    if (!actor) return error(401, "native_authentication_required");
    using metadata = await org.metadata(actor);
    if (!metadata && !(collection === "executions" && sub === "redemption")) return error(404, "resource_denied");
    if (request.method === "GET") {
      if (collection === "organizations" && sub === "agents" && !target) {
        const secret = sessionSecret(env, devMode(env, url));
        if (!secret) return error(503, "authority_unavailable");
        const scope = `${actor.personId}:${url.pathname}`;
        const raw = url.searchParams.get("cursor");
        const cursor = raw && raw.length <= 2048 ? await verifyPayload(secret, raw) : null;
        if (
          raw &&
          (cursor?.kind !== "m1-agent-cursor" ||
            cursor.scope !== scope ||
            typeof cursor.after !== "string" ||
            typeof cursor.exp !== "number" ||
            cursor.exp * 1000 <= Date.now())
        )
          return error(400, "invalid_cursor");
        const result = await org.identityCatalog(actor, typeof cursor?.after === "string" ? cursor.after : "");
        if (!result) return error(404, "resource_denied");
        return reply({
          ...result,
          next: undefined,
          cursor: result.next
            ? await signPayload(secret, {
                kind: "m1-agent-cursor",
                scope,
                after: result.next,
                exp: Math.floor(Date.now() / 1000) + 600,
              })
            : null,
          requestId,
        });
      }
      if (collection === "workspaces" && sub === "grants" && target) {
        const value = await org.identityGrant(actor, id, target);
        return value
          ? reply({ value, policyRevision: metadata?.policyRevision ?? 0, requestId })
          : error(404, "resource_denied");
      }
      return error(404, "resource_denied");
    }
    const rawKey = request.headers.get("Idempotency-Key") ?? "";
    if (!rawKey.trim() || rawKey.length > 128) return error(400, "idempotency_key_required");
    const raw = await request.text();
    if (raw.length > 16384) return error(400, "invalid_body");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(400, "invalid_body");
      body = parsed as Record<string, unknown>;
    } catch {
      return error(400, "invalid_body");
    }
    let expectedRevision: number | undefined;
    if (["PATCH", "PUT", "DELETE"].includes(request.method) || sub === "rotate") {
      const match = /^(?:"([0-9]+)"|([0-9]+))$/.exec(request.headers.get("If-Match") ?? "");
      expectedRevision = match ? Number(match[1] ?? match[2]) : undefined;
      if (!Number.isSafeInteger(expectedRevision)) return error(400, "revision_required");
    }
    let command: unknown;
    let fields: string[] = [];
    if (collection === "organizations" && sub === "agents") {
      if (request.method === "POST" && !target) {
        fields = ["sponsor", "displayName", "capabilities"];
        if (
          !body.sponsor ||
          typeof body.sponsor !== "object" ||
          Array.isArray(body.sponsor) ||
          Object.keys(body.sponsor).some((k) => k !== "kind" && k !== "id")
        )
          return error(400, "invalid_sponsor");
        command = {
          kind: "principal.create",
          sponsor: body.sponsor,
          displayName: body.displayName,
          capabilities: body.capabilities ?? [],
        };
      } else if (request.method === "PATCH" && target) {
        fields = ["displayName", "status"];
        if (
          !Object.keys(body).length ||
          (body.displayName !== undefined && typeof body.displayName !== "string") ||
          body.status === null
        )
          return error(400, "invalid_body");
        // Defaults are resolved by the authoritative mutation, not a stale HTTP read.
        command = { kind: "principal.update", principalId: target, displayName: body.displayName, status: body.status };
      }
    } else if (collection === "workspaces" && sub === "grants" && target) {
      if (request.method === "PUT") {
        fields = ["actions", "constraints", "expiresAt"];
        command = {
          kind: "grant.put",
          workspaceId: id,
          principalId: target,
          actions: body.actions,
          constraints: body.constraints ?? {},
          expiresAt: body.expiresAt,
        };
      } else if (request.method === "DELETE") command = { kind: "grant.revoke", workspaceId: id, principalId: target };
    } else if (collection === "workspaces" && sub === "executions" && request.method === "POST") {
      fields = ["principalId", "cli", "lifetimeMs", "constraints", "mode"];
      if (body.mode !== undefined && body.mode !== "direct" && body.mode !== "redemption")
        return error(400, "invalid_mode");
      command = { kind: "execution.start", workspaceId: id, ...body };
    } else if (collection === "executions") {
      if (sub === "redemption" && request.method === "POST") {
        fields = ["code"];
        if (typeof body.code !== "string" || body.code.length > 256) return error(400, "CODE_INVALID");
        command = { kind: "execution.redeem", executionId: id, code: body.code };
      } else if (sub === "rotate" && request.method === "POST") {
        fields = ["expectedGeneration", "lifetimeMs"];
        if (!Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1)
          return error(400, "generation_required");
        command = {
          kind: "execution.rotate",
          executionId: id,
          expectedGeneration: body.expectedGeneration,
          lifetimeMs: body.lifetimeMs,
        };
      } else if (!sub && request.method === "DELETE") command = { kind: "execution.revoke", executionId: id };
    }
    if (!command) return error(404, "resource_denied");
    if (Object.keys(body).some((k) => !fields.includes(k))) return error(400, "invalid_body");
    const result = await org.mutateIdentity({
      actor,
      command: command as IdentityCommand,
      key: await tokenHash(canonical([url.pathname, rawKey])),
      requestId,
      expectedRevision,
      requestFingerprint: await tokenHash(canonical([request.method, url.pathname, body, expectedRevision])),
    });
    if (!result.ok && sub === "redemption" && result.status === 404) return error(400, "CODE_INVALID");
    if (!result.ok)
      return error(
        result.status,
        result.status === 403 || result.status === 404 ? "resource_denied" : result.reason,
        !metadata || result.reason === "CODE_INVALID" || result.status === 403 || result.status === 404
          ? 0
          : result.policyRevision,
      );
    return reply({ ...result, requestId });
  } catch {
    return error(503, "authority_unavailable");
  }
}
