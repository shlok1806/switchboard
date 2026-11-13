import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  MembershipInvitation,
  NativeOrganization,
  NativeResult,
  NativeWorkspace,
  OrganizationCommand,
  PersonActor,
} from "../../shared/src/m1";
import { decide } from "../src/policy";

const directory = () => env.IDENTITY_DIRECTORY.getByName("directory-v1");
let owner: PersonActor;
let bob: PersonActor;
let outsider: PersonActor;
let org: NativeOrganization;
let sequence = 0;
function value<T>(r: NativeResult<T>): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const stub = () => env.ORGANIZATION.getByName(org.id);
async function mutate(
  command: OrganizationCommand,
  actor = owner,
  key = `key-${++sequence}`,
  expectedRevision?: number,
) {
  return stub().mutate({ actor, command, key, requestId: `request-${sequence}`, expectedRevision });
}
async function invite(actor: PersonActor, role: "owner" | "admin" | "member" = "member") {
  const invitation = value(
    await mutate({ kind: "invitation.create", githubId: actor.githubId, organizationRole: role }),
  ) as MembershipInvitation;
  value(await mutate({ kind: "invitation.accept", invitationId: invitation.id }, actor));
  return invitation;
}
async function workspace(name = "Operations") {
  return value(
    await mutate({ kind: "workspace.create", name, description: "", acceptManager: true }),
  ) as NativeWorkspace;
}
async function revision() {
  return (await stub().metadata(owner))?.policyRevision;
}

beforeEach(async () => {
  await reset();
  sequence = 0;
  owner = (await directory().resolve("100", "owner")) as PersonActor;
  bob = (await directory().resolve("200", "bob")) as PersonActor;
  outsider = (await directory().resolve("300", "outsider")) as PersonActor;
  org = value(await directory().createOrganization(owner, "Org A", "create", "request-create"));
});

