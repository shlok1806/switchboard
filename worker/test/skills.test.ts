// Skills shared on the Channel (ADR 0039, 0050), through the API the CLI, the MCP tools and
// the Dashboard use: versioned manifests any Person or Agent reads, whose files of any type
// the Channel stores once each by SHA-256, which a Person or one of their Agents publishes,
// and which the Channel itself refuses when a file holds a real secret, whatever the laptop did.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  ErrorResponse,
  PublishSkillResponse,
  ReadSkillFilesResponse,
  SkillFile,
  SkillFilesMissing,
  SkillResponse,
  SkillsResponse,
  UploadSkillFilesResponse,
} from "../../shared/src/index";
import {
  downloadSkillFiles,
  MAX_SKILL_FILE_BYTES,
  manifestDigest,
  manifestOf,
  SKILL_FILES_PATH,
  SKILL_FILES_READ_PATH,
  SKILLS_PATH,
  sha256Hex,
  skillPath,
  toBase64,
  uploadSkillFiles,
} from "../../shared/src/index";
import type { Channel } from "../src/channel";
import { migrateSkills } from "../src/skills";
import { channelStub } from "./client";
import { call, cleanUp, wrapperRegisters } from "./hosts-harness";

afterEach(cleanUp);

const ENTRY =
  "---\nname: release-notes\ndescription: Writes release notes from merged pull requests.\n---\n\nRead the merged PRs, then write the notes.\n";

const text = (path: string, content: string): SkillFile => ({ path, bytes: new TextEncoder().encode(content) });

function bundle(extra: SkillFile[] = [], entry = ENTRY): SkillFile[] {
  return [text("SKILL.md", entry), ...extra];
}

/** A woff2 font's first bytes, then bytes that are not UTF-8: a binary file. */
const FONT: SkillFile = {
  path: "fonts/inter.woff2",
  bytes: Uint8Array.from([
    0x77,
    0x4f,
    0x46,
    0x32,
    0x00,
    0x01,
    0xff,
    0xfe,
    ...Array.from({ length: 4000 }, (_, i) => (i * 37) % 256),
  ]),
};

/** Over 2 MB, so stored in three chunks; text with no secret in it. */
const BIG = text("lib/bundle.js", `${"export const line = 'a long bundled module';\n".repeat(60_000)}`);

/** Sends the manifest only, as the CLI's first and last steps do. */
async function sendManifest(name: string, person: string, files: SkillFile[], agent?: AgentId): Promise<Response> {
  return call(skillPath(name), person, { method: "POST", body: { files: await manifestOf(files) } }, agent);
}

/** Publishes as the CLI does: the manifest, the files the Channel lacks, the manifest again. */
async function publish(name: string, person: string, files: SkillFile[], agent?: AgentId): Promise<Response> {
  const first = await sendManifest(name, person, files, agent);
  if (first.status !== 409) return first;
  const { missing } = await first.json<SkillFilesMissing>();
  await uploadSkillFiles(files, missing, async (request) => {
    const response = await call(SKILL_FILES_PATH, person, { method: "POST", body: request }, agent);
    if (!response.ok) throw new Error(await reason(response));
    return response.json<UploadSkillFilesResponse>();
  });
  return sendManifest(name, person, files, agent);
}

async function reason(response: Response): Promise<string> {
  return (await response.json<ErrorResponse>()).reason;
}

