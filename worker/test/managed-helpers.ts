import { Channel } from "../src/channel";
import { OTHER_REPO } from "./client";

export const legacyBinding = {
  version: 1,
  generation: 0,
  workspace: null,
  operation: null,
  state: "unlinked",
};
export const linkedBinding = {
  version: 1,
  generation: 1,
  workspace: "managed-workspace",
  operation: "binding-operation",
  state: "linked",
};
/** No subsystem/storage exists: any access past a deny guard fails the test. */
export function bareChannel(
  binding: {
    version: number;
    generation: number;
    workspace: string | null;
    operation: string | null;
    state: string;
  } = linkedBinding,
): Channel {
  return Object.assign(Object.create(Channel.prototype) as Channel, {
    binding,
    staleClaims: { takeLostClaims: () => [] },
    relay: { takeDeliveries: () => [] },
    directives: { takeDirectives: () => [] },
  });
}
export function invoke(channel: Channel, name: string, ...args: unknown[]): unknown {
  const method = (channel as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
  if (!method) throw new Error(`Missing inventoried RPC ${name}`);
  return method.apply(channel, args);
}

/** Completed binding fixture, provisioned directly to isolate policy from GitHub coordination. */
export async function managedAuthorityFixture() {
  const { env, runInDurableObject } = await import("cloudflare:test");
  const organizationId = crypto.randomUUID();
  const { nativeIdentity } = await import("./m1-helpers");
  const { actor, token } = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "alice");
  // Exercise HTTP admission through the existing deployment allowlist too.
  const repo = OTHER_REPO;
  const org = env.ORGANIZATION.getByName(organizationId);
  await org.initialize(organizationId, "Managed", actor, "init");
  const result = await org.mutate({
    actor,
    key: "workspace",
    requestId: "workspace",
    command: { kind: "workspace.create", name: "Operations", description: "", acceptManager: true },
  });
  if (!result.ok || !("id" in result.value)) throw new Error("workspace missing");
  const workspaceId = result.value.id;
  const targetId = "alice/codex/session";
  const executionId = `${organizationId}:${crypto.randomUUID()}`;
  const recipient = { kind: "person" as const, personId: crypto.randomUUID(), githubId: "902" };
  await runInDurableObject(org, (_object, state) => {
    const aggregate = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
    );
    aggregate.workspaces[workspaceId].channel = repo;
    aggregate.members[recipient.personId] = {
      personId: recipient.personId,
      role: "member",
      status: "active",
      grantedBy: actor.personId,
      grantedAt: Date.now(),
    };
    aggregate.workspaceMembers[workspaceId][recipient.personId] = {
      personId: recipient.personId,
      workspaceId,
      role: "contributor",
      status: "active",
      grantedBy: actor.personId,
      grantedAt: Date.now(),
    };
    state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    state.storage.sql.exec(
      "INSERT INTO binding_operations VALUES(?,?,?)",
      "binding",
      "binding",
      JSON.stringify({
        id: "binding",
        actor,
        workspaceId,
        repo,
        mode: "bind",
        phase: "done",
        generation: 0,
        key: "binding",
      }),
    );
    state.storage.sql.exec(
      "INSERT INTO executions VALUES(?,?,?)",
      executionId,
      JSON.stringify({
        id: executionId,
        principalId: `${organizationId}:${crypto.randomUUID()}`,
        workspaceId,
        ownerPersonId: actor.personId,
        legacyAgentId: targetId,
        legacyChannel: repo,
        cli: "codex",
        startedAt: Date.now(),
        lastSeen: Date.now(),
        status: "active",
        credentialGeneration: 1,
      }),
      "{}",
    );
  });
  return { org, organizationId, workspaceId, actor, recipient, targetId, executionId, repo, token };
}
