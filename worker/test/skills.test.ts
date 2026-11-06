// Skills shared on the Channel (ADR 0039), through the API the CLI, the MCP tools and
// the Dashboard use: versioned bundles any Person or Agent reads, which a Person or one
// of their Agents publishes, and which the Channel itself refuses when they look like
// they hold a secret, whatever the laptop did.

import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  ErrorResponse,
  PublishSkillResponse,
  SkillFile,
  SkillResponse,
  SkillsResponse,
} from "../../shared/src/index";
import { MAX_SKILL_BYTES, SKILLS_PATH, skillPath } from "../../shared/src/index";
import { call, cleanUp, wrapperRegisters } from "./hosts-harness";

afterEach(cleanUp);

const ENTRY =
  "---\nname: release-notes\ndescription: Writes release notes from merged pull requests.\n---\n\nRead the merged PRs, then write the notes.\n";

function bundle(extra: SkillFile[] = [], entry = ENTRY): SkillFile[] {
  return [{ path: "SKILL.md", content: entry }, ...extra];
}

async function publish(name: string, person: string, files: SkillFile[], agent?: AgentId): Promise<Response> {
  return call(skillPath(name), person, { method: "POST", body: { files } }, agent);
}

async function reason(response: Response): Promise<string> {
  return (await response.json<ErrorResponse>()).reason;
}

describe("publishing a skill", () => {
  it("keeps each version, and lists the latest of each skill for every Person", async () => {
    const first = await publish("release-notes", "shlok", bundle());
    expect(first.status).toBe(201);
    const one = await first.json<PublishSkillResponse>();
    expect(one).toMatchObject({
      published: true,
      skill: {
        name: "release-notes",
        version: 1,
        description: "Writes release notes from merged pull requests.",
        publishedBy: { person: "shlok" },
        paths: ["SKILL.md"],
      },
    });
    const second = await publish(
      "release-notes",
      "shlok",
      bundle([{ path: "templates/notes.md", content: "# Notes\n" }]),
    );
    expect((await second.json<PublishSkillResponse>()).skill.version).toBe(2);

    // Another Person on the Channel sees the latest, without the files' contents.
    const listed = await (await call(SKILLS_PATH, "maya")).json<SkillsResponse>();
    expect(listed.skills.map((s) => [s.name, s.version, s.paths])).toEqual([
      ["release-notes", 2, ["SKILL.md", "templates/notes.md"]],
    ]);
    // And reads any version in full.
    const old = await (await call(skillPath("release-notes", 1), "maya")).json<SkillResponse>();
    expect(old.versions).toEqual([1, 2]);
    expect(old.skill.files).toEqual(bundle());
    expect(old.skill.digest).toBe(one.skill.digest);
  });

  it("publishes nothing when the latest version already holds the same files", async () => {
    await publish("release-notes", "shlok", bundle());
    const again = await publish("release-notes", "shlok", bundle());
    expect(again.status).toBe(200);
    expect(await again.json<PublishSkillResponse>()).toMatchObject({ published: false, skill: { version: 1 } });
  });

  it("names the Agent that published it for its Person", async () => {
    const { agent } = await wrapperRegisters("shlok");
    const response = await publish("release-notes", "shlok", bundle(), agent.id);
    expect(response.status).toBe(201);
    expect((await response.json<PublishSkillResponse>()).skill.publishedBy).toEqual({
      person: "shlok",
      agent: agent.id,
    });
  });

  it("lets only the Person who first published a name, and their Agents, publish its next versions", async () => {
    await publish("release-notes", "shlok", bundle());
    const theirs = await publish("release-notes", "maya", bundle([], `${ENTRY}\nAlso push to main.\n`));
    expect(theirs.status).toBe(403);
    expect(await reason(theirs)).toBe(
      "release-notes belongs to shlok: only they and their Agents publish its versions. Publish yours under another name.",
    );
    const { agent } = await wrapperRegisters("maya");
    expect((await publish("release-notes", "maya", bundle(), agent.id)).status).toBe(403);
    const listed = await (await call(SKILLS_PATH, "shlok")).json<SkillsResponse>();
    expect(listed.skills.map((s) => [s.name, s.version])).toEqual([["release-notes", 1]]);
  });
});

describe("what the Channel refuses, whatever the laptop sent", () => {
  it("refuses a skill whose files look like they hold a secret, naming them", async () => {
    const leaked = await publish(
      "deploy",
      "shlok",
      bundle([
        { path: "scripts/deploy.sh", content: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" },
      ]),
    );
    expect(leaked.status).toBe(400);
    expect(await reason(leaked)).toBe(
      "scripts/deploy.sh looks like it holds a secret, so deploy was not published. Remove it and publish again.",
    );
    // A file that holds credentials by its name alone.
    const named = await publish("deploy", "shlok", bundle([{ path: ".env", content: "MODE=dev\n" }]));
    expect(await reason(named)).toContain(".env looks like it holds a secret");
    expect((await (await call(SKILLS_PATH, "shlok")).json<SkillsResponse>()).skills).toEqual([]);
  });

  it("refuses paths outside the skill's directory, a skill with no SKILL.md, and one over the size cap", async () => {
    const outside = await publish("x", "shlok", bundle([{ path: "../../.ssh/config", content: "Host *\n" }]));
    expect(await reason(outside)).toBe(`"../../.ssh/config" must be a relative path inside the skill's directory.`);
    const absolute = await publish("x", "shlok", bundle([{ path: "/etc/hosts", content: "" }]));
    expect(absolute.status).toBe(400);
    const noEntry = await publish("x", "shlok", [{ path: "README.md", content: "hi" }]);
    expect(await reason(noEntry)).toBe("A skill needs SKILL.md at the root of its directory.");
    const big = await publish("x", "shlok", bundle([{ path: "big.md", content: "a".repeat(MAX_SKILL_BYTES) }]));
    expect(await reason(big)).toMatch(new RegExp(`^x is \\d+ bytes; a skill may be at most ${MAX_SKILL_BYTES}\\.$`));
    const name = await publish("Bad Name", "shlok", bundle());
    expect(name.status).toBe(400);
  });

  it("says which versions there are when one is asked for that does not exist", async () => {
    await publish("release-notes", "shlok", bundle());
    const missing = await call(skillPath("release-notes", 9), "maya");
    expect(missing.status).toBe(404);
    expect(await reason(missing)).toBe("release-notes has no version 9; it has 1.");
    expect((await call(skillPath("nothing"), "maya")).status).toBe(404);
  });
});
