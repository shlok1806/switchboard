import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { managedReadRoute } from "../src/managed-channel";
import { nativeFetch } from "./m1-helpers";
import { managedAuthorityFixture } from "./managed-helpers";

describe("managed shared content", () => {
  it("admits exact shared content reads without admitting publishers or malformed targets", () => {
    for (const family of ["skills", "artifacts", "brief"]) {
      expect(managedReadRoute("GET", `/api/${family}`)?.action).toBe("channel.update.read");
      expect(managedReadRoute("GET", `/api/${family}/guide`)?.targetId).toBe(`${family}/guide`);
      expect(managedReadRoute("GET", `/api/${family}/a%2Fb`)).toBeNull();
      expect(managedReadRoute("POST", `/api/${family}/guide`)).toBeNull();
    }
  });
  it("keeps artifact HTML sandboxed and enforces owner deletion inside a permit", async () => {
    const f = await managedAuthorityFixture();
    const channel = env.CHANNEL.getByName(f.repo);
    await runInDurableObject(channel, (object, state) => {
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
      });
      for (const [name, owner] of [
        ["own", "alice"],
        ["foreign", "bob"],
      ]) {
        state.storage.sql.exec(
          "INSERT INTO artifact_versions VALUES(?,1,?,?,?,? ,?,?)",
          name,
          owner,
          name,
          12,
          "fixture-digest",
          JSON.stringify({ person: owner }),
          new Date().toISOString(),
        );
        state.storage.sql.exec(
          "INSERT INTO artifact_chunks VALUES(?,1,0,?)",
          name,
          new TextEncoder().encode("<h1>hi</h1>"),
        );
      }
    });
    const page = await nativeFetch(`/r/${f.repo}/api/artifacts/own/page`, f.token);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const copy = page.clone();
    expect(await page.text()).toBe("<h1>hi</h1>");
    expect(await copy.text()).toBe("<h1>hi</h1>");
    const nextPage = await nativeFetch(`/r/${f.repo}/api/artifacts/own/page`, f.token);
    expect(nextPage.status).toBe(200);
    expect(await nextPage.text()).toBe("<h1>hi</h1>");
    const denied = await nativeFetch(`/r/${f.repo}/api/artifacts/foreign`, f.token, { method: "DELETE" });
    expect(denied.status).toBe(403);
    const deleted = await nativeFetch(`/r/${f.repo}/api/artifacts/own`, f.token, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, deleted: "own", versions: 1 });
    await runInDurableObject(channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT name FROM artifact_versions WHERE name='foreign'").toArray()).toHaveLength(
        1,
      );
      expect(state.storage.sql.exec("SELECT name FROM artifact_versions WHERE name='own'").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox").toArray()).toHaveLength(2);
    });
  });
  it("checks current membership for shared content lists and direct lookups", async () => {
    const f = await managedAuthorityFixture();
    await runInDurableObject(env.CHANNEL.getByName(f.repo), (object) => {
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
      });
    });
    for (const family of ["skills", "artifacts", "brief"]) {
      const response = await nativeFetch(`/r/${f.repo}/api/${family}`, f.token);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    for (const path of ["skills", "skills/guide", "artifacts", "artifacts/guide", "brief", "brief/guide"]) {
      const response = await nativeFetch(`/r/${f.repo}/api/${path}`, f.token);
      expect(response.status).toBe(404);
    }
  });
});
