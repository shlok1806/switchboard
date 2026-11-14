import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentPrincipal,
  IdentityCommand,
  IdentityValue,
  NativeOrganization,
  NativeResult,
  NativeWorkspace,
  OrganizationCommand,
  PersonActor,
} from "../../shared/src/m1";
import {
  credentialExpiry,
  DAY,
  equalDigest,
  HOUR,
  parseCredential,
  prepareCredential,
  secretDigest,
} from "../src/executions";
import { decide } from "../src/policy";
import { CONTRIBUTOR_ACTIONS } from "../src/principals";

let owner: PersonActor;
let org: NativeOrganization;
let workspace: NativeWorkspace;
let principal: AgentPrincipal;
let sequence = 0;
const stub = () => env.ORGANIZATION.getByName(org.id);
function required<T>(input: T | null | undefined): T {
  if (input == null) throw new Error("missing fixture value");
  return input;
}
function value<T>(result: NativeResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
async function revision() {
  return required(await stub().metadata(owner)).policyRevision;
}
async function native(command: OrganizationCommand, actor = owner) {
  return stub().mutate({
    actor,
    command,
    key: `native-${++sequence}`,
    requestId: "fixture",
    expectedRevision: await revision(),
  });
}
async function mutate(command: IdentityCommand, actor = owner, key = `identity-${++sequence}`) {
  return stub().mutateIdentity({ actor, command, key, requestId: "fixture", expectedRevision: await revision() });
}
async function start(lifetimeMs?: number): Promise<IdentityValue> {
  return value(
    await mutate({
      kind: "execution.start",
      principalId: principal.id,
      workspaceId: workspace.id,
      cli: "codex",
      lifetimeMs,
    }),
  );
}
async function grant(expiresAt = Date.now() + 2 * DAY) {
  return mutate({
    kind: "grant.put",
    principalId: principal.id,
    workspaceId: workspace.id,
    actions: ["task.read", "task.claim", "channel.update.write"],
    constraints: {},
    expiresAt,
  });
}
beforeEach(async () => {
  await reset();
  sequence = 0;
  owner = (await env.IDENTITY_DIRECTORY.getByName("directory-v1").resolve("100", "owner")) as PersonActor;
  org = value(
    await env.IDENTITY_DIRECTORY.getByName("directory-v1").createOrganization(owner, "Org", "create", "fixture"),
  );
  workspace = value(
    await native({ kind: "workspace.create", name: "Operations", description: "", acceptManager: true }),
  ) as NativeWorkspace;
  value(await mutate({ kind: "identity.policy", actions: CONTRIBUTOR_ACTIONS }));
  value(await mutate({ kind: "identity.policy", workspaceId: workspace.id, actions: CONTRIBUTOR_ACTIONS }));
  principal = required(
    value(
      await mutate({
        kind: "principal.create",
        sponsor: { kind: "person", id: owner.personId },
        displayName: "ops-helper",
        capabilities: ["admin", "agent.private_screen.read"],
      }),
    ).principal,
  );
  value(await grant());
});

describe("scoped identity domain", () => {
  it("attributes two distinct executions and credentials to one stable principal", async () => {
    const a = await start(),
      b = await start();
    expect(required(a.execution).principalId).toBe(principal.id);
    expect(required(b.execution).principalId).toBe(principal.id);
    expect(required(a.execution).id).not.toBe(required(b.execution).id);
    expect(required(a.credential).id).not.toBe(required(b.credential).id);
    expect(a.secret).not.toBe(b.secret);
    expect(await stub().verifyExecution(required(a.secret))).toMatchObject({
      principalId: principal.id,
      executionId: required(a.execution).id,
      workspaceId: workspace.id,
    });
    expect(await stub().verifyExecution(required(b.secret))).toMatchObject({ executionId: required(b.execution).id });
    await runInDurableObject(stub(), (_object, state) => {
      const rows = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM execution_credentials")
        .toArray()
        .map((r) => JSON.parse(r.body));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.digest.length === 32 && !r.secret)).toBe(true);
    });
  });
  it("uses server time with one hour default and exact expiry denial", async () => {
    const a = await start();
    expect(required(a.credential).expiresAt - required(a.execution).startedAt).toBe(HOUR);
    await runInDurableObject(stub(), async (object, state) => {
      const saved = Date.now;
      Date.now = () => required(a.credential).expiresAt;
      try {
        expect(await object.verifyExecution(required(a.secret))).toBeNull();
      } finally {
        Date.now = saved;
      }
      expect(state.storage.sql.exec("SELECT id FROM execution_credentials").toArray()).toHaveLength(1);
    });
  });
  it("caps execution lifetime at 24 hours and grant expiry", async () => {
    const maximum = await start(DAY);
    expect(required(maximum.credential).expiresAt - required(maximum.execution).startedAt).toBe(DAY);
    expect(
      await mutate({
        kind: "execution.start",
        principalId: principal.id,
        workspaceId: workspace.id,
        cli: "codex",
        lifetimeMs: DAY + 1,
      }),
    ).toMatchObject({ ok: false });
    for (const lifetime of [0, -1, Infinity, NaN, 1.5]) expect(credentialExpiry(100, lifetime, DAY)).toBeNull();
    expect(credentialExpiry(100, undefined, 100)).toBeNull();
    const expiry = Date.now() + 10_000;
    value(await grant(expiry));
    expect(required((await start()).credential).expiresAt).toBe(expiry);
  });
  it("atomically rotates once and immediately rejects the old generation", async () => {
    const a = await start();
    const expectedRevision = await revision();
    const command = { kind: "execution.rotate", executionId: required(a.execution).id, expectedGeneration: 1 } as const;
    const results = await Promise.all(
      ["rotate-a", "rotate-b"].map((key) =>
        stub().mutateIdentity({ actor: owner, key, requestId: "rotate", expectedRevision, command }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const b = value(required(results.find((r) => r.ok)));
    expect(required(b.execution).credentialGeneration).toBe(2);
    expect(await stub().verifyExecution(required(a.secret))).toBeNull();
    expect(await stub().verifyExecution(required(b.secret))).toMatchObject({ executionId: required(a.execution).id });
    expect(await mutate(command)).toMatchObject({ ok: false, status: 409 });
  });
  it("denies on execution revoke principal disable sponsor removal demotion and grant revoke", async () => {
    const a = await start();
    value(await mutate({ kind: "execution.revoke", executionId: required(a.execution).id }));
    expect(await stub().verifyExecution(required(a.secret))).toBeNull();
    const b = await start();
    value(
      await mutate({
        kind: "principal.update",
        principalId: principal.id,
        displayName: principal.displayName,
        status: "disabled",
      }),
    );
    expect(await stub().verifyExecution(required(b.secret))).toBeNull();
    value(
      await mutate({
        kind: "principal.update",
        principalId: principal.id,
        displayName: principal.displayName,
        status: "active",
      }),
    );
    expect(await stub().verifyExecution(required(b.secret))).not.toBeNull();
    // Recompute sponsor scope at use: a viewer cannot keep delegated claim/write scope.
    value(
      await native({
        kind: "workspace.member",
        workspaceId: workspace.id,
        personId: owner.personId,
        role: "viewer",
        status: "active",
        reason: "demote",
      }),
    );
    const narrowed = await stub().verifyExecution(required(b.secret));
    expect(narrowed?.actions).toEqual(["task.read"]);
    expect(
      decide(
        narrowed,
        "task.claim",
        { kind: "workspace", organizationId: org.id, id: workspace.id },
        {
          available: true,
          organizationId: org.id,
          policyRevision: await revision(),
          workspaceActive: true,
          verifiedExecution: narrowed ?? undefined,
        },
      ).decision,
    ).toBe("deny");
    value(
      await native({
        kind: "workspace.member",
        workspaceId: workspace.id,
        personId: owner.personId,
        role: "manager",
        status: "revoked",
        reason: "remove",
      }),
    );
    expect(await stub().verifyExecution(required(b.secret))).toBeNull();
    value(
      await native({
        kind: "workspace.member",
        workspaceId: workspace.id,
        personId: owner.personId,
        role: "manager",
        status: "active",
        reason: "restore",
      }),
    );
    value(await mutate({ kind: "grant.revoke", principalId: principal.id, workspaceId: workspace.id }));
    expect(await stub().verifyExecution(required(b.secret))).toBeNull();
  });
  it("rejects grants beyond grantor authority including Bob delegating what Bob lacks", async () => {
    const bob = (await env.IDENTITY_DIRECTORY.getByName("directory-v1").resolve("200", "bob")) as PersonActor;
    const invitation = value(
      await native({ kind: "invitation.create", githubId: bob.githubId, organizationRole: "member" }),
    ) as { id: string };
    value(await native({ kind: "invitation.accept", invitationId: invitation.id }, bob));
    value(
      await native({
        kind: "workspace.member",
        workspaceId: workspace.id,
        personId: bob.personId,
        role: "contributor",
        status: "active",
        reason: "explicit",
      }),
    );
    const command = {
      kind: "grant.put",
      principalId: principal.id,
      workspaceId: workspace.id,
      actions: ["workspace.member.manage"],
      constraints: {},
      expiresAt: Date.now() + HOUR,
    } as const;
    expect(await mutate({ ...command, actions: [...command.actions] }, bob)).toMatchObject({ ok: false, status: 403 });
    expect(await mutate({ ...command, actions: [...command.actions] })).toMatchObject({ ok: false, status: 403 });
    value(await mutate({ kind: "identity.policy", workspaceId: workspace.id, actions: ["task.read"] }));
    expect(await grant()).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects wrong length malformed and garbage secrets", async () => {
    const a = await start();
    expect(parseCredential(required(a.secret))).not.toBeNull();
    const prefix = required(a.secret).split(".").slice(0, 3).join(".");
    for (const secret of [
      "",
      "a".repeat(42),
      "a".repeat(44),
      "!".repeat(43),
      "_".repeat(43),
      "a.b",
      `${"a".repeat(43)}=`,
    ]) {
      expect(parseCredential(`${prefix}.${secret}`)).toBeNull();
      expect(await stub().verifyExecution(`${prefix}.${secret}`)).toBeNull();
    }
    expect(await stub().verifyExecution(`${prefix}.${"A".repeat(43)}`)).toBeNull();
    const prepared = await prepareCredential(org.id);
    expect(
      equalDigest(
        await secretDigest(required(parseCredential(prepared.token)).secret),
        new Uint8Array(prepared.digest),
      ),
    ).toBe(true);
    expect(equalDigest(new Uint8Array(31), new Uint8Array(32))).toBe(false);
    expect(equalDigest(new Uint8Array(32), new Uint8Array(32).fill(1))).toBe(false);
  });
  it("never derives authority from declared capabilities or admin private access", async () => {
    for (const action of [
      "agent.private_transcript.read",
      "agent.private_screen.read",
      "agent.directive.send",
      "agent.handoff.cross_owner",
      "agent.execution.start",
    ]) {
      expect(
        await mutate({
          kind: "grant.put",
          principalId: principal.id,
          workspaceId: workspace.id,
          actions: [action],
          constraints: {},
          expiresAt: Date.now() + HOUR,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(
      decide(
        owner,
        "agent.private_screen.read",
        { kind: "workspace", organizationId: org.id, id: workspace.id },
        {
          available: true,
          organizationId: org.id,
          policyRevision: 1,
          workspaceActive: true,
          organizationMembership: {
            personId: owner.personId,
            role: "owner",
            status: "active",
            grantedBy: owner.personId,
            grantedAt: 1,
          },
        },
      ).decision,
    ).toBe("deny");
    expect(
      await mutate({
        kind: "grant.put",
        principalId: principal.id,
        workspaceId: workspace.id,
        actions: ["task.read"],
        constraints: { unknown: true } as never,
        expiresAt: Date.now() + HOUR,
      }),
    ).toMatchObject({ ok: false });
  });
  it("denies organization offboarding and requires explicit organization sponsorship ceiling", async () => {
    const sponsor = (await env.IDENTITY_DIRECTORY.getByName("directory-v1").resolve("400", "sponsor")) as PersonActor;
    const invitation = value(
      await native({ kind: "invitation.create", githubId: sponsor.githubId, organizationRole: "member" }),
    ) as { id: string };
    value(await native({ kind: "invitation.accept", invitationId: invitation.id }, sponsor));
    value(
      await native({
        kind: "workspace.member",
        workspaceId: workspace.id,
        personId: sponsor.personId,
        role: "manager",
        status: "active",
        reason: "explicit",
      }),
    );
    const p = required(
      value(
        await mutate(
          {
            kind: "principal.create",
            sponsor: { kind: "person", id: sponsor.personId },
            displayName: "sponsored",
            capabilities: [],
          },
          sponsor,
        ),
      ).principal,
    );
    value(
      await mutate(
        {
          kind: "grant.put",
          principalId: p.id,
          workspaceId: workspace.id,
          actions: ["task.read"],
          constraints: {},
          expiresAt: Date.now() + HOUR,
        },
        sponsor,
      ),
    );
    const a = value(
      await mutate({ kind: "execution.start", principalId: p.id, workspaceId: workspace.id, cli: "codex" }, sponsor),
    );
    expect(await stub().verifyExecution(required(a.secret))).not.toBeNull();
    value(await native({ kind: "organization.member", personId: sponsor.personId, role: "member", status: "revoked" }));
    expect(await stub().verifyExecution(required(a.secret))).toBeNull();
    expect(
      await mutate(
        {
          kind: "principal.create",
          sponsor: { kind: "organization", id: org.id },
          displayName: "forbidden",
          capabilities: [],
        },
        sponsor,
      ),
    ).toMatchObject({ ok: false });
    const organizational = required(
      value(
        await mutate({
          kind: "principal.create",
          sponsor: { kind: "organization", id: org.id },
          displayName: "org helper",
          capabilities: [],
        }),
      ).principal,
    );
    expect(
      await mutate({
        kind: "execution.start",
        principalId: organizational.id,
        workspaceId: workspace.id,
        cli: "codex",
      }),
    ).toMatchObject({ ok: false });
    value(
      await mutate({
        kind: "grant.put",
        principalId: organizational.id,
        workspaceId: workspace.id,
        actions: ["task.read"],
        constraints: {},
        expiresAt: Date.now() + HOUR,
      }),
    );
    const b = value(
      await mutate({
        kind: "execution.start",
        principalId: organizational.id,
        workspaceId: workspace.id,
        cli: "codex",
      }),
    );
    expect(await stub().verifyExecution(required(b.secret))).not.toBeNull();
    value(await mutate({ kind: "identity.policy", actions: [] }));
    expect(await stub().verifyExecution(required(b.secret))).toBeNull();
  });
  it("denies admin start without workspace authority and never accepts an execution lifecycle actor", async () => {
    const a = await start();
    const verified = await stub().verifyExecution(required(a.secret));
    for (const action of ["agent.grant.manage", "agent.execution.start", "agent.execution.revoke", "agent.register"]) {
      expect(
        decide(
          verified,
          action,
          { kind: "workspace", organizationId: org.id, id: workspace.id },
          {
            available: true,
            organizationId: org.id,
            policyRevision: 1,
            workspaceActive: true,
            verifiedExecution: verified ?? undefined,
          },
        ).decision,
      ).toBe("deny");
    }
    expect(
      await mutate({ kind: "execution.revoke", executionId: required(a.execution).id }, verified as never),
    ).toMatchObject({ ok: false });
    expect(
      (await stub().auditRecords(owner))?.some(
        (record) =>
          record.decision === "deny" &&
          record.actor.kind === "execution" &&
          record.actor.executionId === a.execution?.id,
      ),
    ).toBe(true);
    value(
      await native({
        kind: "workspace.member",
        workspaceId: workspace.id,
        personId: owner.personId,
        role: "contributor",
        status: "active",
        reason: "explicit demotion",
      }),
    );
    expect(
      await mutate({ kind: "execution.start", principalId: principal.id, workspaceId: workspace.id, cli: "codex" }),
    ).toMatchObject({ ok: false, reason: "start_denied" });
  });
  it("narrows execution actions without allowing foreign resources or invented constraints", async () => {
    const a = value(
      await mutate({
        kind: "execution.start",
        principalId: principal.id,
        workspaceId: workspace.id,
        cli: "codex",
        constraints: { actions: ["task.read"] },
      }),
    );
    const verified = required(await stub().verifyExecution(required(a.secret)));
    expect(verified.actions).toEqual(["task.read"]);
    const resource = { kind: "workspace", organizationId: org.id, id: workspace.id } as const;
    const context = {
      available: true,
      organizationId: org.id,
      policyRevision: await revision(),
      workspaceActive: true,
      verifiedExecution: verified,
    };
    expect(decide(verified, "task.read", resource, context).decision).toBe("allow");
    expect(decide(verified, "task.claim", resource, context).decision).toBe("deny");
    expect(
      decide(verified, "task.read", { ...resource, id: `${org.id}:${crypto.randomUUID()}` }, context).decision,
    ).toBe("deny");
    expect(decide(verified, "task.read", resource, { ...context, available: false }).decision).toBe("deny");
    expect(
      await mutate({
        kind: "execution.start",
        principalId: principal.id,
        workspaceId: workspace.id,
        cli: "codex",
        constraints: { private: true } as never,
      }),
    ).toMatchObject({ ok: false });
    // Existing P1 decision contexts deliberately stay closed to P2 actions.
    const personContext = {
      ...context,
      verifiedExecution: undefined,
      organizationMembership: {
        personId: owner.personId,
        role: "owner",
        status: "active",
        grantedBy: owner.personId,
        grantedAt: 0,
      },
      workspaceMembership: {
        personId: owner.personId,
        workspaceId: workspace.id,
        role: "manager",
        status: "active",
        grantedBy: owner.personId,
        grantedAt: 0,
        reason: "fixture",
      },
    } as const;
    expect(decide(owner, "agent.register", resource, personContext).decision).toBe("deny");
    expect(decide(owner, "agent.register", resource, { ...personContext, identityPolicy: true }).decision).toBe(
      "allow",
    );
  });
  it("cleans expired redemption tombstones in bounded batches without deleting retained hashes", async () => {
    await runInDurableObject(stub(), (_object, state) => {
      for (let index = 0; index < 102; index++)
        state.storage.sql.exec(
          "INSERT INTO redemption_codes VALUES(?,?,?)",
          index.toString(16).padStart(64, "0"),
          "{}",
          index === 101 ? Date.now() + DAY : Date.now() - 1,
        );
    });
    value(await mutate({ kind: "identity.policy", actions: CONTRIBUTOR_ACTIONS }));
    await runInDurableObject(stub(), (_object, state) => {
      const rows = state.storage.sql
        .exec<{ digest: string; retain_until: number }>("SELECT digest,retain_until FROM redemption_codes")
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.retain_until > Date.now())).toHaveLength(1);
      expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.digest))).toBe(true);
    });
  });
  it("replays only metadata and rolls back identity audit revision and replay together", async () => {
    const command = {
      kind: "execution.start",
      principalId: principal.id,
      workspaceId: workspace.id,
      cli: "codex",
    } as const;
    const input = { actor: owner, command, key: "replay", requestId: "fixture", expectedRevision: await revision() };
    const a = value(await stub().mutateIdentity(input));
    const replay = value(await stub().mutateIdentity(input));
    expect(replay.secret).toBeUndefined();
    expect(replay.execution).toEqual(a.execution);
    expect(await stub().mutateIdentity({ ...input, command: { ...command, cli: "changed" } })).toMatchObject({
      ok: false,
      status: 409,
    });
    await runInDurableObject(stub(), (_object, state) => {
      for (const table of [
        "aggregate",
        "replay",
        "audit",
        "execution_credentials",
        "principals",
        "executions",
        "grants",
      ]) {
        const data = JSON.stringify(state.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
        expect(data.includes(required(a.secret))).toBe(false);
        expect(data.includes(required(parseCredential(required(a.secret))).secret)).toBe(false);
      }
      state.storage.sql.exec(
        "CREATE TRIGGER fail_identity_replay BEFORE INSERT ON replay BEGIN SELECT RAISE(ABORT, 'identity rollback'); END",
      );
    });
    const before = await revision();
    await runInDurableObject(stub(), async (object, state) => {
      const audits = state.storage.sql.exec("SELECT id FROM audit").toArray().length;
      await expect(object.mutateIdentity({ ...input, key: "rollback", expectedRevision: before })).rejects.toThrow(
        "identity rollback",
      );
      expect(state.storage.sql.exec("SELECT id FROM executions").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT id FROM execution_credentials").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT id FROM audit").toArray()).toHaveLength(audits);
      state.storage.sql.exec("DROP TRIGGER fail_identity_replay");
    });
    expect(await revision()).toBe(before);
    expect(await stub().verifyExecution(required(a.secret))).not.toBeNull();
  });
});
