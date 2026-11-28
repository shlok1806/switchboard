// The skills Persons share on the mock Channel (ADR 0039, 0050): every version of each, as the
// Worker keeps them, a manifest per version, and the files' bytes by digest.
import type { Skill, SkillEntry } from "@shared/index";
import { encodingOf, skillDescription, sortedByPath } from "@shared/index";
import { A, ago } from "./fixtures";

/** Every mock file's bytes, by its digest. */
export const SKILL_BYTES = new Map<string, Uint8Array>();

/** A stand-in for the Worker's SHA-256: the same shape, the same for the same bytes. */
export function standInDigest(bytes: Uint8Array): string {
  let out = "";
  for (let seed = 0; out.length < 64; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function version(
  name: string,
  n: number,
  publishedBy: Skill["publishedBy"],
  secondsAgo: number,
  files: { path: string; content: string | Uint8Array }[],
): Skill {
  const entries: SkillEntry[] = sortedByPath(files).map((file) => {
    const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
    const digest = standInDigest(bytes);
    SKILL_BYTES.set(digest, bytes);
    return { path: file.path, size: bytes.length, digest, encoding: encodingOf(bytes) };
  });
  const entry = files.find((file) => file.path === "SKILL.md")?.content;
  const description = skillDescription(typeof entry === "string" ? entry : undefined);
  return {
    name,
    version: n,
    ...(description === undefined ? {} : { description }),
    publishedBy,
    publishedAt: ago(secondsAgo),
    size: entries.reduce((sum, f) => sum + f.size, 0),
    paths: entries.map((f) => f.path),
    digest: standInDigest(new TextEncoder().encode(JSON.stringify(entries.map((f) => [f.path, f.digest])))),
    files: entries,
  };
}

/** Bytes that are not UTF-8 text, `size` of them: a font or an image as a skill ships one. */
function binary(magic: string, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i < magic.length ? magic.charCodeAt(i) : (i * 131 + 7) % 256;
  return bytes;
}

const RELEASE_NOTES = `---
name: release-notes
description: Writes the release notes for a tag from the pull requests merged since the last one.
---

# Release notes

1. Find the last tag with \`git describe --tags --abbrev=0\`.
2. List the pull requests merged since, with \`gh pr list --state merged --search "merged:>DATE"\`.
3. Group them by label: Features, Fixes, Docs. Leave out anything labelled \`internal\`.
4. Write one line per pull request, in the past tense, ending with its number.
`;

const API_CLIENT = `---
name: api-client
description: How web/src/api calls the backend - retries, paging and errors.
---

Every call goes through \`request()\` in web/src/api/client.ts. It retries a 429 or a 5xx
three times, waiting 250ms, 1s and 4s. Lists page by 50 with \`?cursor=\`.

Throw \`ApiError\` with the server's \`reason\`; never show a raw status to a user.
`;

const REVIEW = `---
name: review-checklist
description: What a reviewer checks before approving a pull request in this repo.
---

- The tests cover the behaviour, not the implementation.
- No new dependency without a line in DEPENDENCIES.md.
- Copy in the UI is a sentence, with no exclamation marks.
`;

const SPECIMEN = `---
name: type-specimen
description: Sets a type specimen page in Inter, from the fonts this skill ships.
---

Copy templates/specimen.html next to the page, and load fonts/inter-regular.woff2 and
fonts/inter-semibold.woff2 with \`@font-face\`. Compare the result with assets/specimen.png.
`;

const SPECIMEN_HTML = `<!doctype html>
<style>
  @font-face { font-family: Inter; src: url(../fonts/inter-regular.woff2) format("woff2"); }
  body { font-family: Inter, sans-serif; }
</style>
<h1>Aa Bb Cc</h1>
`;

export const SKILL_VERSIONS: Skill[] = [
  version("api-client", 1, { person: "dev", agent: A.devClaude }, 5400, [{ path: "SKILL.md", content: API_CLIENT }]),
  version("release-notes", 1, { person: "shlok" }, 86_400 * 3, [
    { path: "SKILL.md", content: RELEASE_NOTES.replace(" Leave out anything labelled `internal`.", "") },
  ]),
  version("release-notes", 2, { person: "shlok", agent: A.shlokClaude }, 2400, [
    { path: "SKILL.md", content: RELEASE_NOTES },
    { path: "templates/notes.md", content: "## {{tag}}\n\n### Features\n\n### Fixes\n\n### Docs\n" },
  ]),
  version("review-checklist", 1, { person: "maya", agent: A.mayaClaude }, 86_400, [{ path: "SKILL.md", content: REVIEW }]),
  version("type-specimen", 1, { person: "maya" }, 7200, [
    { path: "SKILL.md", content: SPECIMEN },
    { path: "fonts/inter-regular.woff2", content: binary("wOF2\0", 23_412) },
    { path: "fonts/inter-semibold.woff2", content: binary("wOF2\0", 24_180) },
    { path: "assets/specimen.png", content: binary("\x89PNG\r\n\x1a\n", 2_310_224) },
    { path: "templates/specimen.html", content: SPECIMEN_HTML },
  ]),
];
