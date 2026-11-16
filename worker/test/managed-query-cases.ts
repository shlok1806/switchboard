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

/** All B1 real handler invocations share one real authority/denial matrix. */
export const b1AdditionalSurfaces = [
  { id: "relay", path: "/api/relay", action: "workspace.read", target: "relay" },
  { id: "tasks", path: "/api/tasks", action: "task.read", target: "tasks" },
  { id: "task", path: "/api/tasks/1", action: "task.read", target: "1" },
  { id: "memory", path: "/api/memory", action: "channel.history.read", target: "memory" },
  ...["skills", "artifacts", "brief"].map((name) => ({
    id: name,
    path: `/api/${name}`,
    action: "channel.update.read",
    target: name,
  })),
  ...["source=merged", "source=local", "tail=2", "before=9", "task=1", "source=stored&before=9"].map((selector) => ({
    id: selector,
    path: `/api/events?${selector}`,
    action: "channel.history.read",
    target: "events",
  })),
];
export const preparationSurfaces = [
  { id: "connector.channel", selectors: "", action: "workspace.read", target: "channel" },
  { id: "connector.github", selectors: "about=README.md", action: "task.read", target: "github" },
  { id: "connector.brief", selectors: "", action: "channel.update.read", target: "brief" },
  { id: "stream.event", selectors: "", action: "channel.history.read", target: "events" },
  { id: "stream.backlog", selectors: "", action: "channel.history.read", target: "events" },
  { id: "local.history", selectors: "", action: "channel.history.read", target: "events" },
] as const;

/** Seed ordinary shared readers, preserving their real SQL/byte projection code. */
export async function seedB1Content(f: Awaited<ReturnType<typeof queryExecutionFixture>>) {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(f.channel, (_object, state) => {
    const now = new Date().toISOString();
    state.storage.sql.exec(
      "INSERT INTO tasks(number,data,holder_agent) VALUES(?,?,?)",
      1,
      JSON.stringify({
        number: 1,
        title: "B1 shared task",
        description: "Shared work",
        labels: [],
        blockedBy: [],
        subtasks: [],
        subtasksDone: 0,
        steps: [],
        stepsDone: 0,
        url: "https://example.test/issues/1",
        status: "claimed",
        updatedAt: now,
        claim: { task: 1, holder: { kind: "agent", agentId: f.targetId }, claimedAt: now, stale: false },
      }),
      f.targetId,
    );
    for (const [id, type, payload] of [
      ["b1-shared", "update", { text: "B1 shared content" }],
      ["b1-note", "memory.note", { text: "B1 shared note", tags: ["decision"] }],
      ["b1-private", "directive", { text: "private-marker", to: f.targetId }],
      ["b1-directed", "update", { text: "private-marker", to: [f.targetId] }],
    ] as const)
      state.storage.sql.exec(
        "INSERT INTO events(id,at,type,actor,payload,actor_kind,actor_id) VALUES(?,?,?,?,?,?,?)",
        id,
        now,
        type,
        JSON.stringify({ kind: "agent", agentId: f.targetId }),
        JSON.stringify(payload),
        "agent",
        f.targetId,
      );
    state.storage.sql.exec(
      "INSERT INTO brief_pages VALUES('guide','Guide',1,'Shared guide',?,?, '[]')",
      JSON.stringify({ person: "alice", agent: f.targetId }),
      now,
    );
    const digest = "a".repeat(64);
    state.storage.sql.exec("INSERT INTO skill_versions VALUES('guide',1,'alice',NULL,?,?,3,NULL)", now, digest);
    state.storage.sql.exec("INSERT INTO skill_blobs VALUES(?,3,1,1,NULL,?)", digest, now);
    state.storage.sql.exec("INSERT INTO skill_entries VALUES('guide',1,'SKILL.md',?,3,'utf8')", digest);
    state.storage.sql.exec("INSERT INTO skill_chunks VALUES(?,0,?)", digest, new Uint8Array([65, 66, 67]));
    state.storage.sql.exec(
      "INSERT INTO artifact_versions VALUES('guide',1,'alice','Guide',3,?,?,?)",
      digest,
      JSON.stringify({ person: "alice" }),
      now,
    );
    state.storage.sql.exec("INSERT INTO artifact_chunks VALUES('guide',1,0,?)", new Uint8Array([65, 66, 67]));
  });
}
export const b1ContentDetails = [
  ...["skills", "brief", "artifacts"].map((family) => ({ id: `${family}.detail`, path: `/api/${family}/guide` })),
  { id: "artifact.page", path: "/api/artifacts/guide/page" },
  {
    id: "skill-files",
    path: "/api/skill-files/read",
    method: "POST",
    body: { chunks: [{ digest: "a".repeat(64), index: 0 }] },
  },
] as const;

export const preparationScopes: Record<(typeof preparationSurfaces)[number]["id"], readonly string[]> = {
  "connector.channel": ["workspace.read", "channel.history.read", "channel.update.read", "agent.view", "task.read"],
  "connector.github": ["task.read"],
  "connector.brief": ["channel.update.read"],
  "stream.event": ["channel.history.read", "channel.update.read", "agent.view", "task.read", "workspace.read"],
  "stream.backlog": ["channel.history.read", "channel.update.read", "agent.view", "task.read", "workspace.read"],
  "local.history": ["channel.history.read", "channel.update.read", "agent.view"],
};
