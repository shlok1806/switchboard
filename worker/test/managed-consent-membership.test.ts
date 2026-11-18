import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { managedAuthorityFixture } from "./managed-helpers";

describe("managed consent issuer membership", () => {
  it("rejects terminal control consent from an inactive execution owner", async () => {
    const f = await managedAuthorityFixture();
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaceMembers[f.workspaceId][f.actor.personId].status = "inactive";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    const result = await f.org.mutateConsent({
      actor: f.actor,
      workspaceId: f.workspaceId,
      key: "inactive-owner",
      requestId: "inactive-owner",
      remove: false,
      body: {
        targetId: f.targetId,
        action: "terminal_control",
        recipient: f.recipient.personId,
        hostId: "host",
        expiresAt: Date.now() + 60000,
      },
    });
    expect(result.ok).toBe(false);
    const count = await runInDurableObject(
      f.org,
      (_object, state) =>
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM owner_consents").one().count,
    );
    expect(count).toBe(0);
  });
});
