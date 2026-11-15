/** Shared matrix for query handlers; baseline tests are never changed. */
export const queryDenials = [
  "non_member",
  "foreign_organization",
  "foreign_workspace",
  "revoked_execution",
  "expired_execution",
  "wrong_generation",
  "insufficient_role",
  "insufficient_scope",
] as const;
export const querySurfaces = [
  { id: "history", path: "/api/events", action: "channel.history.read", target: "events" },
  { id: "ids", path: "/api/events?ids=visible", action: "channel.history.read", target: "events" },
  { id: "wakes", path: "/api/events?type=wake", action: "channel.history.read", target: "events" },
  { id: "persons", path: "/api/persons", action: "workspace.read", target: "persons" },
  { id: "agents", path: "/api/agents", action: "agent.view", target: "agents" },
  { id: "github", path: "/api/github?about=README.md", action: "task.read", target: "github" },
] as const;
/** Stub only the managed metadata table, never content reads. */
export const queryMetadataSql = { exec: () => ({ toArray: () => [] }) };

/** Real authority fixture shared by every migrated surface. Credentials remain Org-owned. */
export async function queryExecutionFixture() {
  const { env, runInDurableObject } = await import("cloudflare:test");
  const { managedAuthorityFixture } = await import("./managed-helpers");
  const { agentIdFor } = await import("../../shared/src/index");
  const f = { ...(await managedAuthorityFixture()), targetId: agentIdFor("alice", "codex", "session") };
  await runInDurableObject(f.org, (_object, state) =>
    state.storage.sql.exec("DELETE FROM executions WHERE id=?", f.executionId).toArray(),
  );
  let sequence = 0;
  const mutate = async (command: import("../../shared/src/m1").IdentityCommand) =>
    f.org.mutateIdentity({
      actor: f.actor,
      command,
      key: `query-${++sequence}`,
      requestId: "query-fixture",
      expectedRevision: (await f.org.metadata(f.actor))?.policyRevision,
    });
  const actions = [
    "workspace.read",
    "task.read",
    "channel.history.read",
    "channel.update.read",
    "agent.view",
    "channel.update.write",
  ];
  for (const workspaceId of [undefined, f.workspaceId])
    if (!(await mutate({ kind: "identity.policy", workspaceId, actions })).ok) throw new Error("fixture policy denied");
  const created = await mutate({
    kind: "principal.create",
    sponsor: { kind: "person", id: f.actor.personId },
    displayName: "Query reader",
    capabilities: [],
  });
  if (!created.ok || !created.value.principal) throw new Error("fixture principal denied");
  const principalId = created.value.principal.id;
  if (
    !(
      await mutate({
        kind: "grant.put",
        principalId,
        workspaceId: f.workspaceId,
        actions,
        constraints: {},
        expiresAt: Date.now() + 600000,
      })
    ).ok
  )
    throw new Error("fixture grant denied");
  const started = await mutate({
    kind: "execution.start",
    principalId,
    workspaceId: f.workspaceId,
    cli: "codex",
    registration: { agentId: f.targetId, sessionId: "session", channel: f.repo },
  });
  if (!started.ok || !started.value.execution || !started.value.secret) throw new Error("fixture execution denied");
  const executionId = started.value.execution.id;
  const credential = started.value.secret;
  const channel = env.CHANNEL.getByName(f.repo);
  await runInDurableObject(channel, async (object, state) => {
    const registered = await object.registerAgent("alice", {
      cli: "codex",
      sessionId: "session",
      resumed: false,
      cwd: "/repo",
    });
    if (!registered.ok) throw new Error("fixture roster denied");
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS m1_agent_executions (agent TEXT PRIMARY KEY, organizationId TEXT NOT NULL, executionId TEXT NOT NULL, active INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO m1_agent_executions VALUES(?,?,?,1)",
      f.targetId,
      f.organizationId,
      executionId,
    );
    Object.assign(object, {
      binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
    });
  });
  return { ...f, principalId, executionId, credential, channel };
}

/** B1q2 composed surfaces share the same denial vocabulary and authority fixture. */
export const composedQuerySurfaces = [
  {
    id: "summary",
    operation: "agent.summary",
    path: (agent: string) => `/api/agents/${encodeURIComponent(agent)}/summary`,
    action: "agent.view",
    target: (agent: string) => agent,
  },
  {
    id: "librarian",
    operation: "librarian.read",
    path: (_agent: string) => "/api/librarian",
    action: "channel.history.read",
    target: (_agent: string) => "librarian",
  },
] as const;
