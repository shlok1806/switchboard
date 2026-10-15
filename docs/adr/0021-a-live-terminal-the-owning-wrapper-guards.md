# A live terminal that the owning wrapper guards

Status: proposed on 2026-10-15. Builds step 6 of the canvas plan (`docs/canvas-design-spec.md`, Decided 4). Assumption A below is the owner's to confirm.

## Context

Decided 4 of the canvas spec: an Agent's live terminal can be watched, and its owner, and anyone the owner allows, can type into it. Typing counts as Person input. The spec calls this "attach", because Takeover already means moving a Stale Claim. One question is left open: whether someone allowed to attach may also answer the CLI's permission prompts.

Typing into an Agent's terminal is the same power as sitting at its owner's keyboard: it can approve a tool call, run a shell command through the model, or read files. Until now, every path from the Channel into a session ends in text the model reads as information (Updates, Directives, Interrupts) or in a deny, which only removes a power (ADR 0014). Attach is the first path from the Channel that adds one.

So the Channel must not be what decides who may type. The Channel is a Worker on Cloudflare that every collaborator's requests reach. A bug in it, a leaked deploy token or a compromised Cloudflare account must not let anyone type into a Person's session. The design treats the Channel as untrusted for input: it carries the keystrokes, but it cannot make them.

## Decision

### The wrapper decides who may type, from a list on its own machine

- Each browser that wants to type makes an **attach key**: an ECDSA P-256 key pair from WebCrypto. The private key cannot be exported and stays in that browser's IndexedDB. Its **fingerprint** is the SHA-256 of the public key (SPKI), shown as five groups of four base32 characters, such as `K7QX-2MRD-PA4L-7TZE-WCBN`.
- The owner allows a key on the machine that runs their Agents, in their own terminal:
  - `switchboard attach allow <fingerprint> --person <name>` allows it;
  - `switchboard attach list` shows the allowed keys;
  - `switchboard attach revoke <fingerprint>` removes one.
- The list lives in `attach.json` in Switchboard's config folder. It is readable only by the Person, like the session file. The wrapper reads it again for every input frame, so a revoke takes effect at the next keystroke, and a list it cannot read allows no one. Nothing about it is stored on the Channel or comes from it.
  - For their own browser, the owner copies the fingerprint the Dashboard shows them.
  - For anyone else, the fingerprint comes to the owner some other way (chat, in person). The owner must not take it from the Channel, since the Channel could swap it.
- `--person` is the name the wrapper shows for that key. It is the owner's label, not something the Channel asserts. Without it, the key is labelled with the Person signed in on this machine, which makes it an owner's key.
  - A key whose `--person` is the owner's own name is the **owner's key**.
  - Any other allowed key belongs to an **attacher**.
- `--agent <id>` limits a key to one Agent. Without it, the key may type into every Agent this wrapper's Person runs.

### Every keystroke is signed, and the wrapper checks it

- An input frame carries the Agent, the public key (SPKI, base64), a sequence number, the text, and a signature over `switchboard-terminal-input`, the Agent ID, the wrapper's **session nonce**, the sequence number and the text, one per line.
- The session nonce is 16 random bytes the wrapper makes when it starts and puts in every screen frame. A frame signed for another run of the wrapper fails.
- Before writing a frame to the session, the wrapper checks, in order:
  1. the frame is for the Agent this wrapper runs, and its text is 1 to 1,024 characters;
  2. the key's fingerprint is on its list, and allowed for this Agent;
  3. the signature is valid for this Agent and this nonce;
  4. the sequence number is higher than the last one it took from that key in this run, so the Channel cannot replay a frame;
  5. Assumption A, when a permission prompt is open.

  Any failure drops the frame. The wrapper tells watchers why, and logs it. It never writes part of a frame.
- The Channel can still drop, delay or reorder frames. That is a denial of service, which it can always cause. It cannot make a frame that passes.
- Text that passes goes into the session exactly as the Person's own keys do: through the same path, so it counts as Person input. An Interrupt waits for it, and Enter on a prompt is the Person's prompt.

### Watching: the screen, redacted, while someone watches

- The wrapper keeps a headless terminal emulator fed with the CLI's output. While at least one Person watches the Agent, it sends the screen as text, at most eight frames a second, each a whole screen:
  - the rows and columns;
  - the lines;
  - the cursor;
  - the session nonce;
  - who is attached;
  - whether a permission prompt is open.
- Each line is redacted by the wrapper before it leaves the machine, with the same masking as the Proxy Capture, after joining lines the terminal wrapped, so a secret split across a wrap is still found. The screen is sent as plain text, never as escape sequences, so no viewer's browser runs a terminal escape from an Agent.
- Any Person on the Channel may watch, as the spec's Decided 4 says, as they may read its transcript (ADR 0019). The Channel sends screen frames only to sockets that asked to watch that Agent, and tells the wrapper how many there are each time one starts or stops, so an unwatched Agent sends nothing. Each time, the wrapper sends the whole screen at once, since a socket that just started watching has none. One socket watches at most 16 Agents.
- Watching needs no key. The Channel can read what it carries; the wrapper's redaction is what protects it, as it does for transcripts.

### Who is attached is on the Channel

- The first frame a key gets into a session makes the wrapper record a `terminal.attached` Event naming the Agent, the key's label and its fingerprint's first group. The Event records the Agent's own claim, from the Agent's own socket.
- Every screen frame lists the keys that typed in the last two minutes, so everyone watching sees who is attached.

### Assumption A: someone allowed to attach may answer permission prompts

- Answering a prompt and typing it are the same act (spec, approve and deny on the node). The working answer is **yes**: an attacher's keys reach an open permission dialog like the owner's.
- This is the owner's decision to confirm. It sits behind one flag on the owner's machine, `attachersAnswerPrompts` in `attach.json`, which defaults to true:
  - `switchboard attach prompts off` sets it false;
  - `switchboard attach prompts on` sets it back.
- When it is off, the wrapper drops an attacher's frames while the CLI shows a permission dialog and tells watchers why. The owner's key is never held back.
- The approve and deny controls of ADR 0013 and ADR 0014 do not change: only the Agent's own Person can use them, and the Channel checks that. An attacher answers a prompt in the terminal or not at all.

### Limits

- A Person's socket may send at most 50 input frames a second.
- The Channel forwards an input frame only when it is well formed and its Agent is attached. The frame goes to that Agent's wrapper socket, the newest one that attached (as for Interrupts). The Channel also adds which Person's socket sent it, for the wrapper's log only.
- Codex and Gemini CLI get this through the same wrapper code. Nothing here is specific to Claude Code.

## Consequences

- Taking over an Agent from a new browser needs one step at the owner's machine. That is the cost of not trusting the Channel, and it is paid once per browser.
- A stolen browser profile can type into the owner's Agents until the owner revokes its key. The key cannot be copied out of the browser, but it can be used from inside it.
- The screen is text without colours or attributes. That was chosen for the redaction and for safety, not for looks. Colours can come later as attributes on the same frames, still never as raw escapes.
- A Host's Agents (ADR 0015), which have no window, can now be watched and typed into from the Dashboard. This is the first way to answer one of their prompts when no Person is at the machine.
- If the owner answers no to Assumption A, the change is the flag's default and the ADR that records the answer. The code stays as it is.
