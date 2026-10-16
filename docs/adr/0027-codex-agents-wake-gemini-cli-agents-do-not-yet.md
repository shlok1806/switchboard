# Codex Agents wake; Gemini CLI Agents do not yet

Status: accepted on 2026-10-16. Extends the Wake (#62, CONTEXT.md) from Claude Code to Codex, as #52 and #63 ask. Keeps ADR 0005: what a Wake types is information from the Channel, never an instruction.

## Context

A Wake is the wrapper typing what waits for an idle Agent's next turn as one prompt, which starts that turn (`cli/src/wake.ts`). #62 built it for Claude Code only: the adapter flag `wakes` is true for Claude Code and false for Codex and Gemini CLI, so an idle Codex or Gemini CLI Agent hears nothing until its Person prompts it. That was the stall in the 2026-09-30 two-person test (#52), where Codex and Claude Code worked on the same Task.

A Wake needs three things from a CLI:

1. Its hooks say when a turn ends and when a session started at its prompt, so the wrapper knows the CLI waits there.
2. A bracketed paste then Enter at its idle prompt submits one prompt and starts a turn.
3. The wrapper can tell its Person is quiet and no dialog is open, the same guards Interrupts use.

Codex has all three. Its Stop and SessionStart hooks report turn ends and session starts, translated to Claude Code's names (`cli/src/clis/codex.ts`). Its prompt takes a typed bracketed paste and Enter: that is how Interrupts and Directives reach it mid-turn, seen with codex-cli 0.159.1. Its approval dialogs are told by PermissionRequest, and `request_user_input` reads as a question dialog.

Gemini CLI has none of them seen. It was not installed where its adapter was written, nothing typed into its prompt has been seen to work, so its Interrupts are already downgraded to Queue, and its AfterAgent answer is not known to behave like Claude Code's Stop.

While reading the Wake path, one gap showed for Claude Code and Codex alike. When the wrapper blocks a Stop hook to ask for notes (ADR 0019, ADR 0024), the CLI does not stop: it continues the turn with the block's reason. The typer had already read the Stop as the Agent being at its prompt, so a Wake could be typed into the continued turn and counted against the cap.

## Decision

### Codex is woken like Claude Code

- The Codex adapter sets `wakes: true`. Everything else is the code Claude Code already uses: the same Waker, the same `InterruptTyper.wake`, the same guards, the same `wake` and `wake.capped` messages, the same Channel Events and Update.
- The cap is the same, `WAKE_CAP` Wakes in `WAKE_WINDOW_MS` (3 in 10 minutes), from `shared/src/wakes.ts`. It is counted afresh by a prompt the Person submits at the terminal and by a Directive from the Person, as for Claude Code. There is no per-CLI cap.
- Codex starts a new session, and runs its first hook, at its first prompt. Until then its hooks are not running and nothing wakes it: what is Queued waits, as it does today.
- When Codex runs without Switchboard's hooks (the Person has not trusted them in `/hooks`), nothing wakes it either. The wrapper cannot tell when a turn ends, and Queued items keep going to the `read_channel` tool.
- Codex's prompt is not known to clear its text on double Escape or on Ctrl+C at its idle prompt (`idleClears: false`). After either, the wrapper still counts the Person's line as holding text, and holds the Wake until they submit a prompt or clear the line with keys it can follow (Backspace, Ctrl+U, Ctrl+W). A Wake late by one prompt is better than one typed onto the Person's text.

### A blocked Stop does not end the turn

- When the wrapper answers a Stop hook with a block, the typer counts the turn as still running. The CLI's next Stop, at the end of the continued turn, ends it, and only then may a Wake be typed. The wrapper never blocks two Stops in a row.
- This holds for every CLI with Stop nudges: Claude Code and Codex.
- The Channel records one `turn.end` per turn. A Stop the CLI sends with `stop_hook_active`, at the end of a turn some hook made it continue, records none: that turn's end was recorded at its first Stop. Before, one turn whose Stop was blocked showed as two.

### Gemini CLI is not woken, yet

- The Gemini CLI adapter keeps `wakes: false`. A Queue for a Gemini CLI Agent waits for its next turn, as before, and the README says so.
- Waking it is the same one-line change, `wakes: true`, once someone runs the real Gemini CLI and sees that a bracketed paste then Enter at its idle prompt starts a turn and that AfterAgent arrives once per turn. Interrupts would follow the same check.

## Considered options

- **A Wake through Codex's hooks instead of its terminal.** Codex's hooks only add context to a turn that already started; none starts one. The terminal is the only way in, as for Claude Code.
- **Waking Gemini CLI on its documentation alone.** Rejected: a Wake types into a session nobody is watching. If its prompt took the paste differently (as text without Enter, or Enter as a line break), the Wake would leave text on the Person's line, and the Channel would say the Agent was woken when it was not. The adapter's rule is that typing is on only where it was seen to work with the real CLI.
- **A cap per CLI.** Rejected: the cap stops Agents waking each other forever, which is the same risk whichever CLIs they run. A Codex Agent and a Claude Code Agent answering each other stop at the same 3 Wakes each.
- **Leave the blocked-Stop gap.** Both CLIs take typed input mid-turn, so the message still arrives. But the Channel would record a Wake that started no turn, and it would use up one of the 3. Cheap to close where the wrapper already decides the block.

## Consequences

- Two Agents on a Task, one in Claude Code and one in Codex, carry a conversation forward without either Person prompting, up to the cap.
- A Gemini CLI Agent still needs its Person to prompt it to hear what is Queued. The README's support table says so.
- The typer now learns of a blocked Stop from the hook's answer, not only from the hook's input.
