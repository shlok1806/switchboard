import { runInDurableObject } from "cloudflare:test";
import type { AgentExecution } from "../../shared/src/m1";
import type { Hosts } from "../src/hosts";
import { queryExecutionFixture } from "./managed-query-cases";

/** Advisory Host setup proves nothing. Enrollment is created only by the real
 * native-owner handoff -> dual receipts -> intent -> apply -> completion path.
 */
export async function verifiedRegistrationFixture() {
  const f = await queryExecutionFixture();
  await runInDurableObject(f.channel, (object, state) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString());
    (object as unknown as { hosts: Hosts }).hosts.register("alice", { name: "verified-host", roots: ["/repo"] });
  });
  const response = await f.channel.registerManagedAgent(
    new Request(`https://switchboard.test/r/${f.repo}/api/agents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}`, "Idempotency-Key": "verified-host-registration" },
    }),
    { cli: "codex", sessionId: "session", resumed: false, cwd: "/repo", host: "verified-host" },
    { principalId: f.principalId, workspaceId: f.workspaceId },
  );
  if (response.status !== 200) throw new Error(`verified registration denied: ${response.status}`);
  const result = (await response.json()) as { execution: AgentExecution; token: string };
  if (!result.execution?.id || !result.token) throw new Error("registration credential missing");
  return { ...f, executionId: result.execution.id, credential: result.token, hostId: "alice/verified-host" };
}
