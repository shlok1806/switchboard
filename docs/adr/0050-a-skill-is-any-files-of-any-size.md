# A shared skill holds any files, up to 64 MB, and is refused only for a real secret

Status: accepted on 2026-11-06, for the owner's direction to "raise the skill size limit and publish the rest and allow to include font files and everything else". Amends ADR 0039 (Persons share skills on the Channel): its rules on what a skill may hold, how big it may be, how it is stored and moved, and what the secret check refuses. Everything else in ADR 0039 stands: who may publish and install, the permission prompts, the owner rule, versions that never change.

## Context

ADR 0039 kept a skill to 256 KB and 100 files of UTF-8 text, each version one row of the Channel's SQLite with every file in one JSON column. 22 of the owner's 79 skills were refused:

- Seven are bigger: the largest, web-designer, is 15.5 MB in 181 files, three of them over 1 MB (a 3.4 MB JavaScript bundle); synced is 12.3 MB in 685 files.
- Some hold files that are not text: motion-reel's two woff2 fonts, web-designer's and synced's images.
- Fourteen "looked like they hold a secret". Every one was a false positive. The check was the Proxy's masker (`maskSecrets`, ADR 0021 and 0024), which masks any value given to a name with key, token or secret in it: `Key=SERVICE`, `HttpTokens=required`, `const key = crypto.randomUUID();`, `LANGFUSE_PUBLIC_KEY=pk-lf-...`, `client_secret = response.get("clientSecret")`. That is right for a live terminal screen, where a missed secret leaks and an extra mask costs nothing. It is wrong for refusing a skill, where every false refusal stops a Person sharing their work.

The platform bounds what one step may carry: a Durable Object's SQLite value is at most 2 MB, a Workers RPC call to it at most 32 MiB, a Worker request body at most 100 MB.

## Decision

### Any file

- A skill holds plain files of any type. A file is text when its bytes are UTF-8 with no NUL; any other file is binary. A file's content travels as text when it is text, and as base64 otherwise, with an `encoding` field (`utf8` or `base64`) that says which. The Channel works out which a file is from its bytes and refuses a manifest that says otherwise.
- Links stay refused: a skill holds plain files only, and only its own directory may be a link (#176).
- `skill_read`, `switchboard skills show` and the Dashboard show every text file in full. A binary file cannot be, so they show its path, its size and its SHA-256, and say it is binary.
- An install still needs the Person's approval, and what they approve lists each binary file with its size and SHA-256, in the listing and in the diff (`Binary file fonts/a.woff2: 12,040 bytes, SHA-256 ...`), so the Person knows exactly what lands and can check it with `shasum -a 256`.

### Large skills

- The limits are 64 MiB and 2,000 files per skill, and 8 MiB per file. The owner's largest skill is 15.5 MB (four times under), the most files 685 (three times under) and the largest file 3.4 MB (more than twice under). A file is held whole in the Durable Object's memory while it is checked and hashed, so 8 MiB keeps one upload's working set a small part of its 128 MB.
- File contents are stored content-addressed, by the SHA-256 of their bytes, in chunks of 1 MiB, one chunk per row: under the 2 MB value limit with room to spare (`skill_blobs`, `skill_chunks`). A file the same in two skills, or in two versions of one, is stored once. A version keeps its manifest, one row per file: path, size, SHA-256 and encoding (`skill_versions`, `skill_entries`).
- No request comes near a limit. A publish runs in three steps:
  1. The CLI sends the manifest (`POST /api/skills/:name`, `{ files: [{ path, size, digest, encoding }] }`, at most a few hundred KB). The Channel checks the name, the owner rule and the manifest first, and answers 409 with the digests it does not hold yet.
  2. The CLI uploads those files' chunks in batches of at most 4 MiB of file bytes (`POST /api/skill-files`), each request about 5.5 MB of JSON. When a file's last chunk arrives the Channel hashes the whole file and keeps it only if its SHA-256 is the digest it was given, then works out whether it is text and runs the secret check on it.
  3. The CLI sends the manifest again, and the Channel publishes it.
- An install or read fetches the manifest (`GET /api/skills/:name`), then the chunks of the files it needs in batches of at most 4 MiB (`POST /api/skill-files/read`). The CLI checks every file's SHA-256 against the manifest, and the manifest against the version's digest, before it shows or writes anything. `skill_read` and `show` fetch the text files only; a binary file is shown by its manifest entry. The Channel reads out only files some version holds.
- A version's digest is the SHA-256 of its manifest (each file's path, encoding and SHA-256, by path, as JSON), so the digest an install names covers every byte through the files' own digests. The versions published before this change move to the new tables when a Channel first starts on it, and their digests are taken again the new way; their files do not change.
- Storage per Channel is bounded: at most 2 GiB of skill files, counted once however many versions hold them. An upload past it is refused, saying so. Uploaded files no version holds (an upload left half done, or never published) are removed a day after they were uploaded. At the Durable Object's $0.20 per GB-month, a full Channel's skills cost about $0.40 a month, and they leave over 8 GB of a Durable Object's 10 GB for everything else.

