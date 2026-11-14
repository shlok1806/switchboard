import { describe, expect, it, vi } from "vitest";
import { recognizableNativeSession } from "../src/auth";
import { signNativeSession, signSession } from "../src/session";
import { bareChannel } from "./managed-helpers";

describe("trusted internal managed lifecycle", () => {
  it("allows only the recorded execution owner and never drains private queues", async () => {
    const heartbeat = vi.fn(async () => ({ ok: true, agent: { id: "alice/codex/session" } }));
    const touch = vi.fn(async () => true);
    const channel = bareChannel({
      ...{
        version: 1,
        generation: 1,
        workspace: "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002",
        operation: "link",
        state: "linked",
      },
    });
    Object.assign(channel, {
      managedAssociation: () => ({
        organizationId: "00000000-0000-4000-8000-000000000001",
        executionId: "execution",
        active: 1,
      }),
      agents: { find: () => ({ person: "alice" }), heartbeat },
      env: { ORGANIZATION: { getByName: () => ({ touchRegisteredExecution: touch }) } },
      relay: {
        takeDeliveries: () => {
          throw new Error("queue leak");
        },
      },
      directives: {
        takeDirectives: () => {
          throw new Error("directive leak");
        },
      },
    });
    await expect(channel.heartbeat("mallory", "alice/codex/session", "idle")).rejects.toThrow("managed_actor_required");
    expect(heartbeat).not.toHaveBeenCalled();
    await channel.heartbeat("alice", "alice/codex/session", "idle");
    expect(heartbeat).toHaveBeenCalledWith("alice", "alice/codex/session", "idle");
    expect(touch).toHaveBeenCalledWith("execution", "alice/codex/session");
  });
  it("recognizes native sessions synchronously without authenticating a forged payload", async () => {
    const secret = "test-secret-at-least-32-characters-long";
    const native = await signNativeSession(
      secret,
      "https://switchboard.test",
      { kind: "person", personId: crypto.randomUUID(), githubId: "1" },
      "alice",
    );
    expect(recognizableNativeSession(native)).toBe(true);
    expect(recognizableNativeSession(await signSession(secret, "alice"))).toBe(false);
    expect(recognizableNativeSession("invalid")).toBe(false);
    expect(recognizableNativeSession("v1.bad.bad")).toBe(false);
  });
});
