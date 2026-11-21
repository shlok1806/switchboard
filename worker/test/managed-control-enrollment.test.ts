import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { managedAuthorityFixture } from "./managed-helpers";

// No enrollment is seeded: only verified registration completion may create one.
describe("managed control enrollment authority", () => {
  it("denies owner and administrator control of an advisory Host without issuing a permit", async () => {
    const f = await managedAuthorityFixture();
    for (const operation of ["agent.approval.deny", "terminal.input", "approval.control"]) {
      for (const generation of [0, 1, 2]) {
        const result = await f.org.issueMutationPermit({
          actor: f.actor,
          action: "channel.update.write",
          generation,
          requestId: `unenrolled-${operation}-${generation}`,
          targetExecutionId: f.executionId,
          resource: {
            kind: "workspace",
            id: f.workspaceId,
            organizationId: f.organizationId,
            channel: f.repo,
            operation,
            targetId: f.targetId,
            ownerPersonId: f.actor.personId,
            hostId: "alice/laptop",
          },
        });
        expect(result.ok).toBe(false);
      }
    }
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mutation_permits").one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='host_enrollments'").toArray()).toEqual(
        [],
      );
    });
  });

  it("does not create an enrollment table when ending a pre-protocol execution", async () => {
    const f = await managedAuthorityFixture();
    expect(await f.org.endRegisteredExecution(f.executionId, f.targetId)).toBe(true);
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='host_enrollments'").toArray()).toEqual(
        [],
      );
      const execution = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM executions WHERE id=?", f.executionId).one().body,
      );
      expect(execution.status).toBe("ended");
    });
  });
});