describe("native P1 storage and policy", () => {
  it("creates Org A and B and repo-free Operations and Finance", async () => {
    const b = value(await directory().createOrganization(outsider, "Org B", "create", "b"));
    expect(b.id).not.toBe(org.id);
    expect((await workspace()).organizationId).toBe(org.id);
    expect((await workspace("Finance")).id).toMatch(new RegExp(`^${org.id}:`));
    expect(value(await directory().createOrganization(owner, "Org A", "create", "retry")).id).toBe(org.id);
    expect(await directory().createOrganization(owner, "different", "create", "retry")).toMatchObject({
      ok: false,
      status: 409,
    });
  });
  it("creates explicit owner and creator manager memberships", async () => {
    const w = await workspace();
    await runInDurableObject(stub(), (_object, state) => {
      const row = state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate").one();
      const data = JSON.parse(row.body);
      expect(data.members[owner.personId]).toMatchObject({ role: "owner", status: "active" });
      expect(data.workspaceMembers[w.id][owner.personId]).toMatchObject({
        role: "manager",
        reason: "creator_accepted",
      });
    });
  });
  it("updates metadata only with current authority and revision", async () => {
    const c = { kind: "organization.rename", name: "New name" } as const;
    expect(await mutate(c, outsider, "foreign", await revision())).toMatchObject({ ok: false, status: 403 });
    expect(value(await mutate(c, owner, "rename", await revision()))).toMatchObject({ name: "New name" });
  });
  it("accepts only the exact invited numeric GitHub id", async () => {
    const i = value(
      await mutate({ kind: "invitation.create", githubId: bob.githubId, organizationRole: "member" }),
    ) as MembershipInvitation;
    expect(await stub().metadata(bob)).toBeNull();
    expect(await mutate({ kind: "invitation.accept", invitationId: i.id }, outsider)).toMatchObject({ ok: false });
    value(await mutate({ kind: "invitation.accept", invitationId: i.id }, bob));
    expect(await stub().metadata(bob)).toMatchObject({ id: org.id });
  });
  it("rejects expired and consumed invitations", async () => {
    const i = await invite(bob);
    expect(await mutate({ kind: "invitation.accept", invitationId: i.id }, bob)).toMatchObject({
      ok: false,
      status: 409,
    });
    const expired = value(
      await mutate({ kind: "invitation.create", githubId: outsider.githubId, organizationRole: "member" }),
    ) as MembershipInvitation;
    await runInDurableObject(stub(), (_object, state) => {
      const data = JSON.parse(state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate").one().body);
      data.invitations[expired.id].expiresAt = Date.now() - 1;
      state.storage.sql.exec("UPDATE aggregate SET body=?", JSON.stringify(data));
    });
    expect(await mutate({ kind: "invitation.accept", invitationId: expired.id }, outsider)).toMatchObject({
      ok: false,
      status: 409,
    });
  });
  it("requires audited explicit workspace grants", async () => {
    const w = await workspace();
    await invite(bob);
    expect(await stub().workspace(bob, w.id)).toBeNull();
    value(
      await mutate(
        {
          kind: "workspace.member",
          workspaceId: w.id,
          personId: bob.personId,
          role: "contributor",
          status: "active",
          reason: "Operations assignment",
        },
        owner,
        "grant",
        await revision(),
      ),
    );
    expect(await stub().workspace(bob, w.id)).toMatchObject({ id: w.id });
    expect(
      (await stub().auditRecords(owner))?.some((a) => a.action === "workspace.member" && a.outcome === "committed"),
    ).toBe(true);
  });
  it("supports one Person in multiple organizations", async () => {
    value(await directory().createOrganization(owner, "Org B", "second", "b"));
    expect((await directory().organizations(owner)).organizations).toHaveLength(2);
  });
  it("denies nonmember direct ID GET without metadata", async () => {
    expect(await stub().metadata(outsider)).toBeNull();
    expect(await stub().workspace(outsider, (await workspace()).id, true)).toBeNull();
  });
  it("rejects foreign-org resource IDs", async () => {
    const b = value(await directory().createOrganization(outsider, "Org B", "b", "b"));
    const foreign = `${b.id}:${crypto.randomUUID()}`;
    expect(
      await mutate(
        { kind: "workspace.update", workspaceId: foreign, name: "leak", description: "", status: "active" },
        owner,
        "foreign",
        await revision(),
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });
  it("prevents cross-org listing and cursor leakage", async () => {
    await directory().indexCandidate(outsider.personId, org.id);
    expect((await directory().organizations(outsider)).organizations).toEqual([]);
    expect((await directory().organizations(outsider, org.id)).organizations).toEqual([]);
  });
  it("denies revoked membership despite orphan workspace rows", async () => {
    const w = await workspace();
    await invite(bob);
    value(
      await mutate(
        {
          kind: "workspace.member",
          workspaceId: w.id,
          personId: bob.personId,
          role: "viewer",
          status: "active",
          reason: "grant",
        },
        owner,
        "grant",
        await revision(),
      ),
    );
    value(
      await mutate(
        { kind: "organization.member", personId: bob.personId, role: "member", status: "revoked" },
        owner,
        "revoke",
        await revision(),
      ),
    );
    expect(await stub().workspace(bob, w.id)).toBeNull();
  });
  it("denies unknown actors actions and resources", () => {
    const resource = { kind: "organization", organizationId: org.id, id: org.id } as const;
    const ctx = {
      available: true,
      organizationId: org.id,
      policyRevision: 1,
      organizationMembership: {
        personId: owner.personId,
        role: "owner",
        status: "active",
        grantedBy: owner.personId,
        grantedAt: 0,
      },
    } as const;
    expect(decide({ kind: "agent" }, "organization.manage", resource, ctx).decision).toBe("deny");
    expect(decide(owner, "task.read", resource, ctx).decision).toBe("deny");
    expect(decide(owner, "organization.manage", { ...resource, id: "foreign" }, ctx).decision).toBe("deny");
    expect(decide(owner, "organization.manage", resource, { ...ctx, available: false }).decision).toBe("deny");
    expect(
      decide(owner, "organization.manage", resource, {
        ...ctx,
        organizationMembership: { ...ctx.organizationMembership, role: "unknown" as "owner" },
      }).decision,
    ).toBe("deny");
  });
  it("does not infer workspace access from GitHub collaboration", async () => {
    const w = await workspace();
    await invite(bob);
    expect(await stub().workspace(bob, w.id)).toBeNull();
    expect(
      await mutate({ kind: "workspace.create", name: "no", description: "", acceptManager: true }, bob),
    ).toMatchObject({ ok: false });
  });
  it("allows admin metadata without shared-content or private-session access", async () => {
    const w = await workspace();
    await invite(bob, "admin");
    expect(await stub().workspace(bob, w.id, true)).toMatchObject({ id: w.id });
    expect(await stub().workspace(bob, w.id)).toBeNull();
    expect(
      decide(
        bob,
        "agent.private_transcript.read",
        { kind: "workspace", organizationId: org.id, id: w.id },
        {
          available: true,
          organizationId: org.id,
          policyRevision: 1,
          workspaceActive: true,
          organizationMembership: {
            personId: bob.personId,
            role: "admin",
            status: "active",
            grantedBy: owner.personId,
            grantedAt: 0,
          },
        },
      ).decision,
    ).toBe("deny");
  });
  it("recomputes demoted admin authority while retaining explicit membership", async () => {
    const w = await workspace();
    await invite(bob, "admin");
    value(
      await mutate(
        {
          kind: "workspace.member",
          workspaceId: w.id,
          personId: bob.personId,
          role: "viewer",
          status: "active",
          reason: "explicit",
        },
        owner,
        "grant",
        await revision(),
      ),
    );
    value(
      await mutate(
        { kind: "organization.member", personId: bob.personId, role: "member", status: "active" },
        owner,
        "demote",
        await revision(),
      ),
    );
    expect(await stub().workspace(bob, w.id)).toMatchObject({ id: w.id });
    expect(
      await mutate(
        { kind: "workspace.update", workspaceId: w.id, name: "no", description: "", status: "active" },
        bob,
        "no",
        await revision(),
      ),
    ).toMatchObject({ ok: false });
  });
  it("refuses last-owner removal and demotion", async () => {
    for (const status of ["active", "revoked"] as const)
      expect(
        await mutate(
          { kind: "organization.member", personId: owner.personId, role: "member", status },
          owner,
          status,
          await revision(),
        ),
      ).toMatchObject({ ok: false, reason: "last_owner" });
  });
  it("refuses conflicting invitation roles without silently demoting an owner", async () => {
    const i = value(
      await mutate({ kind: "invitation.create", githubId: owner.githubId, organizationRole: "member" }),
    ) as MembershipInvitation;
    expect(await mutate({ kind: "invitation.accept", invitationId: i.id })).toMatchObject({
      ok: false,
      reason: "membership_role_conflict",
    });
    value(await mutate({ kind: "organization.rename", name: "Still owner" }, owner, "owner-check", await revision()));
  });
  it("rolls back state revision audit and replay together", async () => {
    const before = await revision();
    await runInDurableObject(stub(), (_object, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_replay BEFORE INSERT ON replay BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
      );
    });
    await expect(
      mutate({ kind: "organization.rename", name: "must rollback" }, owner, "rollback", before),
    ).rejects.toThrow();
    expect(await stub().metadata(owner)).toMatchObject({ name: "Org A", policyRevision: before });
    expect((await stub().auditRecords(owner))?.filter((a) => a.action === "organization.rename")).toEqual([]);
    await runInDurableObject(stub(), (_object, state) => {
      expect(state.storage.sql.exec("SELECT * FROM replay").toArray()).toEqual([]);
      state.storage.sql.exec("DROP TRIGGER fail_replay");
    });
    expect((await mutate({ kind: "organization.rename", name: "must rollback" }, owner, "rollback", before)).ok).toBe(
      true,
    );
  });
  it("replays identical keys and returns 409 for changed bodies", async () => {
    const command = { kind: "workspace.create", name: "Operations", description: "", acceptManager: true } as const;
    const first = await mutate(command, owner, "same");
    expect(await mutate(command, owner, "same")).toEqual(first);
    expect(await mutate({ ...command, name: "changed" }, owner, "same")).toMatchObject({ ok: false, status: 409 });
  });
  it("rejects stale If-Match", async () => {
    expect(await mutate({ kind: "organization.rename", name: "no" }, owner, "stale", 0)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await mutate({ kind: "organization.rename", name: "no" })).toMatchObject({ ok: false, status: 400 });
  });
  it("scopes redacted audit reads to organization admins", async () => {
    await invite(bob);
    expect(await stub().auditRecords(bob)).toBeNull();
    await mutate({ kind: "organization.rename", name: "SENSITIVE_BODY" }, outsider, "deny", await revision());
    expect(JSON.stringify(await stub().auditRecords(owner))).not.toContain("SENSITIVE_BODY");
    expect((await stub().auditRecords(owner))?.some((a) => a.decision === "deny")).toBe(true);
  });
  it("never authorizes from stale directory entries and repairs missing index entries", async () => {
    await invite(bob);
    expect((await directory().organizations(bob)).organizations).toEqual([]);
    await stub().repairDirectory();
    expect((await directory().organizations(bob)).organizations).toHaveLength(1);
    value(
      await mutate(
        { kind: "organization.member", personId: bob.personId, role: "member", status: "revoked" },
        owner,
        "revoke",
        await revision(),
      ),
    );
    expect((await directory().organizations(bob)).organizations).toEqual([]);
  });
  it("routes invitations to the exact identity and preserves UUID across login changes", async () => {
    const i = value(
      await mutate({ kind: "invitation.create", githubId: bob.githubId, organizationRole: "member" }),
    ) as MembershipInvitation;
    await stub().repairDirectory();
    expect(await directory().invitationOrganization(bob, i.id)).toBe(org.id);
    expect(await directory().invitationOrganization(outsider, i.id)).toBeNull();
    expect(await directory().resolve(bob.githubId, "new-login")).toEqual(bob);
  });
});

describe("P1 adversarial lifecycle cases", () => {
  it("denies replay after authority revocation", async () => {
    await invite(bob, "admin");
    const command = { kind: "workspace.create", name: "Bob", description: "", acceptManager: true } as const;
    value(await mutate(command, bob, "replay"));
    value(
      await mutate(
        { kind: "organization.member", personId: bob.personId, role: "member", status: "revoked" },
        owner,
        "revoke",
        await revision(),
      ),
    );
    expect(await mutate(command, bob, "replay")).toMatchObject({ ok: false, status: 403 });
  });
  it("refuses admin owner escalation and invitations from demoted inviters", async () => {
    await invite(bob, "admin");
    expect(
      await mutate(
        { kind: "organization.member", personId: bob.personId, role: "owner", status: "active" },
        bob,
        "escalate",
        await revision(),
      ),
    ).toMatchObject({ ok: false, reason: "owner_required" });
    const i = value(
      await mutate({ kind: "invitation.create", githubId: outsider.githubId, organizationRole: "admin" }, bob),
    ) as MembershipInvitation;
    value(
      await mutate(
        { kind: "organization.member", personId: bob.personId, role: "member", status: "active" },
        owner,
        "demote",
        await revision(),
      ),
    );
    expect(await mutate({ kind: "invitation.accept", invitationId: i.id }, outsider)).toMatchObject({
      ok: false,
      reason: "inviter_authority_lost",
    });
    expect(await stub().metadata(outsider)).toBeNull();
  });
  it("accepts explicit workspace invitations atomically", async () => {
    const w = await workspace();
    const i = value(
      await mutate({
        kind: "invitation.create",
        githubId: bob.githubId,
        organizationRole: "member",
        workspaceId: w.id,
        workspaceRole: "contributor",
      }),
    ) as MembershipInvitation;
    expect(await stub().workspace(bob, w.id)).toBeNull();
    const accepted = await mutate({ kind: "invitation.accept", invitationId: i.id }, bob, "accept");
    value(accepted);
    expect(await mutate({ kind: "invitation.accept", invitationId: i.id }, bob, "accept")).toEqual(accepted);
    expect(await stub().workspace(bob, w.id)).toMatchObject({ id: w.id });
  });
  it("expires replay records after 24 hours and bounds audit retention cleanup", async () => {
    const command = { kind: "workspace.create", name: "Operations", description: "", acceptManager: true } as const;
    const first = value(await mutate(command, owner, "expires"));
    await runInDurableObject(stub(), (_object, state) => {
      state.storage.sql.exec("UPDATE replay SET expires=?", Date.now() - 1);
      state.storage.sql.exec("UPDATE audit SET timestamp=?", Date.now() - 91 * 86_400_000);
    });
    expect(await stub().auditRecords(owner)).toEqual([]);
    const second = value(await mutate(command, owner, "expires"));
    expect(second).not.toEqual(first);
    await runInDurableObject(stub(), (_object, state) => {
      expect(state.storage.sql.exec("SELECT id FROM audit").toArray()).toHaveLength(1);
    });
  });
  it("aggregates bounded redacted denial records", async () => {
    const command = { kind: "organization.rename", name: "not retained" } as const;
    await mutate(command, outsider, "deny-1", await revision());
    await mutate(command, outsider, "deny-2", await revision());
    const records = (await stub().auditRecords(owner))?.filter((a) => a.decision === "deny");
    expect(records).toHaveLength(1);
    expect(records?.[0]).toMatchObject({ count: 2, reason: "action_denied" });
    expect(JSON.stringify(records)).not.toContain("not retained");
  });
  it("uses exact P1 role action sets and refuses all future content actions", () => {
    const workspaceId = `${org.id}:${crypto.randomUUID()}`;
    const resource = { kind: "workspace", organizationId: org.id, id: workspaceId } as const;
    for (const role of ["manager", "contributor", "viewer"] as const) {
      const ctx = {
        available: true,
        organizationId: org.id,
        policyRevision: 1,
        workspaceActive: true,
        organizationMembership: {
          personId: bob.personId,
          role: "member",
          status: "active",
          grantedBy: owner.personId,
          grantedAt: 0,
        },
        workspaceMembership: {
          personId: bob.personId,
          workspaceId,
          role,
          status: "active",
          grantedBy: owner.personId,
          grantedAt: 0,
          reason: "explicit",
        },
      } as const;
      expect(decide(bob, "workspace.read", resource, ctx).decision).toBe("allow");
      for (const action of ["workspace.manage", "workspace.member.manage"])
        expect(decide(bob, action, resource, ctx).decision).toBe(role === "manager" ? "allow" : "deny");
      for (const action of [
        "organization.manage",
        "agent.register",
        "task.read",
        "channel.subscribe",
        "agent.directive.send",
        "agent.private_screen.read",
      ])
        expect(decide(bob, action, resource, ctx).decision).toBe("deny");
    }
  });
});
