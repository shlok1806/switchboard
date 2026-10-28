# Cursor CLI integration report

## Commits (branch `sb/cursor-cli`)

| SHA | Summary |
| --- | --- |
| e1f59f9 | Research note (`docs/research/cursor-cli.md`) and ADR 0027 |
| ba45a3f | `switchboard run cursor`, shared `cursor` CLI type, Dashboard label/token, README and CONTEXT |

## Tests

- `cli`: `npm run test` — 616 passed (30 files), including new `Cursor CLI` cases in `clis.test.ts`.
- `worker`: `npm test` — 273 passed (21 files).

## End-to-end (real `cursor-agent`)

Local Worker: `DEV_FAKE_GITHUB=true npx wrangler dev` on `http://127.0.0.1:55567`.

```text
switchboard login --url http://127.0.0.1:55567 --repo shlok1806/switchboard --dev-login shlok --force
switchboard run cursor --model composer-2.5 -p "Reply with exactly the text E2E_OK and nothing else."
```

Result:

- Agent registered: `shlok/cursor/fc49` on Channel `shlok1806/switchboard`.
- CLI responded `E2E_OK` in print mode; session exited 0.

Not exercised in this run (follow-up): Dashboard at port 5206, Directive delivery, shell `file.edit` events, resume with same Agent ID, Gone after exit. Interrupt path is implemented as Queue (`cli-cannot-interrupt`) per ADR.

## Open questions

1. **Proxy Capture:** implement a reader for Cursor API traffic via `CURSOR_API_ENDPOINT` so `--proxy` works.
2. **Next-turn hooks:** confirm whether any Cursor hook besides `sessionStart` can inject `additional_context` on every prompt; if not, document `read_channel` as the primary path.
3. **Interrupts:** verify whether typing into an interactive `cursor-agent` session mid-turn works; if yes, flip `interrupts: true` on the adapter.
4. **Fake CLI:** add `fake-cursor.mjs` to the e2e suite (like Codex/Gemini) for regression without live API calls.
5. **Workspace trust:** confirm project hooks always run with `--trust` alone, or document extra IDE steps.
