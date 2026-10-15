# One typist holds an Agent's keyboard

Status: proposed on 2026-10-15. Supersedes ADR 0021 in two places: it answers Assumption A, and it replaces "Typing is not exclusive". The rest of ADR 0021 stands. Records Shlok's answer to both of ADR 0021's open questions: "ok typing exclusive and yes for first one".

## Context

ADR 0021 lets an Agent's owner, and the attach keys the owner allows, type into the Agent's live terminal from the Dashboard. It left two questions to Shlok:

- whether someone allowed to attach may answer the CLI's dialogs (Assumption A, working answer yes);
- whether typing should be exclusive. ADR 0021 shipped it shared: the owner and every attached key type into the same session at once, and their keystrokes mix in the order they arrive.

Two people typing into one prompt at once mix their keystrokes into a line neither meant, and either of them can send it with Enter.

## Decision

### Assumption A: yes

An attacher who holds the keyboard (below) reaches an open dialog like the owner. ADR 0021's flag stays: each owner can still turn it off on their machine with `switchboard attach prompts off` (`attachersAnswerPrompts` in `attach.json`, default true). The flag covers every key on the owner's list together, not one key at a time.

### One typist holds the keyboard

One typist at a time **holds the keyboard**: either the owner at the terminal itself, or one attach key from the Dashboard. The wrapper keeps the hold; nothing about it is decided on the Channel.

- **At the terminal.** When the keyboard is free, or the owner already holds it, the owner's keystrokes go to the CLI and they hold it. While a Dashboard key holds it, the owner's keystrokes are held back: the wrapper drops them and reminds the owner, at most every five seconds, who holds it and how to take it back. The terminal's own replies to the CLI's queries (device attributes, cursor, size and focus reports, control strings) are not typing: they still reach the CLI, and they never take the keyboard.
- **Taking it back.** Ctrl+] at the terminal takes the keyboard back at once, whoever holds it. The wrapper keeps that Ctrl+] from the CLI. When no Dashboard key holds the keyboard, Ctrl+] goes to the CLI as before, so no CLI loses the key.
- **From the Dashboard.** Taking the keyboard is explicit: the Dashboard's Take the keyboard button sends a signed `take` frame. The wrapper grants it when the keyboard is free, or already this key's, and only to someone watching the terminal: the Channel names who sent the take, and that name must be on its list of watchers. While the owner or another key holds it, the take is refused, naming who holds it. A take is not typing: it attaches no one. A key types only while it holds the keyboard; otherwise its frames are refused with that reason. The Release the keyboard button, and Stop typing, send a signed `release`.
- **Letting go.** A hold ends:
  - after a minute without a keystroke from its holder, the owner's own included, so a typist who walked away does not lock the others out;
  - when its holder releases it;
  - when the Person who took it stops watching the Agent, which is how the wrapper sees them close the page or lose their connection. Both names are the Channel's (who sent the take, who watches), never the label the owner gave the key on their machine. The Channel cannot grant a hold this way, only refuse or end one, which it could always do by dropping frames;
  - when the wrapper loses its own connection to the Channel.
- **Who holds it is shown.** Every screen frame names the holder: the Person and key, or the owner at the terminal (no key), or no one. The Dashboard shows it over the screen. At the terminal, each change of holder is a terminal notification (OSC 9) and a log line.
- Anything else that types into the session is not a typist and does not hold the keyboard: an Interrupt waits for the holder to go quiet as it waits for the owner, and a Directive, a Wake and an approval from the Channel go their own ways.
- While an Interrupt is being typed, every typist's keys are held back and sent right after it, so they never interleave with it. A Dashboard key's held keys go then only if it still holds the keyboard: an owner who took it back meanwhile never sees them arrive after their own.

### The frames

- An input frame says what it does: typed text (no `op`), `take` or `release`. A `take` or `release` carries no text.
- The signature covers what it does: the signed lines are ADR 0021's, with the op (`type`, `take` or `release`) before the text.
- ADR 0021's checks gain one before Assumption A: for typed text, that this key holds the keyboard. A `take` or `release` is not held back by an open dialog; only typing is.

## Consequences

- Holding the keyboard costs one step for a Dashboard typist, Take the keyboard, and the owner at the terminal must learn one key, Ctrl+], to take it back. A typist who walks away holds the keyboard for at most a minute.
- A Dashboard and a wrapper on either side of this change do not understand each other's frames: a signature without the op fails. The Dashboard and the wrappers move together.
- A terminal reply split across two reads is not recognised whole, so while a Dashboard key holds the keyboard it is held back with the keys around it.
- An owner who turns Assumption A off keeps attachers to typing between dialogs; Shlok's default is on.
