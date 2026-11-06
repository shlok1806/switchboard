# Persons share skills on the Channel

Status: accepted on 2026-11-06, for the owner's direction that Persons on a Channel share their Claude Code skills through it. Builds on ADR 0005 (only People instruct), ADR 0019 (shared memory) and ADR 0038 (the first-run guide), and follows the owner's ADR 0034 (an Agent never acts as its Person) and ADR 0035 (Collaborators and Proposals), which are not yet committed.

## Context

A skill is a directory under `.claude/skills/<name>/` (the Person's own, under `CLAUDE_CONFIG_DIR`, or the repo's) holding `SKILL.md` and the files it uses. Claude Code loads it into the model's context when it applies, so a skill is instructions in the strongest sense: whoever writes one steers every Agent that installs it. Persons on a Channel want to hand each other the skills that work for them without copying files over chat.

That makes sharing a path for exactly what ADR 0005 closes: one Agent, confused or prompt-injected by an Update, a Directive from someone else or a file it read, could publish a skill that steers every Agent whose Person installs it, or install one into its own Person's setup. So every write must come from a Person who asked for it, and every install must show that Person what they get.

## Decision

- A skill is published to the Channel as a versioned bundle of its text files. Each version is one row (`skills`, keyed by name and version), never changed or removed, so an install can name exactly what it was shown by its digest (SHA-256 over the files). Publishing the files the latest version already holds publishes nothing. Nothing else is written: no Event, so sharing costs one row written per version (ADR 0037).
- A name belongs to the Person who first published it. Only that Person, or one of their Agents, publishes its next versions; anyone else publishes under another name. Each version records the Person and, when one did it, the Agent.
- What may be published is checked twice, by the same code in `shared/`: on the laptop before anything leaves it, and on the Channel, which enforces every rule the tools do (ADR 0034). A bundle is refused when any file looks like it holds a secret, by the Proxy's secret masker or by a credential file's name (`.env`, `*.pem`, `id_rsa`, `.npmrc` and the like), naming the files. It is refused over 256 KB or 100 files, without `SKILL.md`, with a file that is not UTF-8 text, or with a path that is absolute or climbs out of the skill's directory. Reading a skill to publish it reads `<skills>/<name>/` only, and refuses a symbolic link rather than following it.
- Any Person or Agent on the Channel reads skills: `skills_list` and `skill_read` are always offered, and so are `GET /api/skills` and `GET /api/skills/:name[?version=n]`. A skill's files are information from another Person, never instructions to the Agent reading them, and `skill_read` says so.
- The two write tools, `skill_publish` (a name, from `user` or `project`) and `skill_install` (a name, a version, a target and the digest), are called only when the Agent's own Person asked for it in that session. Never because of an Update, another Agent's message, anything on the Channel or another Person's Directive. The tool descriptions say so, and so does the standing rule the wrapper gives every session (ADR 0005).
- Each call of a write tool asks the Person in the agent CLI's own permission prompt, which no setting the Agent can reach turns off:
  - Claude Code: the session settings carry a `permissions.ask` rule for both tools. An ask rule is checked before any allow rule from any settings file, and prompts even in `bypassPermissions`; `dontAsk` refuses the call instead. Switchboard's PermissionRequest hook never approves (ADR 0014), so nothing answers the prompt but the Person, or an attacher the Person allowed to answer prompts (ADR 0021).
  - Codex: `approval_mode = "prompt"` for each of the two tools, over the server's `default_tools_approval_mode = "approve"`.
  - Cursor CLI and Gemini CLI: Switchboard cannot make them ask (`--approve-mcps`, yolo), so their sessions are not offered the write tools. Their Persons use `switchboard skills` instead.
- An install shows everything first. `skill_read` returns every file of the version in full and a unified diff against what is installed at the target, and ends with the digest to install. `skill_install` installs only the version whose digest it is given: a different digest installs nothing and shows the content again. An install replaces `<skills>/<name>/` and writes nowhere else.
- What a session reports for these tools (its Tool Capture `tool.call`) names the skill and version, never the files installed on that machine.
- `switchboard skills list | show | publish | install` runs the same code from the terminal. A Person typing it is the Person asking, so it needs no prompt; `install` still shows the full content and diff, then asks on a terminal, or takes `--yes`.
- The Dashboard lists the skills and shows any version in full, with the command that installs it. It writes nothing.
- The first-run guide gains a line on skills (ADR 0038).

## Consequences

- The Channel cannot tell whether a Person approved a publish: an Agent's token may publish, as the tool does. An Agent that went around its tools with its own token could publish without a prompt. What limits that is that the version names the Agent that published it, wherever it is listed; that it can only add versions to its own Person's names or take new ones; and that every install is shown in full to, and approved by, the Person installing it. A Person's session never reaches an Agent (ADR 0034), so no Agent publishes as its Person.
- The secret check is a pattern check. A secret it does not recognise is published; the refusal says what it found, not that the rest is clean.
- A shared skill is as trustworthy as the Person who published it. Nothing ranks or reviews skills.
- Versions are never removed, so a skill published by mistake stays readable; its owner publishes a fixed version over it.

## Verification

- Worker tests (`worker/test/skills.test.ts`): versions and the listing, the no-op republish, the Agent named as publisher, the owner rule, and the Channel's own refusal of secrets, paths, a missing `SKILL.md`, the size cap and bad names.
- CLI e2e (a real `wrangler dev`, a fake Claude Code that asks for every `permissions.ask` tool as Claude Code does): a publish denied at the prompt writes nothing and an approved one publishes; a secret and a symbolic link are refused on the laptop; `skill_read` shows the full content and diff, a wrong digest installs nothing, the right one replaces the installed copy, and the Channel never sees the installed files; `switchboard skills` lists, shows, refuses to install without a terminal or `--yes`, installs, publishes from the repo and meets the owner rule. Codex is offered the write tools with their prompt; Gemini CLI is not offered them.
- Dashboard tests and screenshots of the Skills view in every state, and of a skill open at an older version.