/** Reads a version's files back as a Person on the Channel does. */
async function download(person: string, skill: SkillResponse["skill"]): Promise<Map<string, Uint8Array>> {
  return downloadSkillFiles(skill.files, async (request) => {
    const response = await call(SKILL_FILES_READ_PATH, person, { method: "POST", body: request });
    if (!response.ok) throw new Error(await reason(response));
    return response.json<ReadSkillFilesResponse>();
  });
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
    const second = await publish("release-notes", "shlok", bundle([text("templates/notes.md", "# Notes\n")]));
    expect((await second.json<PublishSkillResponse>()).skill.version).toBe(2);

    // Another Person on the Channel sees the latest, without the files.
    const listed = await (await call(SKILLS_PATH, "maya")).json<SkillsResponse>();
    expect(listed.skills.map((s) => [s.name, s.version, s.paths])).toEqual([
      ["release-notes", 2, ["SKILL.md", "templates/notes.md"]],
    ]);
    // And reads any version in full.
    const old = await (await call(skillPath("release-notes", 1), "maya")).json<SkillResponse>();
    expect(old.versions).toEqual([1, 2]);
    expect(old.skill.digest).toBe(one.skill.digest);
    expect(new TextDecoder().decode((await download("maya", old.skill)).get("SKILL.md"))).toBe(ENTRY);
  });

  it("publishes a font and a file over 2 MB, reads them back byte for byte, and stores a file once", async () => {
    const files = bundle([FONT, BIG]);
    const response = await publish("type-specimen", "shlok", files);
    expect(response.status).toBe(201);
    const read = await (await call(skillPath("type-specimen"), "maya")).json<SkillResponse>();
    expect(read.skill.files).toEqual([
      {
        path: "SKILL.md",
        size: files[0]?.bytes.length,
        digest: await sha256Hex(files[0]?.bytes ?? ""),
        encoding: "utf8",
      },
      { path: "fonts/inter.woff2", size: FONT.bytes.length, digest: await sha256Hex(FONT.bytes), encoding: "base64" },
      { path: "lib/bundle.js", size: BIG.bytes.length, digest: await sha256Hex(BIG.bytes), encoding: "utf8" },
    ]);
    expect(read.skill.size).toBe(files.reduce((sum, f) => sum + f.bytes.length, 0));
    const back = await download("maya", read.skill);
    expect(back.get("fonts/inter.woff2")).toEqual(FONT.bytes);
    expect(back.get("lib/bundle.js")).toEqual(BIG.bytes);

    // The next version changes SKILL.md only: the Channel asks for that file alone.
    const next = bundle([FONT, BIG], `${ENTRY}\nAlso set the specimen in Inter.\n`);
    const asked = await sendManifest("type-specimen", "shlok", next);
    expect(asked.status).toBe(409);
    expect((await asked.json<SkillFilesMissing>()).missing).toEqual([await sha256Hex(next[0]?.bytes ?? "")]);
    // And another skill holding files the Channel already has publishes at once, with nothing uploaded.
    const other = await sendManifest("specimen-two", "maya", [text("SKILL.md", ENTRY), FONT]);
    expect(other.status).toBe(201);
  }, 30_000);

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

describe("a skill published before skills of any size (ADR 0050)", () => {
  it("is read and installed as before, under a digest of its manifest", async () => {
    await runInDurableObject(channelStub(), async (_channel: Channel, state: DurableObjectState) => {
      state.storage.sql.exec(`CREATE TABLE skills (
        name TEXT NOT NULL, version INTEGER NOT NULL, person TEXT NOT NULL, agent TEXT, published_at TEXT NOT NULL,
        digest TEXT NOT NULL, size INTEGER NOT NULL, description TEXT, files TEXT NOT NULL, PRIMARY KEY (name, version)
      ) WITHOUT ROWID`);
      state.storage.sql.exec(
        "INSERT INTO skills VALUES ('release-notes', 1, 'shlok', NULL, '2026-11-06T10:00:00.000Z', ?, ?, 'Writes release notes.', ?)",
        "f".repeat(64),
        ENTRY.length,
        JSON.stringify([{ path: "SKILL.md", content: ENTRY }]),
      );
      await migrateSkills(state.storage);
    });
    const read = await (await call(skillPath("release-notes"), "maya")).json<SkillResponse>();
    expect(read.skill).toMatchObject({
      version: 1,
      publishedBy: { person: "shlok" },
      description: "Writes release notes.",
    });
    expect(read.skill.digest).toBe(await manifestDigest(await manifestOf(bundle())));
    expect(new TextDecoder().decode((await download("maya", read.skill)).get("SKILL.md"))).toBe(ENTRY);
    // The same files again publish nothing.
    expect(await (await publish("release-notes", "shlok", bundle())).json<PublishSkillResponse>()).toMatchObject({
      published: false,
    });
  });
});

