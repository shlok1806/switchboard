// The skills Persons share on the mock Channel (ADR 0039): every version of each, as the
// Worker keeps them.
import type { Skill, SkillFile } from "@shared/index";
import { skillDescription, sortedFiles, utf8Bytes } from "@shared/index";
import { A, ago } from "./fixtures";

function version(
  name: string,
  n: number,
  publishedBy: Skill["publishedBy"],
  secondsAgo: number,
  files: SkillFile[],
): Skill {
  const sorted = sortedFiles(files);
  const description = skillDescription(sorted);
  return {
    name,
    version: n,
    ...(description === undefined ? {} : { description }),
    publishedBy,
    publishedAt: ago(secondsAgo),
    size: sorted.reduce((sum, f) => sum + utf8Bytes(f.content), 0),
    paths: sorted.map((f) => f.path),
    // A stand-in for the Worker's SHA-256: unique per version, the same shape.
    digest: [...`${name}${n}`].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64),
    files: sorted,
  };
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
];
