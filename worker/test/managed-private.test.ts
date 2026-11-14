import { describe, expect, it } from "vitest";
import { managedReadRoute } from "../src/managed-channel";
import { managedAuthorityFixture } from "./managed-helpers";

describe("managed owner consent", () => {
  it("requires target-owner action-specific consent for transcripts and screens", async () => {
    const f = await managedAuthorityFixture();
    const request = {
      actor: f.recipient,
      action: "agent.private_transcript.read",
      generation: 1,
      requestId: "read",
      targetExecutionId: f.executionId,
      resource: {
        kind: "workspace" as const,
        organizationId: f.organizationId,
        id: f.workspaceId,
        channel: f.repo,
        targetId: f.targetId,
        operation: "transcript",
      },
    };
    expect((await f.org.authorizeChannelRead(request)).ok).toBe(false);
    expect((await f.org.authorizeChannelRead({ ...request, actor: f.actor })).ok).toBe(true);
    const grant = {
      actor: f.actor,
      workspaceId: f.workspaceId,
      key: "consent",
      requestId: "grant",
      remove: false,
      body: {
        targetId: f.targetId,
        action: request.action,
        recipient: f.recipient.personId,
        expiresAt: Date.now() + 60000,
      },
    };
    expect((await f.org.mutateConsent({ ...grant, actor: f.recipient })).ok).toBe(false);
    const created = await f.org.mutateConsent(grant);
    expect(created.ok).toBe(true);
    expect((await f.org.authorizeChannelRead(request)).ok).toBe(true);
    expect((await f.org.authorizeChannelRead({ ...request, action: "agent.private_screen.read" })).ok).toBe(false);
    expect((await f.org.authorizeChannelRead({ ...request, targetExecutionId: "replaced" })).ok).toBe(false);
    if (!created.ok) throw new Error("consent missing");
    expect(
      (
        await f.org.mutateConsent({
          ...grant,
          id: created.value.id,
          key: "remove",
          remove: true,
          body: {},
          expectedRevision: created.policyRevision,
        })
      ).ok,
    ).toBe(true);
    expect((await f.org.authorizeChannelRead(request)).ok).toBe(false);
  });
  it("never accepts caller-supplied ownership and cannot turn a screen read into typing", async () => {
    const f = await managedAuthorityFixture();
    const request = {
      actor: f.recipient,
      action: "agent.private_screen.read",
      generation: 1,
      requestId: "read",
      targetExecutionId: f.executionId,
      resource: {
        kind: "workspace" as const,
        organizationId: f.organizationId,
        id: f.workspaceId,
        channel: f.repo,
        targetId: f.targetId,
        ownerPersonId: f.recipient.personId,
        operation: "terminal",
      },
    };
    expect((await f.org.authorizeChannelRead(request)).ok).toBe(false);
    expect(managedReadRoute("POST", `/api/agents/${encodeURIComponent(f.targetId)}/terminal/input`)).toBeNull();
    expect(managedReadRoute("GET", `/api/agents/${encodeURIComponent(f.targetId)}/terminal`)?.action).toBe(
      "agent.private_screen.read",
    );
  });
  it("scopes consent replay to owner target recipient action and body", async () => {
    const f = await managedAuthorityFixture();
    const grant = {
      actor: f.actor,
      workspaceId: f.workspaceId,
      key: "same",
      requestId: "grant",
      remove: false,
      body: {
        targetId: f.targetId,
        action: "agent.private_transcript.read",
        recipient: f.recipient.personId,
        expiresAt: Date.now() + 60000,
      },
    };
    const first = await f.org.mutateConsent(grant);
    expect(first.ok).toBe(true);
    expect(await f.org.mutateConsent(grant)).toEqual(first);
    expect(
      await f.org.mutateConsent({ ...grant, body: { ...grant.body, action: "agent.private_screen.read" } }),
    ).toMatchObject({ ok: false, status: 409 });
  });
});