describe("what the Channel refuses, whatever the laptop sent", () => {
  it("refuses a skill whose files hold a real secret, naming them, and publishes one with a placeholder", async () => {
    const leaked = await publish(
      "deploy",
      "shlok",
      bundle([text("scripts/deploy.sh", "#!/bin/sh\nexport GITHUB_TOKEN=ghp_R8f2kLq9Zt3Xw7Vn1Bc6Hd4Jm0Ps5Yg2Ue8A\n")]),
    );
    expect(leaked.status).toBe(400);
    expect(await reason(leaked)).toBe(
      "scripts/deploy.sh (a GitHub token, line 2) looks like it holds a secret, so deploy was not published. Remove it and publish again.",
    );
    // A file that holds credentials by its name alone.
    const named = await publish("deploy", "shlok", bundle([text(".env", "MODE=dev\n")]));
    expect(await reason(named)).toContain(".env looks like it holds a secret");
    expect((await (await call(SKILLS_PATH, "shlok")).json<SkillsResponse>()).skills).toEqual([]);

    // A placeholder, a reference and AWS's documented example key are not secrets.
    const docs = await publish(
      "deploy",
      "shlok",
      bundle([
        text(
          "references/setup.md",
          'export GITHUB_TOKEN=ghp_...\nLANGFUSE_PUBLIC_KEY=pk-lf-...\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAPI_KEY: "/myapp/api-key"\nconst key = crypto.randomUUID();\n',
        ),
      ]),
    );
    expect(docs.status).toBe(201);
  });

  it("refuses a file whose bytes do not match its digest, and a binary file sent as text", async () => {
    const forged = await call(SKILL_FILES_PATH, "shlok", {
      method: "POST",
      body: {
        chunks: [
          {
            digest: await sha256Hex("the real file"),
            size: 9,
            index: 0,
            data: toBase64(new TextEncoder().encode("a forgery")),
          },
        ],
      },
    });
    expect(forged.status).toBe(400);
    expect(await reason(forged)).toMatch(/does not match that SHA-256, so it was not kept\.$/);

    const files = bundle([FONT]);
    await publish("specimen", "shlok", files);
    const manifest = (await manifestOf(files)).map((f) => (f.path === FONT.path ? { ...f, encoding: "utf8" } : f));
    const lied = await call(skillPath("specimen-text"), "shlok", { method: "POST", body: { files: manifest } });
    expect(await reason(lied)).toBe("fonts/inter.woff2 is not UTF-8 text, so its encoding is base64.");
  });

  it("refuses a manifest from a Switchboard that sends file contents, saying to update it", async () => {
    const old = await call(skillPath("x"), "shlok", {
      method: "POST",
      body: { files: [{ path: "SKILL.md", content: ENTRY }] },
    });
    expect(old.status).toBe(400);
    expect(await reason(old)).toContain("update Switchboard and publish again");
  });

  it("refuses paths outside the skill's directory, a skill with no SKILL.md, and a file over the size cap", async () => {
    const outside = await sendManifest("x", "shlok", bundle([text("../../.ssh/config", "Host *\n")]));
    expect(await reason(outside)).toBe(`"../../.ssh/config" must be a relative path inside the skill's directory.`);
    const absolute = await sendManifest("x", "shlok", bundle([text("/etc/hosts", "")]));
    expect(absolute.status).toBe(400);
    const noEntry = await sendManifest("x", "shlok", [text("README.md", "hi")]);
    expect(await reason(noEntry)).toBe("A skill needs SKILL.md at the root of its directory.");
    const [entry] = await manifestOf(bundle());
    const big = await call(skillPath("x"), "shlok", {
      method: "POST",
      body: {
        files: [entry, { path: "big.bin", size: MAX_SKILL_FILE_BYTES + 1, digest: "0".repeat(64), encoding: "base64" }],
      },
    });
    expect(await reason(big)).toBe("big.bin is 8.0 MB; a skill's file may be at most 8.0 MB.");
    const name = await sendManifest("Bad Name", "shlok", bundle());
    expect(name.status).toBe(400);
  });

  it("reads out only files a published version holds", async () => {
    const files = bundle([text("draft.md", "not published\n")]);
    const first = await sendManifest("drafts", "shlok", files);
    await uploadSkillFiles(files, (await first.json<SkillFilesMissing>()).missing, async (request) =>
      (await call(SKILL_FILES_PATH, "shlok", { method: "POST", body: request })).json<UploadSkillFilesResponse>(),
    );
    const unpublished = await call(SKILL_FILES_READ_PATH, "maya", {
      method: "POST",
      body: { chunks: [{ digest: await sha256Hex(files[1]?.bytes ?? ""), index: 0 }] },
    });
    expect(unpublished.status).toBe(404);
  });

  it("says which versions there are when one is asked for that does not exist", async () => {
    await publish("release-notes", "shlok", bundle());
    const missing = await call(skillPath("release-notes", 9), "maya");
    expect(missing.status).toBe(404);
    expect(await reason(missing)).toBe("release-notes has no version 9; it has 1.");
    expect((await call(skillPath("nothing"), "maya")).status).toBe(404);
  });
});
