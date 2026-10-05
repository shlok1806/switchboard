# One CLI login serves every Channel on a Worker; each command picks its Channel

ADR 0007 has `switchboard login` save a session "for the Channel", and the CLI read the one repo in its config file for everything. Working in a second repo meant logging in again and losing the first. But the session the Worker hands out names only the Person (ADR 0007: an HMAC over the login and an expiry), and every Channel checks Membership itself on each call. So one session already works for every Channel on the Worker that issued it. This ADR changes how the CLI uses it. ADR 0007 stands otherwise: still one Channel per repo, Membership is still write access, Agent tokens are still per Agent.

The config file keeps its shape, `{ url, repo, session, person }`, with new meanings: `url` is the Worker that issued the session, and `repo` is the Person's default Channel, the one named at login. A file written before this ADR loads as it is, so nobody logs in again.

Each command picks its Channel in this order:

1. `--repo <owner>/<repo>` on `switchboard run`.
2. The `SWITCHBOARD_REPO` environment variable.
3. The GitHub repo of the current directory's git `origin` remote, unless the Worker says it has no Channel for it (`GET /auth/config` lists the repos it allows; an empty list allows any). If the Worker cannot be asked, the directory's repo is still used, and the command says it could not confirm it.
4. The default Channel.

`switchboard run` says which Channel it chose and why when it is not the default, on stderr and in the wrapper log. Since a session starts only in a clone of its Channel's repo, rule 3 is what lets `switchboard run` start in a clone of any repo that has a Channel; the default serves commands run elsewhere. `switchboard whoami` shows the Person, the Worker, the default and what the current directory would use.

The wrapper resolves the Channel once per session and joins it before it starts the agent CLI. A refusal (no write access, no Channel for that repo) ends the command with the Worker's own reason, because signing in again would not change it. Only a session the Worker no longer accepts is answered with a prompt to log in. The wrapper hands the chosen repo to the session's MCP server as `SWITCHBOARD_REPO` in that server's own environment, so the tools act on the same Channel as the wrapper's stream. Hooks and the Proxy Capture reach the Channel only through the wrapper, so they need nothing. The variable is not set for the agent CLI itself, so a wrapper started from inside a session still picks its Channel by its own directory.

`switchboard login` for another Channel of the same Worker runs no device flow. It checks the saved session by joining that Channel and makes it the default. It signs in again only when there is no saved session, the Worker is another one, the Worker no longer accepts the session, or `--force` is given (say, to sign in as another GitHub account). Without `--url` it uses the saved Worker.

Nothing about what a credential may do changes. The session is only ever sent to the origin in `url`: a command chooses a repo, never a host, and a repo must be exactly `owner/name`. Asking the Worker which repos it allows carries no credential. The config file stays readable by its owner only. The MCP server still gets no session, only the Agent's token. The Worker did not change.

We rejected a map of sessions per Worker in the config file. It would let one machine stay signed in to several Workers, which nobody needs yet, and it would need a rule for choosing the Worker and a file format older CLIs cannot read. Logging in to another Worker replaces the saved session, as before.

We rejected falling back to the default Channel when the Worker cannot be asked. In a clone of another repo the default can never be right, since a session starts only in a clone of its Channel's repo, so the fallback would only turn a network hiccup into a refusal.

We rejected making the Worker mint a session per Channel, or checking Membership once at login for every repo. Each Channel already checks Membership with GitHub, on a schedule, where the answer is needed.
