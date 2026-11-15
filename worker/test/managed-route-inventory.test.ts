import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHANNEL_ROUTE_MATCHERS, ROUTES } from "../src/index";
import { managedReadRoute, managedWriteRoute } from "../src/managed-channel";
import { nativeFetch } from "./m1-helpers";
import { bareChannel, invoke, legacyBinding, managedAuthorityFixture } from "./managed-helpers";

// Independent list of legacy content/control RPCs. Test bodies have no storage,
// adapters, actor or external-service fixtures: denying must precede all of them.
const ACTOR_FREE_RPCS = [
  "listTasks",
  "getTask",
  "createTask",
  "claimTask",
  "releaseTask",
  "completeStep",
  "recordBranch",
  "finishTask",
  "takeoverTask",
  "recordToolCall",
  "listAgents",
  "registerAgent",
  "agentSummary",
  "listAccounts",
  "sendDirective",
  "setAgentRole",
  "renameAgent",
  "setAgentModel",
  "setAgentApproval",
  "denyAgentApproval",
  "setProxyMode",
  "join",
  "postUpdate",
  "writeNote",
  "listSkills",
  "readSkill",
  "publishSkill",
  "uploadSkillFiles",
  "readSkillFiles",
  "listArtifacts",
  "readArtifact",
  "artifactPage",
  "publishArtifact",
  "deleteArtifact",
  "briefPages",
  "readBriefPage",
  "writeBriefPage",
  "librarianFeed",
  "moveLibrarianCursor",
  "askBrief",
  "langfuseProject",
  "setLangfuseProject",
  "removeLangfuseProject",
  "askChannel",
  "startMcpGrant",
  "rotateMcpGrant",
  "readMemory",
  "history",
  "latestEvents",
  "latestEventsOfAgent",
  "latestEventsOfTask",
  "eventsById",
  "wakesAfter",
  "listPersons",
  "touchedFiles",
  "listHosts",
  "registerHost",
  "setHostAllow",
  "removeHost",
  "spawnAgent",
  "stopAgent",
  "controlAgent",
];

