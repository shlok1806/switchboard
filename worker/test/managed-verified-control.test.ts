import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeIdentity } from "./m1-helpers";
import { b2Request, denyB2 } from "./managed-b2a-cases";
import { queryDenials } from "./managed-query-cases";
import { verifiedRegistrationFixture } from "./managed-verified-registration";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await verifiedRegistrationFixture();
  const bob = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "bob");
  await runInDurableObject(f.org, (_object, state) => {
    const aggregate = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
    );
    aggregate.members[bob.actor.personId] = {
      ...aggregate.members[f.recipient.personId],
      personId: bob.actor.personId,
    };
    aggregate.workspaceMembers[f.workspaceId][bob.actor.personId] = {
      ...aggregate.workspaceMembers[f.workspaceId][f.recipient.personId],
      personId: bob.actor.personId,
    };
    state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
  });
  const invoke = (operation: string, token: string, body: unknown) =>
    f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${encodeURIComponent(f.targetId)}/${operation}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      f.repo,
    );
  expect(
    (
      await invoke("approval", f.credential, {
        approval: {
          id: "verified-approval",
          tool: "bash",
          openedAt: new Date().toISOString(),
          detail: "test",
          deniable: true,
        },
      })
    ).status,
  ).toBe(200);
  const consent = (body: Record<string, unknown> = {}, actor = f.actor, workspaceId = f.workspaceId) =>
    f.org.mutateConsent({
      actor,
      workspaceId,
      key: crypto.randomUUID(),
      requestId: "verified-control",
      remove: false,
      body: {
        targetId: f.targetId,
        action: "terminal_control",
        recipient: bob.actor.personId,
        hostId: f.hostId,
        expiresAt: Date.now() + 60_000,
        ...body,
      },
    });
  const deny = (token = bob.token) => invoke("approval/deny", token, { id: "verified-approval", message: "no" });
  return { ...f, bob, consent, deny };
}

async function approvalSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return runInDurableObject(f.channel, (_object, state) => ({
    agents: state.storage.sql.exec("SELECT * FROM agents ORDER BY id").toArray(),
    events: state.storage.sql.exec("SELECT * FROM events ORDER BY seq").toArray(),
  }));
}

