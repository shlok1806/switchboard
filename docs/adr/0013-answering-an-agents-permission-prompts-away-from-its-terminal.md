# Answering an Agent's permission prompts away from its terminal

Status: accepted on 2026-10-15. The owner chose the recommendation: B (pending approvals on the Dashboard and in the Channel API, read-only) and A's documentation first, then D (remote deny) for Claude Code. C (remote approve) is rejected for now: no remote party approves a command.

## The problem

Codex stops at its approval dialog whenever a command needs to leave its sandbox. Building and running a scratch daemon, `tart` and VMs all do. Claude Code stops the same way at its permission prompt in `default` mode. An unattended Agent then waits until its Person comes back to the terminal. Nobody watching the Channel can tell why it stopped, and nobody there can answer it.

Seen on 2026-10-15 with codex-cli 0.162.1 through `switchboard run codex` on the `switchboard-playground` Channel: `touch $HOME/.sb-approval-probe` stopped at "Would you like to run the following command?". The Channel and the Dashboard showed nothing. Any Directive sent meanwhile goes to the Queue as `dialog-open`. The wrapper sees that state already: the PermissionRequest hook sets the typer's `dialog`. That state is never sent to the Channel.

## What the CLIs allow

- **Both CLIs have a PermissionRequest hook that can decide.** It answers `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, or `"deny"` with a `message`. With no decision, the normal dialog decides. Codex refuses `updatedInput` and `updatedPermissions` (they fail closed). The default hook timeout is 600 s for both, and a hook's `timeout` can set it.
- **Claude Code shows its dialog while the hook runs.** Verified with Claude Code 2.1.300: a hook that slept 8 s and then answered `allow` closed a dialog that was already open, and the command ran. The Person and the hook race, and the first answer wins. The hook input carries the tool, its input, a description and `permission_suggestions`.
- **Codex is not verified.** Its docs say an `allow` "lets the request proceed without showing the approval prompt", and the hook runs "when it is about to ask". So Codex may hold its dialog back until the hook returns. A hook that waits for a remote answer would then hide the dialog from the Person at the terminal for as long as it waits. This must be tested before Codex is wired in. The Switchboard hooks also need the Person's trust in Codex's `/hooks` first.
- **Approval policy already passes through.** `switchboard run` hands every argument it does not own to the CLI, so `switchboard run codex -a never -s workspace-write` and `switchboard run claude --permission-mode acceptEdits` work today. The README does not say so.
- `switchboard-hook.js` gives up after 2 s (`GIVE_UP_MS`), and the wrapper answers every hook at once. A hook that waits for a Person needs its own path.

## Options

### A. Document running unattended Agents with a policy that never asks

Examples: `switchboard run codex -a never -s danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `switchboard run claude --permission-mode bypassPermissions`, or Claude Code's `auto` mode. No code beyond the README, and perhaps a line in the wrapper's start notice that names the policy in force.

- Under `-a never` with a sandbox, a command that needs to leave the sandbox fails instead of stalling, and the model reads the failure and works around it. That is wrong for the VM work, which must leave the sandbox.
- Without a sandbox, every command runs with the Person's full rights: one bad command, or one prompt-injected through a file, an issue or a dependency, runs unchecked. ADR 0005 keeps other Agents' words out of the prompt, but files and web pages still reach it.
- Nothing about the stall becomes visible: a Person who forgets the flag is back to today.

### B. Show a pending approval on the Channel, answered only at the terminal

The wrapper already knows when a dialog opens and closes (PermissionRequest, then PostToolUse, Stop, Enter or Escape). It sends one `approval.pending` Event: the tool, the command or patch with secrets masked by the Proxy's masking, the CLI's reason, and when it opened. It sends `approval.closed` when the dialog goes. The Dashboard shows "waiting for approval" on the Agent card and in the feed, and the Channel API's Agent view carries it, so an orchestrator sees why the Agent stopped instead of guessing.