describe("managed RPC bypass closure", () => {
  it.each(ACTOR_FREE_RPCS)("denies actor-free %s before accessing a subsystem", async (name) => {
    const channel = bareChannel();
    await expect(Promise.resolve().then(() => invoke(channel, name))).rejects.toThrow(
      /managed_actor_required|Managed Channel access is closed/,
    );
  });
  it("keeps streams mutations MCP unknown HTTP routes and malformed private targets closed in the read facade", () => {
    for (const path of ["/api/stream", "/api/agents/a/transcript", "/mcp", "/api/new-route"])
      expect(managedReadRoute("GET", path)).toBeNull();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(managedReadRoute(method, "/api/tasks")).toBeNull();
    expect(managedReadRoute("GET", "/api/memory")).toEqual({
      action: "channel.history.read",
      targetId: "memory",
      operation: "memory.read",
    });
    expect(managedReadRoute("GET", "/api/tasks/1")?.action).toBe("task.read");
    expect(managedReadRoute("GET", "/api/tasks/0")).toBeNull();
    expect(managedReadRoute("GET", "/api/tasks/1/extra")).toBeNull();
  });
  it("enumerates every actual router family with explicit managed admission or default denial", () => {
    // PARTIAL S2a inventory: HTTP matcher families only. Native/integration/frame
    // exhaustiveness belongs to S2b. null is an explicit default-deny expectation.
    type Example = [method: string, path: string, action: string | null];
    const target = "/api/agents/alice%2Fcodex%2Fs";
    const examples: Record<keyof typeof CHANNEL_ROUTE_MATCHERS, Example[]> = {
      tasks: [
        ["GET", "/api/tasks", "task.read"],
        ["POST", "/api/tasks", null],
        ["GET", "/api/tasks/1", "task.read"],
      ],
      agents: [
        ["GET", "/api/agents", "agent.view"],
        ["POST", "/api/agents", null],
        ["POST", `${target}/heartbeat`, null],
        ["POST", `${target}/end`, null],
        ["GET", `${target}/summary`, "agent.view"],
        ["GET", `${target}/transcript`, "agent.private_transcript.read"],
        ["GET", `${target}/terminal`, "agent.private_screen.read"],
        ["GET", `${target}/touched-files`, "agent.private_transcript.read"],
      ],
      claims: [
        ["POST", "/api/tasks/1/claim", "task.claim"],
        ["POST", "/api/tasks/1/release", "task.update"],
        ["POST", "/api/tasks/1/steps/0/complete", "task.update"],
        ["POST", "/api/tool-calls", null],
      ],
      branches: [
        ["POST", "/api/tasks/1/branch", "task.update"],
        ["POST", "/api/tasks/1/finish", "task.update"],
      ],
      takeover: [["POST", "/api/tasks/1/takeover", "task.update"]],
      hosts: [
        ["GET", "/api/hosts", null],
        ["POST", "/api/hosts", null],
        ["POST", "/api/hosts/local/allow", null],
        ["DELETE", "/api/hosts/local", null],
        ["POST", "/api/agents/spawn", null],
        ["POST", `${target}/stop`, null],
        ["POST", `${target}/pause`, null],
        ["POST", `${target}/resume`, null],
      ],
      skills: [
        ["GET", "/api/skills", "channel.update.read"],
        ["GET", "/api/skills/guide", "channel.update.read"],
        ["POST", "/api/skills/guide", null],
        ["POST", "/api/skill-files", null],
        ["POST", "/api/skill-files/read", "channel.update.read"],
      ],
      brief: [
        ["GET", "/api/brief", "channel.update.read"],
        ["GET", "/api/brief/guide", "channel.update.read"],
        ["PUT", "/api/brief/guide", "channel.update.write"],
      ],
      artifacts: [
        ["GET", "/api/artifacts", "channel.update.read"],
        ["GET", "/api/artifacts/guide", "channel.update.read"],
        ["GET", "/api/artifacts/guide/page", "channel.update.read"],
        ["DELETE", "/api/artifacts/guide", "channel.update.write"],
        ["PUT", "/api/artifacts/guide", "channel.update.write"],
      ],
      librarian: [
        ["GET", "/api/librarian", null],
        ["PUT", "/api/librarian", null],
        ["GET", "/api/github", "task.read"],
      ],
      settings: [
        ["GET", "/api/settings/langfuse", null],
        ["PUT", "/api/settings/langfuse", null],
        ["DELETE", "/api/settings/langfuse", null],
      ],
    };
    const fixed: Example[] = [
      ["POST", "/api/join", null],
      ["GET", "/api/events", "channel.history.read"],
      ["GET", "/api/persons", "workspace.read"],
      ["GET", "/api/relay", "workspace.read"],
      ["POST", "/api/updates", "channel.update.write"],
      ["GET", "/api/stream", null],
      ["POST", "/api/directives", "agent.directive.send"],
      ["POST", "/api/memory", "channel.update.write"],
      ["GET", "/api/memory", "channel.history.read"],
    ];
    expect(fixed.map(([method, path]) => `${method} ${path}`).sort()).toEqual([...ROUTES].sort());
    expect(Object.keys(examples).sort()).toEqual(Object.keys(CHANNEL_ROUTE_MATCHERS).sort());
    const assertAdmission = ([method, path, action]: Example) => {
      const admission = managedReadRoute(method, path) ?? managedWriteRoute(method, path);
      expect(admission?.action ?? null, `${method} ${path}`).toBe(action);
    };
    for (const [family, matcher] of Object.entries(CHANNEL_ROUTE_MATCHERS)) {
      for (const example of examples[family as keyof typeof examples]) {
        const [method, path] = example;
        expect(matcher(method, path), `${family}: ${method} ${path}`).toBeTruthy();
        assertAdmission(example);
      }
    }
    for (const example of fixed) assertAdmission(example);
    // D1 is an internal DO lifecycle exception, never actor-free HTTP admission.
    expect(managedWriteRoute("POST", "/api/agents/alice%2Fcodex%2Fs/heartbeat")).toBeNull();
    expect(managedWriteRoute("POST", "/api/agents/alice%2Fcodex%2Fs/end")).toBeNull();
  });
  it("leaves unopened families denied on linked pending and unknown bindings", async () => {
    const f = await managedAuthorityFixture();
    const channel = env.CHANNEL.getByName(f.repo);
    const paths: [string, string][] = [
      ["GET", "/api/memory"],
      ["POST", "/api/memory"],
      ["POST", "/api/skill-files/read"],
      ["POST", "/api/skill-files"],
      ["POST", "/api/skills/guide"],
      ["PUT", "/api/artifacts/guide"],
      ["PUT", "/api/brief/guide"],
      ["GET", "/api/librarian"],
      ["GET", "/api/settings/langfuse"],
      ["GET", "/api/hosts"],
      ["POST", "/api/agents/spawn"],
      ["POST", "/api/tasks"],
      ["POST", "/api/tool-calls"],
      ["GET", "/api/events"],
      ["GET", "/api/persons"],
      ["GET", "/api/stream"],
      ["POST", "/api/agents/alice%2Fcodex%2Fs/end"],
    ];
    for (const binding of [
      { version: 1, state: "linked" },
      { version: 1, state: "pending" },
      { version: 2, state: "linked" },
    ]) {
      await runInDurableObject(channel, (object) => {
        Object.assign(object, {
          binding: { ...binding, generation: 1, workspace: f.workspaceId, operation: "binding" },
        });
      });
      for (const [method, path] of paths) {
        const response = await nativeFetch(`/r/${f.repo}${path}`, f.token, { method });
        const persons = binding.state === "linked" && binding.version === 1 && path === "/api/persons";
        const history = binding.state === "linked" && binding.version === 1 && path === "/api/events";
        const memory = binding.state === "linked" && binding.version === 1 && path === "/api/memory";
        const skillFiles = binding.state === "linked" && binding.version === 1 && path === "/api/skill-files/read";
        const brief = binding.state === "linked" && binding.version === 1 && path === "/api/brief/guide";
        const artifact = binding.state === "linked" && binding.version === 1 && path === "/api/artifacts/guide";
        expect(response.status, `${binding.state}/${binding.version}: ${method} ${path}`).toBe(
          persons || history
            ? 200
            : memory
              ? method === "GET"
                ? 200
                : 403
              : brief
                ? 403
                : skillFiles || artifact
                  ? 400
                  : 404,
        );
        expect(await response.json()).toEqual(
          persons
            ? {
                persons: [f.actor.personId, f.recipient.personId]
                  .sort((a, b) => a.localeCompare(b))
                  .map((personId) => ({ personId })),
              }
            : history
              ? { events: [], cursor: 0 }
              : memory
                ? method === "GET"
                  ? { notes: [] }
                  : { ok: false, reason: "memory_requires_agent" }
                : brief
                  ? { ok: false, reason: "brief_requires_agent" }
                  : artifact
                    ? { ok: false, reason: "invalid_artifact" }
                    : skillFiles
                      ? { ok: false, reason: "invalid_skill_chunks" }
                      : { ok: false, reason: "resource_denied" },
        );
      }
    }
  });
  it("preserves synchronous unlinked dispatch for unopened content families", () => {
    const channel = bareChannel(legacyBinding);
    const value = { legacy: true };
    Object.assign(channel, {
      memory: { read: () => value },
      skills: { readChunks: () => value },
      brief: { pages: () => value },
      artifacts: { list: () => value },
    });
    // No storage, authority or async subsystem exists in this fixture.
    for (const [name, args] of [
      ["readMemory", [{}]],
      ["readSkillFiles", [[]]],
      ["briefPages", []],
      ["listArtifacts", []],
    ] as [string, unknown[]][])
      expect(invoke(channel, name, ...args)).toBe(value);
  });
  it("actual managed HTTP routes cannot bypass decide after Workspace membership removal", async () => {
    const f = await managedAuthorityFixture();
    const channel = env.CHANNEL.getByName(f.repo);
    await runInDurableObject(channel, (object, state) => {
      const binding = { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" };
      Object.assign(object, { binding });
      state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS m1_agent_executions (agent TEXT PRIMARY KEY, organizationId TEXT NOT NULL, executionId TEXT NOT NULL, active INTEGER NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO m1_agent_executions VALUES(?,?,?,1)",
        f.targetId,
        f.organizationId,
        f.executionId,
      );
    });
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    const target = encodeURIComponent(f.targetId);
    const samples: [string, string, Record<string, unknown>][] = [
      ["GET", "/api/tasks", {}],
      ["GET", "/api/tasks/1", {}],
      ["GET", "/api/relay", {}],
      ["GET", "/api/agents", {}],
      ["GET", `/api/agents/${target}/summary`, {}],
      ["GET", `/api/agents/${target}/transcript`, {}],
      ["GET", `/api/agents/${target}/terminal`, {}],
      ["POST", "/api/updates", { text: "must not append" }],
      ["POST", "/api/directives", { to: f.targetId, text: "must not enqueue" }],
      ["POST", "/api/tasks/1/claim", {}],
      ["POST", "/api/tasks/1/release", {}],
      ["POST", "/api/tasks/1/branch", { branch: "task/1-test" }],
      ["POST", "/api/tasks/1/finish", {}],
      ["POST", "/api/tasks/1/takeover", { to: { kind: "person", person: "alice" } }],
      ["POST", "/api/tasks/1/steps/0/complete", {}],
    ];
    for (const [method, path, body] of samples) {
      const response = await nativeFetch(`/r/${f.repo}${path}`, f.token, {
        method,
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.text()).not.toContain("must not");
    }
    const denials = await runInDurableObject(f.org, (_object, state) =>
      state.storage.sql
        .exec<{ body: string }>("SELECT body FROM audit WHERE json_extract(body, '$.decision')='deny'")
        .toArray(),
    );
    expect(denials.length).toBeGreaterThan(0);
  });
});
