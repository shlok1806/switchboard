import { runInDurableObject } from "cloudflare:test";
import { M1_ORIGIN } from "./m1-helpers";
import type { queryExecutionFixture } from "./managed-query-cases";

export type B2Fixture = Awaited<ReturnType<typeof queryExecutionFixture>>;
export function b2Request(f: B2Fixture, path: string, body: unknown, human = false) {
  return new Request(`${M1_ORIGIN}/r/${f.repo}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${human ? f.token : f.credential}` },
    body: JSON.stringify(body),
  });
}
export async function denyB2(f: B2Fixture, denial: string, human = false) {
  await runInDurableObject(f.org, (_object, state) => {
    const aggregate = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
    );
    if (denial === "non_member") delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
    if (denial === "insufficient_role")
      aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = human ? "invalid" : "viewer";
    if (denial === "insufficient_scope") {
      if (human) aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "viewer";
      else state.storage.sql.exec("UPDATE grants SET body=json_set(body,'$.actions',json('[]'))");
    }
    state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    if (denial === "revoked_execution")
      state.storage.sql.exec(
        "UPDATE executions SET body=json_set(body,'$.status','revoked') WHERE id=?",
        f.executionId,
      );
    if (denial === "expired_execution")
      state.storage.sql.exec(
        "UPDATE execution_credentials SET body=json_set(body,'$.expiresAt',0) WHERE json_extract(body,'$.executionId')=?",
        f.executionId,
      );
  });
  await runInDurableObject(f.channel, (object) => {
    if (["foreign_organization", "foreign_workspace", "wrong_generation"].includes(denial))
      Object.assign(object, {
        binding: {
          ...object.bindingState(),
          generation: denial === "wrong_generation" ? 2 : 1,
          workspace:
            denial === "foreign_organization"
              ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
              : denial === "foreign_workspace"
                ? `${f.organizationId}:${crypto.randomUUID()}`
                : f.workspaceId,
        },
      });
  });
}
export async function b2Effects(f: B2Fixture) {
  return runInDurableObject(f.channel, (_object, state) => ({
    tasks: state.storage.sql.exec("SELECT * FROM tasks").toArray(),
    persons: state.storage.sql.exec("SELECT * FROM persons").toArray(),
    events: state.storage.sql.exec("SELECT * FROM events").toArray(),
  }));
}
