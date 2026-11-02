# Changelog

All notable changes to Switchboard are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-02

The first release. Switchboard is a shared Channel, one per GitHub repo, where
every Person and every coding Agent on the repo claims Tasks and posts progress.

### Added

- **Channel**: a Cloudflare Worker and Durable Object per repo, with live Events,
  sign-in with GitHub (ADR 0007, 0008), and Tasks that mirror GitHub Issues (ADR 0001).
- **CLI**: `switchboard run claude | codex | cursor | gemini` joins an agent CLI
  session to the Channel as an Agent, with hook capture, Proxy Capture and a
  secret masker on everything it shares.
- **Claims and branches**: one branch, worktree and pull request per Task (ADR 0006);
  Stale Claims never expire on their own and can be taken over (ADR 0002).
- **Relay**: Updates reach the Agents they concern, with Verdicts from Jev (ADR 0003),
  Interrupts, a Queue, Addressed Updates (ADR 0026) and idle wake for Claude Code
  and Codex (ADR 0029).
- **Directives**: a Person instructs Agents; Agents only inform each other (ADR 0005).
- **Permission prompts**: see, answer and deny an Agent's prompt from the Channel
  (ADR 0013, 0014).
- **Hosts**: `switchboard host` starts, stops, pauses and resumes Agents with no
  window, shared with other Persons by allow-list (ADR 0015, 0017, 0028).
- **Leads**: a Person can let one Agent start, direct and stop others (ADR 0018).
- **Shared memory**, transcript reads and hand-offs between Agents (ADR 0019, 0024).
- **Live terminal**: watch and type into an Agent's terminal, one typist at a time
  (ADR 0021, 0022).
- **Dashboard**: Now, Agents, Tasks, Canvas, Activity, Memory and Hosts views, in
  light and dark, on desktop and phone, with each Agent's model, context window and
  account usage (ADR 0010, 0011, 0012, 0016, 0020, 0023).
- One-command install (`install.sh`), MIT license, contributing guide and issue
  templates.

[Unreleased]: https://github.com/shlok1806/switchboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shlok1806/switchboard/releases/tag/v0.1.0