### The secret check refuses real secrets, not names

- The skill check (`findSecret`, `shared/src/secrets.ts`) refuses a file only when it holds a value that looks like a credential:
  - a token in a format the masker knows (GitHub, Anthropic, OpenAI, Stripe, Slack, AWS access keys, private key blocks, JWTs, Switchboard's own sessions and Agent tokens, a password in a URL); or
  - a value given to a secret-sounding name (`API_KEY=`, `"clientSecret":`) that is at least 20 characters with no space, mixes letters and digits, has high entropy (3.5 bits per character or more) and uses at least 10 different characters.
- Placeholders, references and identifiers do not count: `...`, `xxxx`, `<token>`, `{{ key }}`, `my-key`, `required`, words and short numbers (`my-app-key-2024`), ARNs, paths, URLs, `$TOKEN`, `${TOKEN}`, `process.env.TOKEN`, a call (`crypto.randomUUID()`), a dotted identifier, an expression, base64 of plain text, a name that holds something about a secret rather than the secret (`keyId`, `s3KeyName`, `nextToken`), and AWS's documented example keys (`AKIAIOSFODNN7EXAMPLE`).
- A binary file is read for the token formats only, as Latin-1, so a token inside it is still found. A credential file's name (`.env`, `*.pem`, `id_rsa` and the rest) still refuses it whatever it holds.
- The refusal names each file, what was found and the line it is on, never the value.
- `maskSecrets` does not change: the terminal, the Proxy and Agent screens mask as eagerly as before.
- Against the owner's 79 skills: the old rule found a "secret" in 21 of them (the 14 refused for it, and seven refused first for their size or their fonts); the new one finds none, and still finds each token format and a high-entropy key planted in a skill.

### Compatibility

- A CLI from before this change cannot read or publish skills on a Channel after it: the API's shapes changed. The Channel answers its publish with a refusal that says to update Switchboard. Skills are a day old, so this is the cheapest moment to break.

## Consequences

- Publishing a skill writes one row per new file chunk, one per manifest entry and one for the version, instead of one; a republish of a large skill with one file changed writes that file and the manifest only.
- A skill can now carry what a skill's scripts need, fonts, images and bundles included. A binary is not shown in full, so the Person approves it by its size and SHA-256 and by trust in the Person who published it, as with any skill (ADR 0039).
- The check misses more than the masker would: a short password, or a secret with no telling format given to an ordinary name. ADR 0039 already says the check is a pattern check whose refusal says what it found, not that the rest is clean.

## Verification

- `cli/test/secrets.test.ts`: each token format and a high-entropy value is found, with its line; the brief's false positives, placeholders and AWS's example keys are not.
- Worker tests (`worker/test/skills.test.ts`): a skill with a font and a file over 2 MB publishes through the three steps, reads back byte for byte, and stores a file the same in two versions once; a chunk whose bytes do not match its digest is refused; a planted secret and a binary file declared as text are refused; a placeholder publishes.
- CLI e2e (`cli/test/e2e.test.ts`): a skill with a font and a 3 MB file publishes through Claude Code's prompt, `skill_read` shows the font's size and SHA-256 and the text in full, and an approved install writes every file byte-identical; a planted token is refused on the laptop and a placeholder is not.
- Dashboard tests and screenshots of the Skills view with binary files and sizes.
