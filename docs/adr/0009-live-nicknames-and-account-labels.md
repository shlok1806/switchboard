# Nicknames change on a live Agent; each Agent shows the login it runs under

A Nickname was fixed when `switchboard run --nickname` registered the Agent. Changing it meant ending the session and resuming it with another `--nickname`. A Person who runs many Agents on one Channel from two Claude accounts also had to put the account into the Nickname to tell them apart. This ADR lets a Nickname change while the Agent runs and gives each Agent an Account Label of its own.

## Renaming

`POST /api/agents/:id/nickname` with `{ "nickname": "<name>" }` sets the Nickname; `null` or an empty name clears it. Three callers may use it:

- The Agent itself, with its own Agent token. Its MCP server has a `rename` tool for it. An Agent token still acts for its own Agent only.
- Any Person with Membership of the Channel: from the Dashboard (the Agent's page), or with `switchboard rename <agent> <nickname>` from any terminal, while the Agent runs or not. `<agent>` is the Agent ID, its short form (`claude/7f3a`) or its current Nickname. Any Person may rename any Agent, not only their own: a Nickname is a shared label on a shared board, the Agent ID never changes, and every rename is an Event that names who made it. A Person who does not like a new name can change it back.

The Channel broadcasts the changed Agent on the stream right away, so the Dashboard and every wrapper see the new name at once. Agents see it the next time they read the Channel or list its Agents.

Each change records an `agent.rename` Event: `{ agent, from?, to? }`. Its actor is whoever renamed: the Agent through the Tool Capture, or the Person. A `run --nickname` that changes the Nickname of a resumed Agent records one too, with the Agent as actor and no Capture. The Relay never considers `agent.rename`: it is about names, not work.

### History

Events keep naming the Agent ID, which is permanent, and nothing about an Event is rewritten. Every view shows an Agent's current Nickname beside its ID, so an old message shows today's name. The `agent.rename` Event sits in the history where the name changed and reads "old -> new", so who said what is never lost. We rejected stamping each Event with the Nickname it was sent under: it would put a second, changing name on every Event, and two names for one Agent in one list reads worse than one name and a visible rename.

### Uniqueness

A Nickname is unique on a Channel, compared without regard to case and surrounding spaces.

- A name held by an Agent that is not Gone is taken. A rename to it is refused with 409, and the refusal names the holder.
- A name held only by a Gone Agent is free. Taking it clears it from the Gone Agent, which records an `agent.rename` Event for that Agent too (`to` absent). A Gone Agent that resumes without `--nickname` comes back without a name; one that resumes with `--nickname` asks for a name again like anyone else.
- `switchboard run --nickname` with a taken name does not stop the session. The Agent registers without that name (keeping the one it had, if any), and the answer carries `nicknameRefused` with the reason, which the wrapper prints in the terminal. A wrapper older than this ADR ignores the field, so its Agent simply has no Nickname.

Once a wrapper has registered its Agent, the Channel's Nickname wins. When the wrapper registers again within the session (its token was revoked or the Channel forgot it), it sends the Nickname and Proxy mode the Channel last told it, not the ones it started with, so a rename or a Proxy mode change made meanwhile is not undone.

## Account Labels

An Account Label says which login of its agent CLI an Agent runs under, such as `sh…@illinois.edu` for one Claude account and `sh…@gmail.com` for another. It is optional, at most 64 characters, and the wrapper sends it each time it registers the Agent (`account` on `POST /api/agents`; omitted keeps the stored one, `null` clears it). The Dashboard shows it next to the Agent, and the `list_agents` tool shows it to Agents.

The wrapper picks it, first match wins:

1. `--account-label <label>` on `switchboard run`; an empty value sends none.
2. The `SWITCHBOARD_ACCOUNT_LABEL` environment variable, the same way.
3. What the agent CLI's own config says about its login, read locally:
   - Claude Code: `oauthAccount.emailAddress` in `.claude.json` under `$CLAUDE_CONFIG_DIR`, or `~/.claude.json` without it.
   - Gemini CLI: `active` in `~/.gemini/google_accounts.json`.
   - Codex: nothing. Its login lives in `auth.json` next to its tokens, and the wrapper does not open files that hold tokens.

An email address found that way is masked to the first two characters of its local part and its domain: `shlokat2@illinois.edu` becomes `sh…@illinois.edu`. That tells two of one Person's accounts apart in the usual case, a work and a personal address, without showing a full address the Person may not have shared with everyone on the repo. When the masked forms of two accounts look the same, the Person sets a label with the flag or the variable.

What is never sent: tokens or anything read from a file that holds them, account or organisation UUIDs, full email addresses, and organisation names, which for personal accounts often contain the full address. Everyone with Membership sees the label, so it is a hint for the Person's teammates, not an identity: the Agent ID and its Person are still what Switchboard trusts.

## Compatibility

Every new field is optional on the wire. A wrapper older than this ADR registers as before: no Account Label, and a clashing `--nickname` is dropped rather than refused. Its MCP server lacks `rename` and `list_agents`, and its `read_channel` shows an `agent.rename` Event without detail. Renaming its Agent from the Dashboard or the CLI works, since that goes through the Channel.
