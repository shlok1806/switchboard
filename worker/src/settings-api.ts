// The Channel's settings routes (ADR 0044). One setting so far: the repo's own Langfuse
// project, which the Connector's costs tool reads.
//
//   GET    /api/settings/langfuse   the project as anyone may see it, and whether the caller may manage it
//   PUT    /api/settings/langfuse   the owner connects a project, or replaces it { host, publicKey, secretKey }
//   DELETE /api/settings/langfuse   the owner removes it
//
// Only a Person's session reaches these, never an Agent token or the Connector's token.
// The owner is an admin of the repo, asked of GitHub on each call. The secret key goes
// in and is never sent back: every answer is `connection(...)`, which has no key.

import type { LangfuseSettingsResponse } from "../../shared/src/index";
import { cleanLangfuseConnect, LANGFUSE_SETTINGS_PATH } from "../../shared/src/index";
import { sessionSecret } from "./auth";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";
import { connection, projectOf, sealSecretKey } from "./langfuse";

export type SettingsRoute = { kind: "langfuse"; method: "GET" | "PUT" | "DELETE" };

export function matchSettingsRoute(method: string, pathname: string): SettingsRoute | null {
  if (pathname !== LANGFUSE_SETTINGS_PATH) return null;
  return method === "GET" || method === "PUT" || method === "DELETE" ? { kind: "langfuse", method } : null;
}

const NOT_OWNER =
  "Only the Channel's owner, an admin of its repo on GitHub, connects, replaces or removes its Langfuse project.";

export async function handleSettingsRoute(
  route: SettingsRoute,
  request: Request,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
  context: { env: Env; repo: string; dev: boolean },
): Promise<Response> {
  const owner = await channel.isOwner(caller.person, context.dev);
  if (route.method === "GET") {
    const stored = await channel.langfuseProject();
    return json<LangfuseSettingsResponse>({
      langfuse: stored === null ? null : connection(stored),
      canManage: owner.ok && owner.owner,
    });
  }
  if (!owner.ok) return fail(503, owner.reason);
  if (!owner.owner) return fail(403, NOT_OWNER);

  if (route.method === "DELETE") {
    await channel.removeLangfuseProject();
    return json<LangfuseSettingsResponse>({ langfuse: null, canManage: true });
  }

  const secret = sessionSecret(context.env, context.dev);
  if (secret === null) return fail(503, "Sign-in is not set up: SESSION_SECRET is missing.");
  const body = cleanLangfuseConnect(await readJson(request));
  if (!body.ok) return fail(400, body.reason);
  const { host, publicKey, secretKey } = body.connect;
  // The keys are tried before they are kept, which also names the project for links.
  const project = await projectOf({ host, publicKey, secretKey });
  if (!project.ok) return fail(422, project.reason);
  const stored = {
    host,
    publicKey,
    secretSealed: await sealSecretKey(secret, context.repo, secretKey),
    project: project.project,
    connectedBy: caller.person,
    connectedAt: new Date().toISOString(),
  };
  await channel.setLangfuseProject(stored);
  return json<LangfuseSettingsResponse>({ langfuse: connection(stored), canManage: true });
}
