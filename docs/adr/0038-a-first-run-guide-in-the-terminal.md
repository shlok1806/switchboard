# A first-run guide in the terminal

Status: accepted on 2026-11-06, for the owner's direction that a Person new to a Channel is told how it works the first time they use it. Builds on ADR 0005 (what the wrapper tells an Agent), ADR 0006 (Task branches and worktrees) and ADR 0015 (Hosts).

## Context

A Person joining an existing hosted Channel installs the CLI, clones the repo, runs `switchboard login --url .../<owner>/<repo>` and then `switchboard run claude`. The agent CLI starts as it always does, and nothing says that a Dashboard exists, that claiming a Task gives the Agent a branch and a worktree of its own and `finish_task` opens the pull request, that Updates and memory notes are information while only a Person's Directive instructs, or how to see what the other Agents do. The README says all of it, but a Person who has just been sent the Channel's URL has not read it.

Telling the Agent instead, in its session context, would reach the Agent, not the Person, and would cost every session tokens to repeat what the Person needs once.

## Decision

- The first time a Person runs `switchboard run <cli>` on a machine, Switchboard prints a short guide to the terminal itself, after every check that can stop the session and before the agent CLI starts and draws its screen. It names the Channel's Dashboard URL, and says in a line each: claims, the Task's branch and worktree, and the pull request `finish_task` opens; Updates and memory notes as information; only a Person's Directive instructs; `list_agents` and `agent_summary` to see the other Agents.
- It is shown only to a Person at a terminal: when standard input and output are both a TTY, and the session was not started by a Host (`SWITCHBOARD_HOST` set, ADR 0015). A scripted run, a pipe or a Host's Agent never sees it. It waits for no key: the agent CLI starts right after it, so nothing that drives `switchboard run` can hang on it.
- It is remembered per Person and machine: a flag file, `<config>/onboarded/<person>`, written when it is shown. A flag that cannot be written only means the guide shows again next time.
- `switchboard help onboarding` prints it again, for the current directory's Channel when signed in.
- Nothing is added to the Agent's session context.
- A feature that changes what a Person needs to know first changes the guide in the same pull request. Skill sharing adds its line when it ships.

## Consequences

- The first session on a machine starts with about fifteen lines of text above the agent CLI's screen. A Person who has seen it on another machine sees it once more there.
- The guide's text is a second place, after the README, that describes the basics; it stays short so the two cannot drift far.
- Deleting `<config>/onboarded/` shows the guide again.

## Verification

- CLI e2e (a real `wrangler dev`, a fake Claude in a pty): the first `switchboard run` prints the guide with the Dashboard URL before the agent CLI starts, the second does not, a run with no TTY never shows it nor writes the flag, and `switchboard help onboarding` prints it.
