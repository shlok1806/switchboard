# Setting up the Switchboard GitHub App

Switchboard signs people in with GitHub and makes every GitHub write (assignees,
labels, the status comment, pull requests) through one GitHub App (ADR 0007). This
page says how the App is set up for the production Worker at
`https://switchboard.switchboard-worker.workers.dev`, so it can be checked or set up
again for another deployment.

The production App is **switchboard-shlok** (App ID `5138187`, client ID
`Iv23li8zKXvsEdSDTRYt`), installed on `shlok1806/switchboard` only.

## 1. Register the App

GitHub, Settings, Developer settings, GitHub Apps, New GitHub App.

- **Homepage URL:** `https://switchboard.switchboard-worker.workers.dev`
- **Callback URL** (user authorization), one per line:
  - `https://switchboard.switchboard-worker.workers.dev/auth/github/callback`
  - `http://localhost:8787/auth/github/callback` (for `wrangler dev`)
- **Expire user authorization tokens:** on. Switchboard uses the user token once, to
  learn the GitHub login, and then relies on its own session, so it never refreshes one.
- **Request user authorization (OAuth) during installation:** off.
- **Enable Device Flow:** on. `switchboard login` uses it.
- **Webhook:** active.
  - **Webhook URL:** `https://switchboard.switchboard-worker.workers.dev/api/github/webhook`.
    One URL serves every Channel: each delivery goes to the Channel of its
    `repository.full_name`.
  - **Webhook secret:** a long random string, the same value as the
    `GITHUB_WEBHOOK_SECRET` Worker secret.

### Permissions

Repository permissions:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | compare commits for push and merge Events; Task branches |
| Issues | Read and write | read Tasks, assignees, labels, the status comment, tick Steps |
| Pull requests | Read and write | open a Task's pull request when it is finished |
| Metadata | Read-only | required by GitHub; also answers the membership check |

No account or organization permissions. Membership is read with the installation
token from `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, which needs
only the permissions above.

### Events

Subscribe to: **Issues**, **Sub issues**, **Issue dependencies**, **Pull request**
and **Push**. The production App also sends **Issue comment**, and GitHub always
sends `installation` and `installation_repositories`; the Worker acknowledges those
with 204 and ignores them.

The App's webhook replaces any webhook set on the repo itself. Deactivate or delete
the repo webhook (repo Settings, Webhooks) so deliveries do not arrive twice.

### Where it can be installed

"Only on this account" is enough for testing.

## 2. Keys

- **Private key:** "Generate a private key" downloads a PKCS#1 file
  (`-----BEGIN RSA PRIVATE KEY-----`). Convert it to PKCS#8 for the Worker:

  ```sh
  openssl pkcs8 -topk8 -nocrypt -in switchboard-shlok.*.private-key.pem -out app-key.pkcs8.pem
  ```

  (The Worker also reads the PKCS#1 file as is, but PKCS#8 is what the secret holds.)
- **Client secret:** "Generate a new client secret" on the App's page.

## 3. Install the App on the repo

The App's page, Install App, pick the account, "Only select repositories", choose
`shlok1806/switchboard`. A repo gets a Channel only if the App is installed on it and
it is listed in the `ALLOWED_REPOS` var (worker/wrangler.jsonc).

## 4. Worker secrets

From `worker/`:

```sh
npx wrangler secret put GITHUB_APP_ID              # 5138187
npx wrangler secret put GITHUB_APP_CLIENT_ID       # Iv23li8zKXvsEdSDTRYt
npx wrangler secret put GITHUB_APP_CLIENT_SECRET   # the client secret
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app-key.pkcs8.pem
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET      # the App's webhook secret
npx wrangler secret put JEV_API_KEY                # the Relay's Jev key (ADR 0003)
```

SESSION_SECRET signs every Person session; it must be at least 32 characters.
Changing it signs everyone out.

Until the App secrets and SESSION_SECRET are set, the Worker still deploys and
runs: sign-in shows "GitHub App not configured", and Channel calls answer 503 with
the same words.

The old secrets `JOIN_SECRET` and `GITHUB_TOKEN` are no longer read. Delete them
once this is deployed:

```sh
npx wrangler secret delete JOIN_SECRET
npx wrangler secret delete GITHUB_TOKEN
```

## 5. Repo setting

In the repo's Settings, General, Pull Requests, turn on **Automatically delete head
branches**, so each Task branch goes away when its pull request merges (ADR 0006).

## 6. Local development

`wrangler dev` reads secrets from the gitignored `worker/.dev.vars`. To try the real
App locally, put the same five App and session values there (the private key on
one line with `\n` for newlines works). Without them, turn on the dev-only fake
sign-in instead:

```sh
npx wrangler dev --var DEV_FAKE_GITHUB:true
```

It answers only requests to localhost. The Dashboard at
`http://localhost:8787/shlok1806/switchboard` then shows a "Dev sign-in" box, and the
CLI signs in with `switchboard login --url http://localhost:8787/shlok1806/switchboard
--dev-login <any login>`. Without the App, the Channel has no GitHub, so Tasks are
empty and membership is not checked.

## Checking it works

1. Open `https://switchboard.switchboard-worker.workers.dev/`; it goes to
   `/shlok1806/switchboard`. "Sign in with GitHub" goes to GitHub and back, signed in.
2. `switchboard login --url https://switchboard.switchboard-worker.workers.dev/shlok1806/switchboard`
   prints a code; enter it at github.com/login/device.
3. Claim a Task: the Issue gets its Person as assignee and one comment from
   `switchboard-shlok[bot]`, which later changes edit.
4. The App's Advanced tab lists each webhook delivery and the Worker's 204 answer.
