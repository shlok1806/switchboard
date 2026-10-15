# Denying a Claude Code permission prompt from the Channel

Status: accepted on 2026-10-15. It builds D from ADR 0013 for Claude Code. Remote approve (C) stays rejected.

## Context

ADR 0013 shows an Agent's pending permission prompt on the Channel, read-only. Its decision adds D next: the Agent's own Person may deny the prompt from the Channel, with a message the Agent reads, so an unattended Agent gets unblocked without running anything. Claude Code shows its dialog while its PermissionRequest hook runs, and the first answer wins (verified with Claude Code 2.1.300). Codex may hold its dialog back while the hook runs, which is not verified, so Codex gets no remote deny yet.

## Decision

- **The wrapper holds Claude Code's PermissionRequest hook.** In the session settings this hook alone runs `switchboard-hook.js --hold` with a 600 s timeout. The script then waits for the wrapper's answer instead of giving up after 2 s, and gives up by itself at 590 s. The wrapper answers it:
  - with a deny, when one comes from the Channel for that prompt;
  - with no decision, when the prompt closes at the terminal (Enter, Escape, its PostToolUse, the turn's or the session's end), when another prompt replaces it, or when the wrapper stops.
- **Every failure is no decision.** The script exiting or timing out, the wrapper restarting, a dropped WebSocket and a refused call all leave Claude Code's own dialog in charge. Nothing on this path can produce `allow`, `updatedInput` or `updatedPermissions`.
- **The prompt says whether it can be denied.** The wrapper reports `deniable: true` on a pending approval it holds. Only the Claude Code adapter holds; Codex's and Gemini CLI's prompts are never deniable. The Worker refuses a deny for a prompt that is not deniable.
- **`POST /api/agents/:id/approval/deny`** with `{ id, message? }`:
  - Only the Agent's own Person may call it, with their session. An Agent Token never can, not even the Agent's own, and neither can another Person on the Channel (ADR 0005: a Person instructs only their own Agents).
  - It answers 409 when Prompt `id` is not the Agent's open one, when it is not deniable, when it was already denied (single use) or when the Agent's wrapper is not attached.
  - Otherwise it records an `approval.denied` Event (the ID and the message, by that Person), marks the prompt denied, and sends `approval.deny` to the attached wrapper only.
  - The message is at most 1000 characters.
- **What the Agent reads:** "Denied by <Person> from the Switchboard Channel.", then the Person's message when there is one.
- **The prompt then closes the usual way.** The wrapper treats a deny it delivered as the prompt's answer, so the Channel gets `null` and records `approval.closed`. A deny that arrives after the prompt closed is logged and dropped.
- **The Dashboard** shows Deny on the card only to the Agent's own Person, with an optional message, and only for a deniable prompt.
- The Relay never considers `approval.denied`.

## Consequences

- A stolen Switchboard session can stop an Agent's step, never start one.
- A held hook keeps one socket connection open on the wrapper for as long as the prompt is open. The wrapper releases it before it shuts its socket.
- Codex gets D only after testing shows its dialog stays answerable while a hook waits.