describe("verified Host consent and real approval control handlers", () => {
  it("dispatches cross-owner denial only with the enrolled owner's exact terminal_control consent", async () => {
    const f = await fixture();
    expect((await f.consent()).ok).toBe(true);
    await runInDurableObject(f.channel, async (object) => {
      const dispatch = vi
        .spyOn(object as unknown as { interruptTo(...args: unknown[]): boolean }, "interruptTo")
        .mockReturnValue(true);
      try {
        expect((await f.deny()).status).toBe(200);
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        dispatch.mockRestore();
      }
    });
  });

  for (const fault of [
    "no-consent",
    "read-consent",
    "screen-consent",
    "wrong-host",
    "wrong-target",
    "wrong-grantee",
    "expired-consent",
    "revoked-consent",
    "admin-without-consent",
    "ended-enrollment",
    "wrong-generation",
    "viewer",
    "nonmember",
  ] as const) {
    it(`denies ${fault} with no approval mutation, event or interrupt`, async () => {
      const f = await fixture();
      if (["ended-enrollment", "wrong-generation", "viewer", "nonmember"].includes(fault))
        expect((await f.consent()).ok).toBe(true);
      if (
        [
          "read-consent",
          "screen-consent",
          "wrong-host",
          "wrong-target",
          "wrong-grantee",
          "expired-consent",
          "revoked-consent",
        ].includes(fault)
      ) {
        const created = await f.consent();
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error("consent fixture denied");
        if (fault === "revoked-consent") {
          expect(
            (
              await f.org.mutateConsent({
                actor: f.actor,
                workspaceId: f.workspaceId,
                key: "revoke-control",
                requestId: "revoke-control",
                remove: true,
                id: created.value.id,
                body: {},
                expectedRevision: created.policyRevision,
              })
            ).ok,
          ).toBe(true);
        }
        await runInDurableObject(f.org, (_object, state) => {
          if (fault === "revoked-consent") return;
          const row = state.storage.sql
            .exec<{ body: string }>("SELECT body FROM owner_consents WHERE id=?", created.value.id)
            .one();
          const body = JSON.parse(row.body);
          if (fault === "read-consent") body.action = "agent.transcript.read";
          if (fault === "screen-consent") body.action = "agent.screen.read";
          if (fault === "wrong-host") body.hostId = "alice/other-host";
          if (fault === "wrong-target") body.targetId = "alice/codex/other";
          if (fault === "wrong-grantee") body.personId = f.recipient.personId;
          if (fault === "expired-consent") body.expiresAt = Date.now() - 1;
          state.storage.sql.exec("UPDATE owner_consents SET body=? WHERE id=?", JSON.stringify(body), created.value.id);
        });
      }
      if (fault === "ended-enrollment")
        expect(await f.org.endRegisteredExecution(f.executionId, f.targetId)).toBe(true);
      if (["admin-without-consent", "viewer", "nonmember"].includes(fault)) {
        await runInDurableObject(f.org, (_object, state) => {
          const aggregate = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          if (fault === "admin-without-consent") aggregate.members[f.bob.actor.personId].role = "admin";
          if (fault === "viewer") aggregate.workspaceMembers[f.workspaceId][f.bob.actor.personId].role = "viewer";
          if (fault === "nonmember") delete aggregate.members[f.bob.actor.personId];
          state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
        });
      }
      if (fault === "wrong-generation")
        await runInDurableObject(f.channel, (object) => {
          Object.assign(object, {
            binding: { version: 1, generation: 2, workspace: f.workspaceId, operation: "binding", state: "linked" },
          });
        });
      const before = await approvalSnapshot(f);
      await runInDurableObject(f.channel, async (object) => {
        const dispatch = vi
          .spyOn(object as unknown as { interruptTo(...args: unknown[]): boolean }, "interruptTo")
          .mockReturnValue(true);
        try {
          expect((await f.deny()).status).toBe(404);
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          dispatch.mockRestore();
        }
      });
      expect(await approvalSnapshot(f)).toEqual(before);
    });
  }

  for (const fault of [
    "not-host-owner",
    "inactive-issuer",
    "foreign-workspace",
    "missing-host",
    "wrong-target",
    "expired",
  ] as const) {
    it(`refuses consent issuance for ${fault} without storing consent`, async () => {
      const f = await fixture();
      if (fault === "inactive-issuer")
        await runInDurableObject(f.org, (_object, state) => {
          const aggregate = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          aggregate.members[f.actor.personId].status = "revoked";
          state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
        });
      const result = await f.consent(
        fault === "missing-host"
          ? { hostId: "alice/unknown" }
          : fault === "wrong-target"
            ? { targetId: "alice/codex/unknown" }
            : fault === "expired"
              ? { expiresAt: Date.now() - 1 }
              : {},
        fault === "not-host-owner" ? f.bob.actor : f.actor,
        fault === "foreign-workspace" ? `${crypto.randomUUID()}:${crypto.randomUUID()}` : f.workspaceId,
      );
      expect(result.ok).toBe(false);
      await runInDurableObject(f.org, (_object, state) => {
        expect(state.storage.sql.exec("SELECT * FROM owner_consents").toArray()).toEqual([]);
      });
    });
  }

  it("preserves 503 on unavailable approval authority without dispatch or mutation", async () => {
    const f = await fixture();
    const before = await approvalSnapshot(f);
    await runInDurableObject(f.org, async (object) => {
      const authority = vi
        .spyOn(object, "authorizeChannelRead")
        .mockResolvedValue({ ok: false, status: 503, reason: "authority_unavailable", policyRevision: 0 });
      try {
        expect((await f.deny(f.token)).status).toBe(503);
      } finally {
        authority.mockRestore();
      }
    });
    expect(await approvalSnapshot(f)).toEqual(before);
  });

  it("preserves local recipient refusal without recording an approval denial", async () => {
    const f = await fixture();
    const before = await approvalSnapshot(f);
    await runInDurableObject(f.channel, async (object) => {
      const dispatch = vi
        .spyOn(object as unknown as { interruptTo(...args: unknown[]): boolean }, "interruptTo")
        .mockReturnValue(false);
      try {
        expect((await f.deny(f.token)).status).toBe(409);
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        dispatch.mockRestore();
      }
    });
    expect(await approvalSnapshot(f)).toEqual(before);
  });

  for (const denial of queryDenials) {
    it(`denies verified approval reports for ${denial} without local effects`, async () => {
      const f = await fixture();
      await denyB2(f, denial);
      const before = await approvalSnapshot(f);
      const response = await f.channel.managedRequest(
        b2Request(f, `/api/agents/${encodeURIComponent(f.targetId)}/approval`, { approval: null }),
        f.repo,
      );
      expect(response.status).toBe(404);
      expect(await approvalSnapshot(f)).toEqual(before);
    });
  }

  it("requires verified enrollment provenance for Host-local history consent and never accepts an old unverified row", async () => {
    const f = await fixture();
    const created = await f.consent({ action: "channel.history.read" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("history consent denied");
    const input = {
      actor: f.bob.actor,
      action: "channel.history.read",
      generation: 1,
      requestId: "host-history",
      targetExecutionId: f.executionId,
      resource: {
        kind: "workspace" as const,
        organizationId: f.organizationId,
        id: f.workspaceId,
        channel: f.repo,
        targetId: f.targetId,
        ownerPersonId: f.actor.personId,
        hostId: f.hostId,
        operation: "agent.history",
      },
    };
    expect((await f.org.authorizeChannelRead(input)).ok).toBe(true);
    expect(
      (await f.org.authorizeChannelRead({ ...input, resource: { ...input.resource, hostId: "alice/foreign" } })).ok,
    ).toBe(false);
    await runInDurableObject(f.org, (_object, state) => {
      state.storage.sql.exec(
        "UPDATE owner_consents SET body=json_remove(body,'$.enrollmentIntentId','$.targetExecutionId') WHERE id=?",
        created.value.id,
      );
    });
    expect((await f.org.authorizeChannelRead(input)).ok).toBe(false);
  });

  for (const end of ["end", "revoke"] as const) {
    it(`invalidates completed enrollment on execution ${end} and refuses subsequent consent issuance`, async () => {
      const f = await fixture();
      if (end === "end") expect(await f.org.endRegisteredExecution(f.executionId, f.targetId)).toBe(true);
      else {
        const metadata = await f.org.metadata(f.actor);
        expect(
          (
            await f.org.mutateIdentity({
              actor: f.actor,
              key: "revoke-verified",
              requestId: "revoke-verified",
              expectedRevision: metadata?.policyRevision,
              command: { kind: "execution.revoke", executionId: f.executionId },
            })
          ).ok,
        ).toBe(true);
      }
      expect((await f.consent()).ok).toBe(false);
      await runInDurableObject(f.org, (_object, state) => {
        const row = state.storage.sql
          .exec<{ revokedAt: number | null }>(
            "SELECT revokedAt FROM host_enrollments WHERE executionId=?",
            f.executionId,
          )
          .one();
        expect(row.revokedAt).toBeTypeOf("number");
      });
    });
  }

  it("invalidates verified enrollment at unbind reservation before a failed Channel transition", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object) => {
      const owner = vi.spyOn(object, "bindingOwner").mockResolvedValue(true);
      const transition = vi.spyOn(object, "transitionBinding").mockImplementation(() => {
        throw new Error("binding transition unavailable");
      });
      try {
        const metadata = await f.org.metadata(f.actor);
        const result = await f.org.coordinateBinding({
          actor: f.actor,
          login: "alice",
          workspaceId: f.workspaceId,
          repo: f.repo,
          mode: "unbind",
          key: "unbind-verified",
          requestId: "unbind-verified",
          expectedRevision: metadata?.policyRevision,
          acknowledgeLegacyAccess: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(503);
      } finally {
        owner.mockRestore();
        transition.mockRestore();
      }
    });
    expect((await f.consent()).ok).toBe(false);
    await runInDurableObject(f.org, (_object, state) => {
      expect(
        state.storage.sql
          .exec<{ revokedAt: number | null }>(
            "SELECT revokedAt FROM host_enrollments WHERE executionId=?",
            f.executionId,
          )
          .one().revokedAt,
      ).toBeTypeOf("number");
    });
  });

  for (const fault of [
    "revoked-execution",
    "expired-grant",
    "insufficient-scope",
    "wrong-binding",
    "foreign-organization",
    "foreign-workspace",
  ] as const) {
    it(`denies consent issuance and consented control after ${fault}`, async () => {
      const f = await fixture();
      expect((await f.consent()).ok).toBe(true);
      await runInDurableObject(f.org, (_object, state) => {
        if (fault === "revoked-execution")
          state.storage.sql.exec(
            "UPDATE executions SET body=json_set(body,'$.status','revoked') WHERE id=?",
            f.executionId,
          );
        if (fault === "expired-grant") state.storage.sql.exec("UPDATE grants SET body=json_set(body,'$.expiresAt',0)");
        if (fault === "insufficient-scope")
          state.storage.sql.exec("UPDATE grants SET body=json_set(body,'$.actions',json('[]'))");
        if (fault === "wrong-binding")
          state.storage.sql.exec("UPDATE binding_operations SET body=json_set(body,'$.generation',2)");
      });
      const workspaceId =
        fault === "foreign-organization"
          ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
          : fault === "foreign-workspace"
            ? `${f.organizationId}:${crypto.randomUUID()}`
            : f.workspaceId;
      expect((await f.consent({}, f.actor, workspaceId)).ok).toBe(false);
      if (fault === "foreign-organization" || fault === "foreign-workspace")
        await runInDurableObject(f.channel, (object) => {
          Object.assign(object, { binding: { ...object.bindingState(), workspace: workspaceId } });
        });
      const before = await approvalSnapshot(f);
      await runInDurableObject(f.channel, async (object) => {
        const dispatch = vi
          .spyOn(object as unknown as { interruptTo(...args: unknown[]): boolean }, "interruptTo")
          .mockReturnValue(true);
        try {
          expect((await f.deny()).status).toBe(404);
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          dispatch.mockRestore();
        }
      });
      expect(await approvalSnapshot(f)).toEqual(before);
    });
  }
});
