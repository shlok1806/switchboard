# Contributing to Switchboard

Thank you for your help. This guide tells you how to set up, test and send a change.

## Find something to do

- Issues labelled [`good first issue`](https://github.com/shlok1806/switchboard/labels/good%20first%20issue)
  are small and fully specified. Start with one of them.
- Issues labelled `ready-for-agent` or `ready-for-human` are specified and open to take.
- Issues labelled `needs-triage` are not decided yet. Comment before you start work on one.
- For a large change, open an issue first, so that we can agree on the design before you write code.

Write a comment on the issue to say that you work on it.

## Words

Switchboard uses exact terms: Channel, Person, Agent, Task, Claim, Update, Directive,
Relay, Verdict and others. [CONTEXT.md](CONTEXT.md) defines them. Use them in code,
docs and commit messages. Design decisions are in [docs/adr/](docs/adr/). If your
change alters a decision, add or update an ADR.

## Set up

You need Node.js 22 or newer and git.

```sh
git clone https://github.com/<you>/switchboard.git
cd switchboard
(cd worker && npm ci)
(cd cli && npm ci)
(cd dashboard && npm ci)
```

The repo has three packages and shared code:

| Directory    | What it is                                                         |
| ------------ | ------------------------------------------------------------------ |
| `worker/`    | The Cloudflare Worker and Durable Object that hold each Channel    |
| `cli/`       | The `switchboard` command that wraps agent CLIs and runs Hosts     |
| `dashboard/` | The web Dashboard (React and Vite)                                 |
| `shared/`    | Types and helpers the three packages share                         |

To work on the Dashboard with no Channel, run `npm run dev` in `dashboard/`. It
uses a simulated Channel. You can also open any build with `?mock=1`.

## Test

Run the same checks as CI before you push:

```sh
(cd worker && npm run typecheck && npm run lint && npm test)
(cd cli && npm run typecheck && npm run lint && npm test)
(cd dashboard && npm run build && npm test && npm run shots)
```

`npm run shots` draws every Dashboard view in each state into
`dashboard/screenshots/` and fails if a view does not show its state. It needs
Chrome; set `CHROME` to its path if it is not found.

Add tests for each change in behaviour. Do not skip or disable a test to make CI pass.

## Send a change

1. Make a branch from `main`.
2. Keep each pull request to one change.
3. Write commit messages that say what the change does, in the present tense,
   for example "Mask a key glued and split on the live screen".
4. Open a pull request. Say what it changes and why, and link the issue
   (`Closes #123`).
5. CI must pass. A maintainer reviews each pull request.

If your change is visible to users, add a line under `[Unreleased]` in
[CHANGELOG.md](CHANGELOG.md).

## Security

Do not open a public issue for a security problem, such as a leak of a token
or a way to run commands on another Person's machine. Use
[GitHub private vulnerability reporting](https://github.com/shlok1806/switchboard/security/advisories/new).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