- It is read-only. No new way to run anything.
- It does not unblock the Agent. Someone still has to reach the terminal, so it only shortens the time to notice.
- It shows command text on the Channel. Every Person with Membership already sees Proxy Digests with the same commands, after the same masking.

### C. B, plus answering the prompt remotely through the hook

On top of B, the Agent's wrapper holds the PermissionRequest hook open: the hook command waits on the socket instead of giving up after 2 s, with a hook `timeout` of about 10 minutes. The Dashboard's Approve and Deny buttons and `POST /api/approvals/<id>` with `{ decision: "allow" | "deny", message? }` reach the Agent's wrapper over its WebSocket, the way a Directive does. The wrapper answers the hook with that decision. An answer at the terminal still works and closes the Channel's card. When the Agent's own Person answers remotely, that counts as their prompt for Wake counting.

Rules it would need:
- **Who may answer:** only the Agent's own Person, never another Person on the Channel and never an Agent Token. ADR 0005 gives a Person's word instruction weight only for their own Agents' work, and approving a command is more than instructing: it runs code on that Person's laptop.
- **What an answer binds to:** one approval ID, issued for one dialog of one Agent, answered at most once, and void once the dialog closes or the session ends. Only `allow` or `deny`: never "always allow", never `updatedInput`, never `updatedPermissions`, so no remote party can widen what the session may do.
- **Off by default:** `switchboard run --remote-approvals`, or a per-Person setting. A Person who never turns it on gets B only.
- **The Person sees the real thing:** the exact command, its working directory, the masked text clearly marked as masked, and the CLI's reason. The reason comes from the model, so it is shown as the Agent's claim, not as fact.

Risks:
- **The Worker becomes a path to running commands on a laptop.** Anyone holding the Person's Switchboard session, the Worker's deploy keys or the GitHub App's keys could approve a command an Agent was steered into asking for. Today a stolen session can send Directives, which an Agent may still refuse or which its Person may see. An approval is the Person's own consent. Mitigations: off by default, own-Person only, single use, short-lived, and every answer recorded as an Event naming who answered and from where.
- **Prompt injection aimed at the approver.** A model steered by a poisoned file asks for a harmful command with a soothing reason. A Person on a phone is more likely to tap Approve than one reading a terminal. The masked display can also hide the part that matters.
- **Codex may hide its dialog while the hook waits** (see above). If so, the Person at the terminal cannot answer locally until the hook times out. Either Codex gets only B, or its hold is kept short and then falls back to the terminal dialog. This needs testing first.
- **More moving parts on the hook path:** a hook held for minutes, a wrapper restart in the middle (the hook must then time out to no decision, never to an allow), and a reconnecting WebSocket. Every failure must end in "no decision", which leaves the dialog in charge.

### D. B, plus remote deny only

Like C, but the Channel can only answer `deny`, with a message the Agent reads: "not now, do X instead". It unblocks the Agent without running anything, and it lets an orchestrator steer it around a step that needs a human. Its risks are a small subset of C's: a stolen session can stop work, but cannot start any. It can ship first, with C added later if the owner chooses it.

## Recommendation

Ship B for both CLIs and document A's pass-through. Then add D for Claude Code. Add C only if the owner chooses it, for Claude Code first, opt-in and own-Person only. For Codex, wire in D or C only after testing whether a waiting hook hides its dialog.

## Decision

B and A's documentation, then D for Claude Code. No C. B in detail:
- The wrapper reports the prompt when its CLI's PermissionRequest hook opens one, and `null` when it closes. It closes when that call's PostToolUse arrives (another call's result leaves it open), when the Person presses Enter or Escape, when the turn ends, or when the session starts or ends. The report goes to `POST /api/agents/:id/approval` with the Agent's token. Only the latest state is sent, and a failed report is retried.
- The Worker keeps the open prompt on the Agent as `approval`. It records `approval.pending` and `approval.closed` with the Hook Capture, and drops the prompt when the Agent registers again, ends its session or goes Gone. The Relay never considers these Events: they are for People.
- Questions (AskUserQuestion, ExitPlanMode, Codex's request_user_input) are not approvals and are not reported.
