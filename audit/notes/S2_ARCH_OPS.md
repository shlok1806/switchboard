# S2 — Architecture and operations, areas 8–14

Audit date: 2026-11-12. Read-only source audit of `shlok1806/switchboard`, supplied branch `bulletin`, HEAD `fe392689db002edb058eca9b6047be577c5bb656`. Read-only `git log -1` confirms the merge subject “Merge pull request #181 from shlok1806/dataset-archive”. All `path:line` citations are relative to `/home/box/engineering-workspace/worktrees/switchboard-bulletin`. Only this report was written. No network access, credential-file reads, clone modifications, installs, builds, tests, commits, pushes or deployments were performed. Tests below are **source evidence, never execution results**. The manager's baseline decides pass/fail separately.

Evidence tags: **[FACT-CODE]** inspected implementation; **[FACT-TEST]** inspected assertions of the named test; **[DOC-ONLY]** documentation statement, without a corresponding implementation assertion here; **[INFERENCE]** conclusion from cited evidence; **[RECOMMENDATION]** suggested follow-up. Status “Implemented and verified” means code plus a test that proves the stated slice in source, not that any test passed. Status applies to the described capability, not every possible deployment or provider.

Read `S1_ARCH_CORE.md` first. Cross-reference its §§0–7 for package inventory, lifecycle, adapters, claims, Relay, capture and memory. The implementation references relied on below were independently inspected. One correction to S1 §0.2: `scripts/channel.ts` is a small terminal client, not a history-index administration script: `main` joins, prints history, subscribes and posts typed Updates (`scripts/channel.ts:143-169`). Index maintenance is `createEventsTable`/`buildHistoryIndexes` inside the Channel (`worker/src/channel.ts:176-214`, `:278-320`).

## 8. Shared context, handoffs, leads, spawning, Brief and Librarian

### How it works today and storage

[FACT-CODE] Context transfer is several explicit mechanisms rather than a shared model context window. `Channel.agentSummary` combines roster identity, held Tasks, recent Updates, touched files, selected notes and predecessor/successor links; it also attempts local activity retrieval (`worker/src/channel.ts:882-939`). Transcript and terminal reads are request/reply exchanges with the target wrapper, not centrally stored transcripts (`Channel.readTranscript`, `Channel.readTerminal`, `worker/src/channel.ts:1223-1299`; reply ownership checks `:2018-2038`). This extends S1's memory/digest analysis: durable structured knowledge and machine-held detailed session data have different availability properties.

[FACT-CODE] `spawnAgent` validates a requested predecessor exists before selecting the Person or lead authority path (`worker/src/channel.ts:2208-2219`). `createMcpServer` exposes `agent_spawn` with a `from` identity and optional first-prompt brief (`cli/src/mcp-server.ts:1140-1165`). The contract describes the predecessor's brief as information and explicitly leaves Claims in place (`:1154-1161`). [FACT-TEST] `worker/test/handoff.test.ts:213-248`, “records the hand-off once, about the Task its predecessor works on, and moves no Claim”, actually checks one `agent.handoff`, `continues`, reverse `successors`, the predecessor's retained Task, and idempotent re-registration. It proves identity linkage and non-transfer of claims; it does not prove that a successor understood the prior work.

[FACT-CODE] Hosts are registered machine supervisors. SQL stores `hosts`, `host_resumes` and `host_spawns`; Host records contain owner, roots, maximum permission mode, allow-list and online bookkeeping (`HOSTS_SCHEMA`, `worker/src/hosts.ts:77-105`). `Hosts.spawn` checks roots, mode and caps, records a pending spawn and sends its ticket to the selected Host (`:399-508`). Registration completes the ticket and sets the parent where applicable (`:554-561`). Pending requests can outlive the HTTP wait; constants distinguish a 45-second default response wait from 120-second spawn/resume expiry (`:69-75`). A slow response therefore does not itself mean a failed launch.

[FACT-CODE] A Person grants/revokes the lead role through `Channel.setAgentRole`; an Agent cannot grant itself a role (`worker/src/channel.ts:1025-1035`). `lead` checks the stored role, and `sendDirective` additionally checks `inSubtree` (`:993-1022`). A lead may start children for its own Person, stop/direct its subtree, and cannot grant looser permission modes than its own known mode or the default (`Hosts.spawn`, `worker/src/hosts.ts:439-464`; `Hosts.control`, `:583-598`). Leads cannot list/register/remove Hosts or pause/resume Agents (`agentMayCall`, `worker/src/hosts-api.ts:85-88`). This is server enforcement, not merely an MCP description.

[FACT-CODE] `HOST_AGENTS_LIVE_CAP=20` limits Host-run or starting Agents across the Channel; `LEAD_AGENTS_LIVE_CAP=5` limits a lead's subtree, including pending descendant spawns (`worker/wrangler.jsonc:35-38`; `Hosts.spawn`, `worker/src/hosts.ts:453-464`; `leadRunning`, `:772-781`). These are not an organization-wide quota, and the Host cap is not a cap on every terminal-started wrapper. [FACT-TEST] `worker/test/hosts.test.ts:234-245`, “caps the Agents Hosts run on the Channel, counting those still starting”, seeds two completed and one pending spawn and asserts the fourth is refused at the test's cap of three. It verifies the accounting algorithm, not production capacity at twenty. Lead-cap test declarations and scenarios are at `worker/test/roles.test.ts:254-283`, including pending spawns beneath child leads.

[FACT-CODE] `Brief.write` replaces an entire Markdown page, records author/version/time, keeps a bounded earlier-version array and treats identical content/title as a no-op (`worker/src/brief.ts:162-206`). SQL `brief_pages` and `brief_budget` hold content and daily accounting (`:21-36`). Only Agent callers may write through `Channel.writeBriefPage`; ordinary Person sessions are refused (`worker/src/channel.ts:1433-1453`). Reads are available to both. Daily budget is configured at 200, separate from the 300 memory-note limit (`worker/wrangler.jsonc:39-42`). Whole-page replacement supplies no merge semantics in this write path; simultaneous editorial intent can overwrite prior content even though writes serialize at storage.

[FACT-CODE] The Librarian is a special Agent, with a persisted cursor (`LIBRARIAN_SCHEMA`, `worker/src/librarian.ts:21-28`) and a feed scanning changes after it (`librarianFeed`, `:135-166`). The local `LibrarianWaker` wakes on meaningful events and polls; its helpers compute remaining Brief budget and create a framed prompt (`cli/src/librarian.ts:105-115`, `:153-168`). Claude runs with `dontAsk`, strict MCP configuration, a fixed brief and denied execution/write tools (`librarianSettings`, `librarianArgs`, `:35-102`). Its MCP list has nine tools, including `brief_write` and read-only `github_read` (`:23-33`). Worker admission independently restricts the librarian token while allowing wrapper reports, stream traffic and tool-call reporting (`worker/src/index.ts:313-324`; `librarianMayCall`, `worker/src/librarian-api.ts:39-44`). “Writes Brief pages only” describes its business-writing authority; cursor/accounting and session telemetry are exceptions, not absent side effects.

### Interfaces, tests, documentation and limits

[FACT-CODE] HTTP includes Host registration/allow-list/spawn/stop/pause/resume, Agent role/summary/transcript/terminal, Brief and Librarian routes; see the complete tables in §12. CLI includes `switchboard role grant ... lead` (`worker/src/channel.ts:1020-1021`), `switchboard run claude --librarian` (`cli/src/librarian.ts:1-9`), and librarian launch through Hosts (command/Worker compatibility safeguards documented in ADR 0046, `docs/adr/0046-a-librarian-spawn-never-ends-as-a-plain-agent.md:15-17`). Spawn/control WS traffic is ticketed; the Worker accepts Host answers only from a tagged Host socket (`worker/src/channel.ts:1925-1959`).

[FACT-TEST] `worker/test/librarian.test.ts:278-286`, “is moved only by the librarian's token”, asserts ordinary Agent and Person cursor moves fail, an out-of-range move fails, and the librarian move succeeds. “writes Brief pages and reads the Channel, and is refused on everything else that writes” (`:291-317`) proves refusal for the sampled Update, note, Claim, Directive and spawn routes, plus successful Brief/read calls. Its name is broader than its enumerated assertions. “stops the librarian's Brief writes at three quarters…” (`:330-341`) proves the reserved share leaves room for another Agent. “fails the spawn and stops the Agent when a Host too old…” (`:398-415`) proves a 502 and emitted `host.stop`, not physical termination on a real machine.

[FACT-TEST] Brief tests “a rewrite replaces the page and keeps its last few versions; older ones are pruned” (`worker/test/brief.test.ts:166-190`) and “refuses a Person…” (`:212-221`) cover retention and writer identity. [DOC-ONLY] ADRs 0015/0018 still label themselves proposed (`docs/adr/0015-hosts-start-and-stop-agents-with-no-window.md:3`; `docs/adr/0018-a-person-may-make-an-agent-a-lead.md:3`), despite the concrete implementation above. ADR 0024 describes information-only handoffs (`docs/adr/0024-agents-carry-context-to-each-other.md:45-58`); ADRs 0042/0045/0046 define Brief, Librarian and compatibility hardening. [INFERENCE] Source supports these mechanisms but cannot establish autonomous editorial quality, successful semantic handoff or real-provider reliability.

**Status: Implemented and verified** for Host spawning, role-bound coordination, handoff linkage, Brief persistence and sampled librarian restrictions. Detailed historical context remains machine-dependent (`Channel.agentSummary`, `worker/src/channel.ts:886-894`). No missing implementation claim is made in this area.

## 9. Task execution, worktrees, GitHub synchronization and PRs

### Execution and ownership

[FACT-CODE] Switchboard coordinates work; a local provider CLI executes it. `SwitchboardTools.openBranch` calls `openTaskWorktree` after a claim, reports the branch, and explicitly retains the Claim when setup fails (`cli/src/mcp-server.ts:510-525`). `openWorktree` discovers origin's default branch, fetches it, reuses a correctly located worktree or creates a local/tracking/new branch and pushes it (`cli/src/task-worktree.ts:240-272`). `remoteMain` asks origin HEAD and falls back to `main` (`:179-182`), so actual behavior is more flexible than ADR 0006's main-centric wording (`docs/adr/0006-one-branch-and-pr-per-task.md:3`).

[FACT-CODE] Worktrees live under `.switchboard/worktrees/<branch>`; exclusion is local `.git/info/exclude` (`WORKTREES_DIR`, `exclude`, `cli/src/task-worktree.ts:21-25`, `:185-191`). `channelCheckout` rejects a directory outside the Channel repo, inconsistent origin/push URLs, bare repositories and separate-git-dir/submodule-style layouts (`:134-162`). This plain-clone constraint matters for adopting Switchboard in existing worktree fleets. The branch is durable Task metadata; release does not inherently remove it (`Branches.record`, `worker/src/branches.ts:56-82`).

[FACT-CODE] `finishTask` retrieves Task branch metadata, recovers/adopts a branch if needed, pushes from the task checkout and then asks the Worker to finish (`cli/src/mcp-server.ts:534-558`, `:582-593`). `Branches.finish` verifies the holder and branch, creates a closing PR against the API-reported default branch, marks review and mirrors labels/comment (`worker/src/branches.ts:89-153`). `RestGitHub.createPullRequest` handles 422 by finding an existing open PR for the same head/base (`worker/src/github/rest.ts:192-205`). Therefore repeated finish is idempotent in the persisted-review case and recoverable when a PR already exists; this is narrower than comprehensive detection of arbitrary manually opened PRs.

### Storage, synchronization and credentials

[FACT-CODE] Tasks are mirrored into Channel SQLite, with GitHub owning title/body/labels/blockers/subissues/checklist while Switchboard owns claims, branch, PR and intermediate workflow state (`worker/src/tasks.ts:1-8`, `mirroredFields`, `:95-110`; task schema `:130-144`). `ensureSynced` performs initial reconciliation; webhooks refresh named issues; alarms reconcile open issues and tracked tasks no longer open every five minutes, pooling eight reads (`:39-43`, `:194-220`, `:260-277`). `exclusive` serializes GitHub sync/write operations within that Tasks instance (`:239-243`). This is bidirectional for specific operations, not an unrestricted two-way document sync: issue creation, assignees, labels, comments and checklist body writes have explicit REST methods (`worker/src/github/rest.ts:97-103`, `:134-177`).

[FACT-CODE] Local git fetch/push runs with the machine's git/SSH/credential-helper environment and disables terminal credential prompts (`git`, `cli/src/task-worktree.ts:32-44`). Worker GitHub operations use `GitHubApp.repo` and cached installation tokens (`worker/src/github/app.ts:115-135`); `gitHubFor` selects that App client (`worker/src/github/index.ts:70-74`). A Person's Switchboard session authorizes the Channel call, not the git push. These credential planes should not be conflated: a valid Channel login cannot make a laptop's git authentication work.

[FACT-CODE] Signed webhook admission verifies the raw body before event dispatch, routes by payload repository and ignores disallowed/unrelated deliveries (`handleWebhook`, `worker/src/tasks-api.ts:84-109`). `Branches.codeEvent` compares commits and records bounded push/merge events keyed by delivery ID (`worker/src/branches.ts:161-205`). Issue closure drives done state; creating a PR drives review, not immediate completion (`:6-8`, `:126-135`). The Channel's claim does not sandbox shell access or prevent an Agent from editing elsewhere: local instructions tell it to use the worktree (`cli/src/mcp-server.ts:1000-1003`), while branch checks only govern these coordination operations.

### Tests, differences and limitations

[FACT-TEST] `worker/test/branches.test.ts:178-214`, “opens a pull request that closes the Issue and names the Agent, and puts the Task in review”, checks fake PR title/head/base/body, retained claim, labels, event and one creation call on repeated finish. It proves contract and state transitions with the fake GitHub, not actual GitHub's close-on-merge semantics. “stays with the Task after a release…” (`:166-173`) proves branch continuity across holders. “is refused without a branch…” (`:217-234`) checks the error path leaves claimed state and emits no review event.

[FACT-TEST] `cli/test/task-worktree.test.ts:96-162` includes “finds the clone from its root, a subdirectory, or one of its worktrees”, “never prints the credentials in an origin URL”, and “says what a checkout with its git directory elsewhere is…”. These assertions cover clone classification and diagnostics, not real remote credentials. [INFERENCE] There is a distributed boundary between claim, git operations, GitHub PR creation and SQLite state; `openBranch`'s retained claim and PR-422 recovery address particular partial failures, not a cross-system transaction (`cli/src/mcp-server.ts:520-525`; `worker/src/github/rest.ts:194-202`).

**Status: Implemented and verified** for task branch/report/finish coordination and tested refusal/idempotence paths; worktree-only execution is **Implemented but unverified** as a behavioral convention rather than a server-enforced filesystem boundary. Search performed before qualifying PR detection: `rg -n 'listPull|pullRequest|ensureSynced|SYNC|ttl|sync' worker/src/tasks.ts worker/src/github/rest.ts`, plus `rg -n 'findPullRequest|listPullRequests|pulls\?head' worker/src cli/src worker/test cli/test`; inspected `createPullRequest` explicitly. The concrete existing-PR lookup is reported above; no blanket “PR detection missing” conclusion is warranted.

## 10. Human permissions, approvals and security boundaries

### Admission, identity and authority

[FACT-CODE] `readCredential` accepts session bearer/cookie, Agent bearer, or an upgrade query token, verifies session signatures and checks cookie-carried changes/upgrades against an explicit foreign Origin (`worker/src/auth.ts:88-114`). `cookie` sets HttpOnly, Secure and SameSite=Lax (`:77-79`). A missing Origin is accepted by this generic check; it is not a strict requirement for every mutating request to carry an Origin. `signSession`/`verifySession` use HMAC-signed payloads with a 30-day TTL; Agent tokens use random bytes and stored SHA-256 hashes (`worker/src/session.ts:16-23`, `:51-99`). The Channel additionally checks repository membership and live token admission (`worker/src/channel.ts:691-698`).

[FACT-CODE] `handleChannel` applies an Agent route allow-list, self-only checks with explicit cross-Agent read exceptions, and librarian restrictions (`worker/src/index.ts:283-324`). Agent tokens cannot create Tasks, grant roles, take over claims, manage settings or administer Hosts through these routes; ordinary Agents can read Channel data, write their own Updates/notes, act on claims and publish shared content subject to each handler (`:202-223`, `:283-311`). Lead privileges remain bounded by role and subtree checks (§8). Cross-Agent transcript/summary/terminal reads are intentional Channel-wide access, not owner-private storage (`:305-308`).

[FACT-CODE] The Host's centrally advertised roots/mode/allow-list are explicitly advisory: a stolen Person session could re-register wider values (`worker/src/hosts.ts:28-32`). `checkFolderAndMode` resolves real paths against local roots and the locally installed maximum permission mode (`cli/src/host/check.ts:98-117`); the supervisor rechecks requesting Persons locally (`cli/src/host/supervisor.ts:19-20`). [FACT-TEST] `cli/test/host-check.test.ts:60-74`, “refuses a link inside a root that points out of it”, “refuses a path with .. in it…” and “refuses a mode looser than this Host's…” assert those specific path/mode refusals. Local roots limit launch location, not all subsequent filesystem access by a provider process.

### Approval, keyboard and prompt trust

[FACT-CODE] `AgentRoster.denyApproval` requires ownership, matching current prompt ID, `deniable`, no previous denial and a deliverable wrapper; it records the denied state/event (`worker/src/agents.ts:542-575`). There is a dedicated remote-deny path, not a dedicated remote-allow action in the route matcher (`worker/src/agents-api.ts:118-137`; routes listed below). [DOC-ONLY] ADR 0013 rejected direct remote approve, and ADR 0014 specifies held Claude permission hooks that fail to no decision (`docs/adr/0013-answering-an-agents-permission-prompts-away-from-its-terminal.md:61-66`; `docs/adr/0014-denying-a-claude-code-permission-prompt-from-the-channel.md:11-25`). S1's approval lifecycle applies; this report does not promote ADR statements about exact provider hook timing to observed runtime facts.

[FACT-CODE] Remote terminal typing is a separate, more powerful channel. `AttachGate.checkOne` requires a locally allowed key scoped to repo/Agent, verifies an ECDSA signature over repo, Agent, wrapper nonce, sequence, operation and text, and rejects replayed sequences (`cli/src/terminal/gate.ts:72-123`). Channel forwarding accepts terminal input only from an untagged Person socket, not Agent/Host sockets (`worker/src/channel.ts:1964-1969`). [DOC-ONLY] ADR 0022 explicitly supersedes ADR 0021's nonexclusive keyboard and allows an authorized typist to answer permission prompts (`docs/adr/0022-one-typist-holds-an-agents-keyboard.md:3`, `:16-34`). Thus “no remote approval” must mean the dedicated hook API: an authorized human typist can answer the real terminal's dialog. Treating the former as a universal prohibition would misdescribe the design.

[FACT-CODE] `maskSecrets` implements recognizable token/assignment masking, not a guarantee that arbitrary sensitive information is detected (`shared/src/mask.ts:1-7`, rules beginning `:39`). Shared skill publishing uses a distinct stricter publish-time check (`:3-5`). Dataset tests verify specific secret examples, not all secrets (§13). Langfuse connection keys are handled separately from public settings (`worker/src/mcp/server.ts:103-106`; tests below). [INFERENCE] A compromised wrapper can lie about its own telemetry; socket identity and field validation prevent cross-Agent impersonation through these handlers but do not attest truthfulness of a machine's reports (`worker/src/channel.ts:1971-2038`).

[FACT-CODE] Information-vs-instruction framing is present in local MCP instructions and agent listings (`cli/src/mcp-server.ts:1003-1014`, `:604-607`) and remote connector instructions (`worker/src/mcp/server.ts:145-152`). [DOC-ONLY] ADR 0005 and repository standing guidance describe respecting the Agent's own Person (`docs/adr/0005-agents-inform-only-people-instruct.md:3`; `AGENTS.md:19-25`). [INFERENCE] These frames cannot cryptographically enforce model obedience. The server can refuse unauthorized operations, but cannot guarantee that a model never follows injected text while using its own permitted tools. Extending toward central policy should retain this distinction.

### Tests, status and searches

[FACT-TEST] `worker/test/identity.test.ts:174-187`, “refuses a cookie-carried change from another site”, proves evil-Origin POST refusal and same-origin success; it does not test every browser CSRF condition or missing-Origin behavior. Membership cache/revocation scenarios are named at `:285-337`, including “re-checks write access at most every 5 minutes…” and “closes the stream…”. [FACT-TEST] `worker/test/cross-person.test.ts:56-131` covers owner attribution and an opted-in Host's cross-person use; `:112` is specifically “is not open to a lead, which stays on its own Person's Hosts”. Roles tests `worker/test/roles.test.ts:197-252` cover cross-person refusal and subtree reach. These supplement S1 identity/approval tests without implying penetration testing.

**Status: Implemented and verified** for sampled admission, role/Host and cross-site checks. Prompt-only authority conventions are **Implemented but unverified** as behavioral guarantees. Search scope for dedicated remote approve: `rg -n 'approval|approve|allow' worker/src/agents-api.ts worker/src/agents.ts cli/src/approvals.ts worker/test cli/test`; route enumeration and `denyApproval` show the dedicated operation is deny. This finding does not claim remote keyboard approval is unavailable. [RECOMMENDATION] Preserve separate tests and documentation for server authorization, local key authorization and model instruction framing (`worker/src/index.ts:283-324`; `cli/src/terminal/gate.ts:103-123`; `cli/src/mcp-server.ts:1013-1014`).

## 11. Dashboard, history and observability

[FACT-CODE] `App` lazily loads Now, Activity, Tasks/detail, Agents/detail, Canvas, Memory, Skills, Artifacts/viewer, Brief, Hosts and Settings (`dashboard/src/App.tsx:14-28`). It is a human client of shared Channel APIs, not a separate orchestration backend. `HttpSource` fetches latest history, pages older events, resolves IDs, and subscribes with a cursor (`dashboard/src/data/http.ts:221-285`, `:297-342`). `PersonAction` lists Update, Directive, takeover, proxy-mode, rename and deny as HTTP actions; those are not WS action frame names (`shared/src/channel.ts:61-74`).

[FACT-CODE] Events have an autoincrement sequence, unique ID, time/type/actor, optional Task/turn and JSON payload. Partial indexes cover code events and Updates by Task/actor (`createEventsTable`, `worker/src/channel.ts:176-214`). Additional scoped history indexes are built under a daily 25,000-row budget and 80,000-row ceiling (`HISTORY_INDEXES`, `INDEX_BUILD_BUDGET`, `INDEX_BUILD_CEILING`, `:217-250`; `buildHistoryIndexes`, `:278-320`). `handleHistory` returns 503 for pending indexes and 501 for an index above the ceiling, while retaining the general feed (`worker/src/index.ts:83-94`). This is a material degraded capability, not missing historical data by itself.

[FACT-CODE] Rich local activity is merged from attached wrappers/Hosts, and unavailable machines are reported as gaps (`Channel.withLocalEvents`, `worker/src/channel.ts:1670-1811`). `HttpSource` exposes the history gap information in its snapshot flow (`dashboard/src/data/http.ts:221-266`); S1 §0's central/local event distinction remains essential. [FACT-TEST] `worker/test/history.test.ts:108-179`, “merges what the Channel stores with what its wrapper keeps…” and “says which machine is away instead of failing…” test supplied local events and offline gap reporting. They do not prove recoverability if that machine's disk is lost.

[FACT-CODE] Model, context and usage are wrapper-reported observations: `AgentRoster.heartbeat` stores timestamped usage and context and broadcasts changes (`worker/src/agents.ts:650-680`). Display is therefore as current as reporting permits. `Orb` uses derived state (`dashboard/src/components/domain/state.tsx:87-101`), not inferred fine-grained cognition. [FACT-TEST] `dashboard/test/orb.test.tsx:80-102`, “shows each Agent's state beside its word…” and “follows the Agent live…”, checks working/breathing/listening and no orb for paused/gone plus approval transitions. The test mocks the visual component/data source; it is not GPU rendering or evidence that an Agent is actually thinking. Context tests “shows tokens, percent and compactions with exact warning thresholds” (`dashboard/test/context.test.tsx:18`) and usage tests “dims a reading older than 15 minutes” (`dashboard/test/usage.test.tsx:27`) target UI interpretation, not provider-account truth.

[FACT-CODE] Langfuse costs are live reads using the repo's configured project and opened keys (`worker/src/mcp/server.ts:103-108`); settings GET/PUT/DELETE manage the connection (`worker/src/settings-api.ts:24-48`). [FACT-TEST] `worker/test/costs.test.ts:209-254`, “keeps the secret key sealed at rest, and no route the Dashboard or the Connector calls sends it back”, covers stored ciphertext and sampled responses. “writes no row, and asks Langfuse three GETs per question with the project's keys” (`:412`) tests the tool's bounded read behavior. These are product-project costs, not a universal billing ledger for every coding-agent subscription (contrast heartbeat usage above).

[DOC-ONLY] ADR 0049 supersedes parts of ADRs 0016/0023 and defines five desk sections and existing hash-route preservation (`docs/adr/0049-the-dashboard-is-a-desk-in-five-sections.md:3`, `:27-43`). ADR 0047 deliberately maps coarse states rather than “searching/composing” (`docs/adr/0047-an-agents-state-shows-a-thinking-orb.md:9-30`). ADR 0053 adds sandboxed HTML artifacts (`docs/adr/0053-artifacts-html-pages-shown-in-a-sandbox.md:26-39`). [FACT-CODE] Artifact rendering sets response security headers in the handler and a sandbox contract (`worker/src/artifacts-api.ts:55-89`). [FACT-TEST] `dashboard/test/artifacts.test.tsx:238-257`, “frames the page of the version shown in the sandbox…”, checks iframe sandbox/src/referrer policy and links/reload. Attribute assertions do not prove every browser isolation behavior.

**Status: Implemented and verified** for mapped views, history/index behavior and sampled presentation. [FACT-TEST] `worker/test/history-indexes.test.ts:29-69` explicitly asserts deferred construction across dates and permanent too-large classification under reduced test budgets. [INFERENCE] The central feed, local activity, provider usage and external costs are distinct observational sources; a dashboard that displays all four still has partial/offline/stale states (`worker/src/channel.ts:1670-1811`; `worker/src/agents.ts:650-680`; `worker/src/mcp/server.ts:103-108`). No missing implementation claim is made here.

## 12. MCP, external integrations and API contracts

### Contract and authentication legend

[FACT-CODE] Shared TypeScript exports define domain/wire messages, but HTTP handlers still perform runtime checks (`shared/src/index.ts:1`; `matchAgentRoute`, `worker/src/agents-api.ts:118-137`; `handlePostUpdate`, `worker/src/index.ts:145-162`). The remote MCP is stateless JSON-RPC POST, not the local stdio server (`handleMcp`, `worker/src/mcp/server.ts:61-117`; `createMcpServer`, `cli/src/mcp-server.ts:994-1027`). Only remote access grants for the named repo are admitted, with a live grant/membership check on each call (`worker/src/mcp/server.ts:77-85`).

All tables are **[FACT-CODE]**. HTTP paths beginning `/api/` below have the external prefix `/r/:owner/:repo`; the sole exception `/api/github/webhook` is global. `P` = valid Person session plus Channel membership (GitHub write access); `A` = live Agent token plus its Person's membership. `P/A` does not waive ownership, holder, role or librarian checks. `R` = reads business data, `W` = changes business/local/session state, `R+audit` = read that can emit an access/tool event. Admission may refresh membership/cache even for R calls (`worker/src/index.ts:272-280`; `worker/src/channel.ts:696-698`). “Complete” inventories supported application routes and frame/tool names at this HEAD, not every rejected method, generated asset filename or internal DO RPC method.

### Complete HTTP route table

| Method | Path | Required auth / additional authority | R/W | Handler evidence |
|---|---|---|---|---|
| GET | `/api/events` | P/A | R | `handleHistory`, `worker/src/index.ts:97-142` |
| GET | `/api/persons` | P only | R | `handleChannel`, `worker/src/index.ts:347-348`, `:202-210` |
| GET | `/api/relay` | P/A | R | `handleChannel`, `worker/src/index.ts:349-350` |
| POST | `/api/join` | P | W | `handleJoin`, `worker/src/index.ts:77-80` |
| POST | `/api/updates` | P/A; own actor | W | `handlePostUpdate`, `worker/src/index.ts:145-162` |
| POST | `/api/directives` | P or lead A for subtree | W | `handleDirectiveRoute`, `worker/src/directives-api.ts:15`; `Channel.sendDirective`, `worker/src/channel.ts:993-1007` |
| GET | `/api/stream` | P/A; Host attachment P owner only | R/W transport | `handleStream`, `worker/src/index.ts:165-182` |
| GET | `/api/tasks` | P/A | R | `handleTaskRoute`, `worker/src/tasks-api.ts:30-47` |
| POST | `/api/tasks` | P | W to GitHub | `handleCreate`, `worker/src/tasks-api.ts:50-75`; Agent gate `worker/src/index.ts:288` |
| GET | `/api/tasks/:number` | P/A | R | `handleTaskRoute`, `worker/src/tasks-api.ts:30-47` |
| POST | `/api/tasks/:number/claim` | P/A; resolved holder | W | `handleClaimRoute`, `worker/src/claims-api.ts:65-72` |
| POST | `/api/tasks/:number/release` | P/A; holder | W | `handleClaimRoute`, `worker/src/claims-api.ts:73-74` |
| POST | `/api/tasks/:number/steps/:index/complete` | P/A; holder | W | `handleClaimRoute`, `worker/src/claims-api.ts:75-76` |
| POST | `/api/tool-calls` | P/A; Agent call reporting | W audit | `handleClaimRoute`, `worker/src/claims-api.ts:35`, `:77` |
| POST | `/api/tasks/:number/branch` | P/A; holder | W | `handleBranchRoute`, `worker/src/branches-api.ts:3-4`; `Branches.record`, `worker/src/branches.ts:56-74` |
| POST | `/api/tasks/:number/finish` | P/A; holder | W to GitHub | `Branches.finish`, `worker/src/branches.ts:89-153` |
| POST | `/api/tasks/:number/takeover` | P; stale claim | W | `matchTakeoverRoute`, `worker/src/takeover-api.ts:3`; Agent gate `worker/src/index.ts:285-300` |
| GET | `/api/agents` | P/A | R | `matchAgentRoute`, `worker/src/agents-api.ts:120-123` |
| POST | `/api/agents` | P; register/resume session | W | `handleAgentRoute`, `worker/src/agents-api.ts:267-271`; Agent kinds `worker/src/index.ts:211-223` |
| GET | `/api/accounts` | P/A | R | `matchAgentRoute`, `worker/src/agents-api.ts:120` |
| POST | `/api/agents/:id/heartbeat` | P owner / A self | W | `handleAgentRoute`, `worker/src/agents-api.ts:272-277` |
| POST | `/api/agents/:id/end` | P owner / A self | W | `handleAgentRoute`, `worker/src/agents-api.ts:278-281` |
| GET | `/api/agents/:id/touched-files` | P/A any target | R | `handleAgentRoute`, `worker/src/agents-api.ts:282-286`; gate `worker/src/index.ts:304` |
| GET | `/api/agents/:id/transcript` | P/A any target | R+audit | `handleAgentRoute`, `worker/src/agents-api.ts:287-294` |
| GET | `/api/agents/:id/summary` | P/A any target | R | `handleAgentRoute`, `worker/src/agents-api.ts:295-299` |
| GET | `/api/agents/:id/terminal` | P/A any target | R+audit | `handleAgentRoute`, `worker/src/agents-api.ts:300-303` |
| POST | `/api/agents/:id/proxy-mode` | P owner | W | `handleAgentRoute`, `worker/src/agents-api.ts:304-308` |
| POST | `/api/agents/:id/nickname` | P any target / A self | W | `handleAgentRoute`, `worker/src/agents-api.ts:309-313`; `worker/src/index.ts:301-311` |
| POST | `/api/agents/:id/model` | P owner / A self | W | `handleAgentRoute`, `worker/src/agents-api.ts:314-321` |
| POST | `/api/agents/:id/approval` | P owner / A self | W | `handleAgentRoute`, `worker/src/agents-api.ts:322-331` |
| POST | `/api/agents/:id/approval/deny` | P owner; deniable current prompt | W | `handleAgentRoute`, `worker/src/agents-api.ts:332-341`; `AgentRoster.denyApproval`, `worker/src/agents.ts:542-559` |
| PUT | `/api/agents/:id/role` | P owner | W | `handleAgentRoute`, `worker/src/agents-api.ts:342-346` |
| DELETE | `/api/agents/:id/role` | P owner | W | `handleAgentRoute`, `worker/src/agents-api.ts:347`; `Channel.setAgentRole`, `worker/src/channel.ts:1025-1035` |
| GET | `/api/hosts` | P | R | `matchHostRoute`, `worker/src/hosts-api.ts:60-62`, `:82-88` |
| POST | `/api/hosts` | P owner | W | `handleHostRoute`, `worker/src/hosts-api.ts:175-206` |
| DELETE | `/api/hosts/:name` | P owner | W | `matchHostRoute`, `worker/src/hosts-api.ts:68-69` |
| POST | `/api/hosts/:name/allow` | P owner; signed local change | W | `handleHostRoute`, `worker/src/hosts-api.ts:207-235` |
| POST | `/api/agents/spawn` | P allowed by Host / lead A own Host | W | `handleHostRoute`, `worker/src/hosts-api.ts:240-254`; `Channel.spawnAgent`, `worker/src/channel.ts:2208-2219` |
| POST | `/api/agents/:id/stop` | P allowed / lead A subtree | W | `handleHostRoute`, `worker/src/hosts-api.ts:255-259` |
| POST | `/api/agents/:id/pause` | P allowed by Host | W | `handleHostRoute`, `worker/src/hosts-api.ts:260-261`; `agentMayCall`, `:87-88` |
| POST | `/api/agents/:id/resume` | P allowed by Host | W | `handleHostRoute`, `worker/src/hosts-api.ts:260-261`; `agentMayCall`, `:87-88` |
| GET | `/api/memory` | P/A | R | `handleMemoryRoute`, `worker/src/memory-api.ts:14-15`, `:24` |
| POST | `/api/memory` | A writer (Person refused by domain rule) | W | `handleMemoryRoute`, `worker/src/memory-api.ts:72-76`; `Channel.writeNote`, `worker/src/channel.ts:1185-1194` |
| GET | `/api/skills` | P/A | R | `matchSkillRoute`, `worker/src/skills-api.ts:46` |
| GET | `/api/skills/:name` | P/A | R | `matchSkillRoute`, `worker/src/skills-api.ts:57` |
| POST | `/api/skills/:name` | P/A; publisher ownership | W | `matchSkillRoute`, `worker/src/skills-api.ts:58` |
| POST | `/api/skill-files` | P/A | W chunks | `matchSkillRoute`, `worker/src/skills-api.ts:47` |
| POST | `/api/skill-files/read` | P/A | R despite POST | `matchSkillRoute`, `worker/src/skills-api.ts:48` |
| GET | `/api/brief` | P/A | R | `matchBriefRoute`, `worker/src/brief-api.ts:22` |
| GET | `/api/brief/:page` | P/A | R | `matchBriefRoute`, `worker/src/brief-api.ts:31` |
| PUT | `/api/brief/:page` | A only | W | `matchBriefRoute`, `worker/src/brief-api.ts:32`; `Channel.writeBriefPage`, `worker/src/channel.ts:1438-1453` |
| GET | `/api/librarian` | P/A | R | `matchLibrarianRoute`, `worker/src/librarian-api.ts:30` |
| PUT | `/api/librarian` | librarian A only | W cursor | `matchLibrarianRoute`, `worker/src/librarian-api.ts:30`; proving test `worker/test/librarian.test.ts:278-286` |
| GET | `/api/github` | P/A | R live GitHub | `matchLibrarianRoute`, `worker/src/librarian-api.ts:31` |
| GET | `/api/artifacts` | P/A | R | `matchArtifactRoute`, `worker/src/artifacts-api.ts:41` |
| GET | `/api/artifacts/:name` | P/A | R metadata/content | `matchArtifactRoute`, `worker/src/artifacts-api.ts:51` |
| GET | `/api/artifacts/:name/page` | P/A | R sandboxed HTML/download | `matchArtifactRoute`, `worker/src/artifacts-api.ts:50`; response `:55-89` |
| PUT | `/api/artifacts/:name` | P/A; publisher ownership | W | `handleArtifactRoute`, `worker/src/artifacts-api.ts:97-101` |
| DELETE | `/api/artifacts/:name` | P first publisher only | W | `handleArtifactRoute`, `worker/src/artifacts-api.ts:91-95` |
| GET | `/api/settings/langfuse` | P only | R public connection metadata | `matchSettingsRoute`/handler, `worker/src/settings-api.ts:24-46`; Agent gate `worker/src/index.ts:253-254`, `:285-300` |
| PUT | `/api/settings/langfuse` | P Channel owner | W sealed connection | `handleSettingsRoute`, `worker/src/settings-api.ts:24-48` |
| DELETE | `/api/settings/langfuse` | P Channel owner | W | `handleSettingsRoute`, `worker/src/settings-api.ts:24-48` |
| POST | `/api/github/webhook` (global) | valid GitHub HMAC, no P/A | W | `handleWebhook`, `worker/src/tasks-api.ts:84-109` |
| GET | `/auth/config` | public | R | `handleAuthRoute`, `worker/src/auth-api.ts:98-106` |
| POST | `/auth/signout` | public cookie clearing | W session | `handleAuthRoute`, `worker/src/auth-api.ts:107-108` |
| GET | `/auth/github/start` | public starts GitHub flow | W auth state | `handleAuthRoute`, `worker/src/auth-api.ts:109-110` |
| GET | `/auth/github/callback` | matching state + GitHub code | W session | `handleAuthRoute`, `worker/src/auth-api.ts:111-112` |
| POST | `/auth/device/code` | public starts device flow | W external auth state | `handleAuthRoute`, `worker/src/auth-api.ts:113-114` |
| POST | `/auth/device/token` | valid device flow/GitHub result | W session | `handleAuthRoute`, `worker/src/auth-api.ts:115-116` |
| POST | `/auth/device/session` | valid device flow/GitHub result | W cookie session | `handleAuthRoute`, `worker/src/auth-api.ts:117-118` |
| GET | `/auth/dev/signin` | localhost + explicit fake-auth flag | W dev cookie | `handleAuthRoute`, `worker/src/auth-api.ts:119-120`; `devMode`, `worker/src/auth.ts:33-43` |
| POST | `/auth/dev/session` | localhost + explicit fake-auth flag | W dev session | same symbols, `worker/src/auth-api.ts:120`; `worker/src/auth.ts:42-43` |
| GET | `/.well-known/oauth-authorization-server` and suffix forms | public | R metadata | `handleOAuthRoute`, `worker/src/mcp/oauth.ts:169-173` |
| GET | `/.well-known/oauth-protected-resource/r/:owner/:repo/mcp` | public valid Channel path | R metadata | `resourceMetadata`, `worker/src/mcp/oauth.ts:200-215` |
| POST | `/oauth/register` | public; allowed redirect validation | W stateless client issuance | `handleOAuthRoute`, `worker/src/mcp/oauth.ts:187-188`; `allowedRedirect`, `:93-102` |
| GET | `/oauth/authorize` | Person sign-in required for consent/grant | R consent/auth flow | `handleOAuthRoute`, `worker/src/mcp/oauth.ts:189-190` |
| POST | `/oauth/authorize` | Person + valid consent/origin | W grant | `handleOAuthRoute`, `worker/src/mcp/oauth.ts:191-192` |
| POST | `/oauth/token` | code+PKCE or valid refresh grant | W token rotation | `handleOAuthRoute`, `worker/src/mcp/oauth.ts:193-194` |
| OPTIONS | OAuth-dispatched paths | public | R preflight | `handleOAuthRoute`, `worker/src/mcp/oauth.ts:163-164`; path scope `:69-75` |
| POST | `/r/:owner/:repo/mcp` | connector OAuth access token only | R tools; grant/cache admission | `handleMcp`, `worker/src/mcp/server.ts:61-117` |
| OPTIONS | `/r/:owner/:repo/mcp` | public | R preflight | `handleMcp`, `worker/src/mcp/server.ts:68` |
| GET | `/:owner/:repo[/]` | public shell; data requires P/A | R HTML | `handleDashboard`, `worker/src/index.ts:60-61`, `:363-369` |
| asset requests | generated static asset paths | public | R static bytes | `ASSETS` binding, `worker/wrangler.jsonc:10-19` |

### Complete MCP tool table

Local tools use stdio and the wrapper's private Agent identity/credential handover (`prepareSessionTools`, `cli/src/mcp-config.ts:67-105`; `createMcpServer`, `cli/src/mcp-server.ts:994-1027`). The auth column describes remote authority used by that local tool. R tools may report `tool.call`; `artifact_read` additionally writes a local copy. The librarian subset is exactly `LIBRARIAN_MCP_TOOLS`, not every local read tool (`cli/src/librarian.ts:23-33`).

| Interface/tool | Auth / scope | Read vs write | Registration or definition evidence |
|---|---|---|---|
| Local `list_tasks` | A | R | `createMcpServer`, `cli/src/mcp-server.ts:1030` |
| Local `claim_task` | A self | W claim + git worktree/push | same, `cli/src/mcp-server.ts:1038` |
| Local `release_task` | A holder | W | same, `cli/src/mcp-server.ts:1049` |
| Local `complete_step` | A holder | W GitHub checklist | same, `cli/src/mcp-server.ts:1057` |
| Local `post_update` | A self | W | same, `cli/src/mcp-server.ts:1065` |
| Local `read_channel` | A | R + local queue handover | same, `cli/src/mcp-server.ts:1084`, instructions `:1003-1004` |
| Local `list_agents` | A | R | same, `cli/src/mcp-server.ts:1100` |
| Local `rename` | A self | W nickname | same, `cli/src/mcp-server.ts:1111` |
| Local `finish_task` | A holder | W git push + PR/state | same, `cli/src/mcp-server.ts:1124` |
| Local `agent_spawn` | lead A own Person's Host | W process/ticket | same, `cli/src/mcp-server.ts:1141` |
| Local `agent_stop` | lead A subtree | W process control | same, `cli/src/mcp-server.ts:1168` |
| Local `send_directive` | lead A subtree | W | same, `cli/src/mcp-server.ts:1177` |
| Local `memory_note` | A self | W | same, `cli/src/mcp-server.ts:1198` |
| Local `memory_recent` | A | R | same, `cli/src/mcp-server.ts:1223` |
| Local `memory_search` | A | R | same, `cli/src/mcp-server.ts:1233` |
| Local `brief_read` | A | R | same, `cli/src/mcp-server.ts:1249` |
| Local `brief_write` | A, librarian daily share applies | W | same, `cli/src/mcp-server.ts:1269` |
| Local `agent_transcript` | A any target with wrapper | R+audit | same, `cli/src/mcp-server.ts:1290` |
| Local `agent_summary` | A any known target | R | same, `cli/src/mcp-server.ts:1312` |
| Local `agent_terminal` | A running target | R+audit | same, `cli/src/mcp-server.ts:1326` |
| Local `artifacts_list` | A | R | same, `cli/src/mcp-server.ts:1344` |
| Local `artifact_publish` | A as publisher | W Channel artifact | same, `cli/src/mcp-server.ts:1354` |
| Local `artifact_read` | A | R Channel + W local file | same, `cli/src/mcp-server.ts:1381`; instructions `:1012` |
| Local `skills_list` | A | R | same, `cli/src/mcp-server.ts:1404` |
| Local `skill_read` | A | R + local diff | same, `cli/src/mcp-server.ts:1414-1427` |
| Local `github_read` | librarian A only in advertised tool list | R live GitHub | same, `cli/src/mcp-server.ts:1429-1447` |
| Local `skill_publish` | A; gated skillWrites configuration, non-librarian | W Channel | same, `cli/src/mcp-server.ts:1450-1462` |
| Local `skill_install` | A read + local approval/digest convention | W local installation | same, `cli/src/mcp-server.ts:1464-1481` |
| Remote `channel` | OAuth channel:read; live grant/member | R | `channelTool`, `worker/src/mcp/tools.ts:71-113` |
| Remote `github` | same; App installation reads | R live GitHub | `TOOLS`, `worker/src/mcp/tools.ts:117`; `readOnlyGitHub`, `worker/src/mcp/server.ts:99-101` |
| Remote `brief` | same | R Brief | `TOOLS`, `worker/src/mcp/tools.ts:117`; restricted view `worker/src/mcp/server.ts:95-98` |
| Remote `costs` | same; configured Langfuse project | R external metrics | `TOOLS`, `worker/src/mcp/tools.ts:117`; `worker/src/mcp/server.ts:103-108` |

[FACT-CODE] Remote RPC methods are `initialize`, `ping`, `tools/list`, `tools/call`; unknown methods are rejected, batches cap at eight, and GET/SSE/session deletion are not supported (`respond`, `worker/src/mcp/server.ts:134-199`; `MAX_BATCH`, `:25`, `:68-71`). Read-only annotations match an explicitly read-only Channel/GitHub view, rather than relying only on the names (`:94-108`; `worker/src/mcp/tools.ts:62-67`).

### Complete WebSocket frame table

`C` = Channel; `P` = plain Person socket; `A` = owning Agent/wrapper socket; `H` = owning Host socket. Auth is inherited from `/api/stream` admission; below adds sender/target restrictions. Every row is a protocol frame name, distinct from event payload `event.type` (the open-ended business event union). The literal text keepalive is included separately.

| Frame type | Direction / auth | Read vs write | Contract / enforcement evidence |
|---|---|---|---|
| `event` | C→P/A | R event feed | `StreamMessage`, `shared/src/channel.ts:53` |
| `verdict` | C→P/A | R | same, `shared/src/channel.ts:54` |
| `agent` | C→P/A | R roster delta | same, `shared/src/channel.ts:55` |
| `task` | C→P/A | R task delta | same, `shared/src/channel.ts:56` |
| `person` | C→P/A | R membership delta | same, `shared/src/channel.ts:57` |
| `account` | C→P/A | R usage delta | same, `shared/src/channel.ts:59` |
| `hook` | A→C, own Agent | W telemetry | `HookMessage`, `shared/src/hooks.ts:37`; dispatch `worker/src/channel.ts:2064-2066` |
| `hook.ack` | C→A | R receipt/local queue consequence | `shared/src/hooks.ts:49` |
| `hook.refused` | C→A | R refusal | `shared/src/hooks.ts:50` |
| `proxy` | A→C, own Agent | W telemetry | `shared/src/proxy.ts:38`; dispatch `worker/src/channel.ts:2066` |
| `proxy.ack` | C→A | R receipt | `shared/src/proxy.ts:46` |
| `proxy.refused` | C→A | R refusal | `shared/src/proxy.ts:46` |
| `delivery` | C→target A | R coordination information | `shared/src/relay.ts:109` |
| `delivery.ack` | A→C self only | W delivery state | `shared/src/relay.ts:116`; `worker/src/channel.ts:2054-2061` |
| `directives` | C→target A | R queued instructions | `shared/src/directives.ts:59` |
| `directive.ack` | A→C self only | W acknowledgment | `shared/src/directives.ts:66`; `worker/src/channel.ts:2054-2061` |
| `interrupt.attach` | A→C self only | W socket attachment | `shared/src/relay.ts:217`; `worker/src/channel.ts:1991-2009` |
| `interrupt.attached` | C→A | R receipt | `shared/src/relay.ts:229`; `worker/src/channel.ts:2005` |
| `interrupt` | C→target A | W local prompt delivery request | `shared/src/relay.ts:235` |
| `interrupt.result` | A→C self only | W delivery result | `shared/src/relay.ts:244`; `worker/src/channel.ts:2012-2015` |
| `directive.interrupt` | C→target A | W local instruction delivery request | `shared/src/directives.ts:73` |
| `directive.result` | A→C self only | W result | `shared/src/directives.ts:79`; `worker/src/channel.ts:2012-2015` |
| `wake` | A→C self only | W wake accounting | `shared/src/wakes.ts:44`; `worker/src/channel.ts:2041-2051` |
| `wake.capped` | A→C self only | W capped accounting | `shared/src/wakes.ts:54`; `worker/src/channel.ts:2041-2047` |
| `approval.deny` | C→owning A; P-authorized action | W local held-hook denial | `shared/src/approvals.ts:78`; `worker/src/channel.ts:2074-2083` |
| `transcript.request` | C→target A | R request | `shared/src/transcript.ts:50` |
| `transcript.page` | A→C matching pending request | R content; audit of read | `shared/src/transcript.ts:59`; `worker/src/channel.ts:2018-2027` |
| `terminal.read.request` | C→target A | R screen request | `shared/src/terminal.ts:166` |
| `terminal.text` | A→C matching request | R content; audit of read | `shared/src/terminal.ts:173`; `worker/src/channel.ts:2030-2038` |
| `terminal.watch` | P→C only | W ephemeral subscription | `shared/src/terminal.ts:48`; `worker/src/channel.ts:1964-1968` |
| `terminal.watchers` | C→A | R watcher state | `shared/src/terminal.ts:55`; `worker/src/channel.ts:2007` |
| `terminal.input` | P→C→A; local signed-key gate | W keyboard/process input | `shared/src/terminal.ts:68`; `worker/src/channel.ts:1964-1968`; `AttachGate`, `cli/src/terminal/gate.ts:103-123` |
| `terminal.screen` | A→C→watchers, own Agent only | R screen content | `shared/src/terminal.ts:22`; `worker/src/channel.ts:1971-1988` |
| `terminal.refused` | A→C→watchers, own Agent | R refusal | `shared/src/terminal.ts:85`; `worker/src/channel.ts:1971-1988` |
| `terminal.attached` | A→C own Agent | W attachment audit event | `shared/src/terminal.ts:95`; `worker/src/channel.ts:1974-1983` |
| `host.spawn` | C→chosen H | W process launch request | `shared/src/hosts.ts:194`; `Hosts.spawn`, `worker/src/hosts.ts:468-508` |
| `host.spawned` | C→H after registration | R completion receipt | `shared/src/hosts.ts:218`; `worker/src/hosts.ts:554-561` |
| `host.spawn.failed` | H→C own ticket | W failed spawn state | `shared/src/hosts.ts:267`; `worker/src/channel.ts:1925-1930` |
| `host.stop` | C→H | W process stop | `shared/src/hosts.ts:228` |
| `host.pause` | C→H | W pause | `shared/src/hosts.ts:234` |
| `host.resume` | C→H | W resume | `shared/src/hosts.ts:240` |
| `host.paused` | H→C own Agent/Host | W confirmation/token lifecycle | `worker/src/channel.ts:1941-1949` |
| `host.control.failed` | H→C own Host | W result | `shared/src/hosts.ts:247`; `worker/src/channel.ts:1941-1958` |
| `host.allow` | C→H; signed owner change | W local allow-list request | `shared/src/hosts.ts:312` |
| `host.allow.result` | H→C own Host | W acknowledged configuration result | `shared/src/hosts.ts:318`; `worker/src/channel.ts:1933-1938` |
| `history.request` | C→H/A advertising local-history support | R local events request | `shared/src/history.ts:48`; `Channel.withLocalEvents`, `worker/src/channel.ts:1670-1811` |
| `history.page` | H/A→C matching source/request | R local data | `shared/src/history.ts:61-62`; `worker/src/channel.ts:1921-1923` |
| literal `ping` / `pong` | admitted client→C / C→client | R liveness | `Channel` auto-response, `worker/src/channel.ts:530-531`; `LIVE_PONG` use `cli/src/channel-client.ts:319-320` |

### Integration tests, differences and status

[FACT-TEST] `worker/test/ask-channel.test.ts:644`, “the access token reaches no Channel API route, and the endpoint takes no other credential”, tests credential separation. “refuses a code without its PKCE verifier” (`:461`), “refreshes, rotating the refresh token, and a replayed one ends the sign-in” (`:373`), and “no tool it lists writes a row, whatever it is asked” (`:676`) provide source evidence for specific OAuth/read-only boundaries. The credential-separation test enumerates selected HTTP routes rather than every route in the table (`worker/test/ask-channel.test.ts:648-673`). The last name should not be generalized to every possible external integration: it checks the test's tools/inputs and row accounting. GitHub tool test “writes no row…calls GitHub at most three times per question” is `worker/test/ask-github.test.ts:316`; Langfuse has its own test (§11).

[DOC-ONLY] ADR 0040 calls for an OAuth read-only connector; ADR 0041 adds live GitHub, ADR 0044 costs. [FACT-CODE] This HEAD lists four tools (`TOOLS`, `worker/src/mcp/tools.ts:117`), so references to a “fifth tool” in ADR 0044's framing are not a five-tool runtime inventory (`docs/adr/0044-the-costs-tool-reads-the-repos-own-langfuse.md:3`). [FACT-CODE] OAuth grant state is stored in `mcp_grants` with owner/client/expiry indexes, refresh generation and a five-grant cap per Person/app (`McpGrants`, `worker/src/mcp/grants.ts:15-34`); authorization codes expire in sixty seconds and consent in ten minutes (`worker/src/mcp/tokens.ts:15-18`). **Status: Implemented and verified** for the connector and sampled authentication/row-write constraints; external availability remains outside this audit. No network was used to verify OAuth interoperability with current consumer applications.

## 13. Tests, simulation and reusable agent datasets

[FACT-CODE] Reuse S1 §0.3 for the test-source inventory; declaration counts are not pass counts. Worker tests can install interface fakes (`installGitHub`, `installGitHubSignIn`, `worker/src/github/index.ts:39-57`) and a fake App HTTP backend (`installGitHubApp`, `:47-52`). Files include `worker/test/fake-github.ts:1`, `fake-github-api.ts:1`, `fake-jev.ts:1`, `fake-langfuse.ts:1`. These offer controlled identities, mutations, refusals and coordination inputs without requiring real provider accounts. They model dependencies rather than measuring model decisions.

[FACT-CODE] CLI e2e runs the built wrapper in real PTYs around fake provider executables and local Wrangler (`cli/test/e2e.test.ts:1-4`), giving a reusable integration harness across process, HTTP and WS boundaries. Example scenarios include transcript/handoff (`:4767`, `:4862`), silent sockets (`:5028`), connection exhaustion/backoff (`:5169`, `:5206`), and shared artifact round trips (`:5529`). These declarations describe intended assertions; only tests whose assertion bodies were inspected elsewhere in this report are used as proving evidence. No e2e command ran here, and a fake provider does not establish actual Claude/Codex model compliance.

[FACT-CODE] `scripts/channel.ts` is an interactive operator probe: `main` joins with timezone, reads history, opens the stream and POSTs entered Updates (`scripts/channel.ts:143-169`). `scripts/dev-worker.ts` supervises Wrangler, reports port/PIDs, watches ancestor liveness and terminates after parent exit (`:55-84`). Neither is a multi-agent model-quality evaluator. Dashboard screenshot tooling uses the mock Channel with frozen time/events, enumerates views and light/dark desktop/phone states, checks markers/layout and writes pictures (`dashboard/scripts/shots.mjs:1-14`, `:26-40`). Its output is useful for UI regression review, not evidence that coordination work succeeds.

[FACT-CODE] Dataset collection is local and versioned: `syncDataset` discovers session files, fingerprints inputs, locks collection, writes records and indexes (`cli/src/dataset/sync.ts:89-143`, `:193-232`, `:351-375`). `DatasetTrigger` supplies automatic collection scheduling (`cli/src/dataset/command.ts:215`); CLI usage exposes sync/stats (`:13-18`, `datasetCommand`, `:197`). `keeps` applies configured source/account filtering (`cli/src/dataset/sources.ts:160`); `linkOutcome` joins repo/commit/PR/Channel/Greenroom context (`cli/src/dataset/outcomes.ts:227`; `channelOutcome`, `:181`). This is the implementation introduced by the #181 dataset-archive merge, confirmed by read-only HEAD log, not an unmerged proposal.

[DOC-ONLY] `docs/dataset.md:9-23` specifies schema/source/session/turn/outcome/redaction/state/cache files under the local dataset directory. Session records include CLI/account/threads/workflows/models/counts/tokens; turns distinguish prompts, context, assistant messages and tool results (`:40-73`). Corrections preserve the original words; `redirect` is a heuristic candidate while rejected-tool/interrupted are CLI-derived (`:75-83`). Outcomes include merge/revert/claim/steps/Greenroom links and explicit unlinked reasons (`:85-100`). These labels are not a supervised quality score, and “merged” need not mean correct.

[FACT-TEST] `cli/test/dataset.test.ts:233-271`, “copies the owner's session with its subagents and workflow run, every secret redacted”, asserts three supplied secret values are absent, masking markers are present, expected thread IDs and token deduplication/counts match, and redaction kinds/counts are recorded. The name's “every secret” means those fixture values, not arbitrary secret discovery. “resumes after a sync that stopped, and runs one at a time” (`:396-406`) deletes state, supplies a stale lock and checks deterministic recopy; a live PID lock skips. This proves the simulated failure/lock cases, not atomicity under every possible interruption. “keeps only the accounts sources.json lists” (`:409-425`) verifies exclusion and removal on account-list change. The Codex parser scenario is named at `:428`, distinct from the Claude/workflow fixture.

[INFERENCE] The reusable benchmark foundation is strong at infrastructure simulation and weak at establishing model quality: controlled fakes can test exclusive claims, stale recovery, handoff metadata, unauthorized actions and event ordering; local datasets can provide prompts, outputs and outcome links for later analysis (`worker/test/handoff.test.ts:213-248`; `worker/test/roles.test.ts:197-252`; `cli/test/dataset.test.ts:233-271`). A benchmark would still need explicit tasks, success criteria and a scoring procedure. **Status: Implemented and verified** for sampled dataset, fake-backed coordination and UI assertions; a dedicated coordination-quality benchmark is **Not implemented** within the searched sources.

Search performed for that negative finding: `rg -n 'eval|benchmark|simulation|simulator' worker/test cli/test scripts dashboard/test docs/dataset.md` found no evaluator/simulator implementation (one incidental test string matched); broader `rg -n 'benchmark|evaluation|evals|scor(e|ing)|simulation|simulator' worker/src cli/src worker/test cli/test scripts docs/dataset.md` found lexical search scoring in `ask.ts`/`mcp/github.ts`, not agent-outcome scoring. [RECOMMENDATION] Build an evaluator around the existing fakes and redacted outcome schema rather than treating dataset collection or a screenshot gate as an evaluation result (`worker/src/github/index.ts:39-57`; `cli/src/dataset/outcomes.ts:227`; `dashboard/scripts/shots.mjs:1-9`).

## 14. Deployment, persistence, recovery and limits

### Topology, state and deployment

[FACT-CODE] One Cloudflare Worker serves the HTTP entrypoint/static assets and exports one SQLite Durable Object class, `Channel`; the binding/migration is `CHANNEL` / `new_sqlite_classes: [Channel]` (`worker/wrangler.jsonc:4-23`; `worker/src/index.ts:56`). `channelOf` selects a DO by canonical repo name (`worker/src/index.ts:63-65`). The Channel constructor creates/migrates subsystem schemas, composes stores and configures hibernation-compatible ping/pong (`worker/src/channel.ts:490-575`). This supports per-repo isolation of coordination state, not a separate server or database for each Person.

[FACT-CODE] Storage is split: SQLite for Channel domain/index/budget/auth rows, DO storage for subsystem data, machine-local stores/session transcripts for rich activity, git/GitHub for source and issues, and Langfuse for external cost metrics (`worker/src/channel.ts:496-529`, `:538-545`; `Channel.withLocalEvents`, `:1670-1811`; `worker/src/mcp/server.ts:99-106`). Durable state should not be confused with in-memory request waiters: transcript/terminal replies resolve pending maps (`worker/src/channel.ts:2018-2038`), so process interruption during a pending read can fail that request even though domain rows survive.

[FACT-CODE] CI's deployment job serializes production deployment, checks whether its commit is still latest main, installs Worker/dashboard dependencies and invokes Wrangler using a CI-provided credential (`.github/workflows/ci.yml:85-127`; upstream job requirements/start conditions `:78-84`). Build-site is a Wrangler build hook with assets bound from `site` (`worker/wrangler.jsonc:10-19`). [DOC-ONLY] ADR 0004 describes centrally hosted coordination and rejects dependency on one Person's laptop; it calls Jev a binding (`docs/adr/0004-central-relay-hosted-on-cloudflare.md:3`). [FACT-CODE] Current Wrangler declares only the Channel DO and static assets, while Relay uses an API-key configuration (`worker/wrangler.jsonc:19-23`, `:59-66`; `HttpJev`, `worker/src/relay/jev.ts:66-85`). The historical ADR phrase is not the current binding inventory.

### Failure and recovery behavior

[FACT-CODE] `Channel.alarm` dispatches due task, presence, membership, Host and Directive work and rearms in `finally` (`worker/src/channel.ts:672-682`). `Tasks.alarm` retries periodic reconciliation even after a GitHub exception (`worker/src/tasks.ts:200-210`). `AgentRoster.expireSilent` marks nonpaused Agents Gone after configured heartbeat silence; Gone revokes tokens/closes their sockets through the roster callback (`worker/src/agents.ts:703-721`; `worker/src/channel.ts:554-559`). Paused Agents are excluded and stale heartbeats do not revive them (`worker/src/agents.ts:659-660`, `:711`). A machine disappearing does not transfer its claims automatically; S1 stale-claim/takeover analysis applies, independently supported by non-transfer handoff assertions (§8).

[FACT-CODE] A Host becomes Offline only after a 30-second grace; pending spawns and resume tickets expire after two minutes (`worker/src/hosts.ts:69-75`). Host reconnect can suppress flapping online/offline events (`Hosts` documented state-machine contract, `:8-15`; exercised `worker/test/hosts.test.ts:85`). The supervisor stores running/paused sessions and resumes unexpected wrapper exits subject to `MAX_RESUMES=3`; it distinguishes requested/clean exit from a crash (`cli/src/host/supervisor.ts:13-22`, `:58`, `:650-680`). This is bounded process supervision, not live migration to a replacement machine. A launch request sent to a dead Host eventually fails; it does not imply an Agent was launched elsewhere.

[FACT-CODE] `ChannelClient` limits HTTP requests in flight to four (`cli/src/channel-client.ts:42`, `:180-182`). WS reconnect uses jittered exponential `Backoff`; a silent socket is destroyed and a replacement scheduled, with reset only after a pong (`cli/src/channel-net.ts:38-70`; `cli/src/channel-client.ts:276-320`). `openSocket` sets a handshake timeout, `closeSocket` sends code 1000 and terminates after three seconds, and `dropSocket` destroys immediately (`cli/src/channel-socket.ts:18-46`). Host backoff caps at sixty seconds (`cli/src/host/supervisor.ts:168`); wrapper socket cap is thirty (`cli/src/channel-client.ts:51`). Dashboard uses its own reconnect loop capped at ten seconds and periodic ping, not the CLI's identical mechanism (`dashboard/src/data/http.ts:297-342`).

[DOC-ONLY] ADR 0048 explains half-open sockets and explicitly says the Channel does not itself drop a silent wrapper before reconnect (`docs/adr/0048-a-silent-socket-is-replaced.md:13-21`). ADR 0052 adds socket deadlines, jitter and resource-exhaustion protection (`docs/adr/0052-one-bad-channel-cannot-take-the-machine-down.md:19-27`). [INFERENCE] Those changes reduce client-induced exhaustion; source inspection cannot establish a global production uptime guarantee. Machine-held history remains unavailable during machine loss, with gaps rather than fabricated continuity (`worker/test/history.test.ts:138-151`; `Channel.withLocalEvents`, `worker/src/channel.ts:1670-1811`).

### Limits, tests and architectural constraints

[FACT-CODE] Checked-in operational defaults: Gone after 600 seconds; Relay interrupt probability threshold 0.6 and interval 20 seconds; Host-run cap 20; lead subtree cap 5; notes/day 300; Brief writes/day 200; artifact publishes/day 200; transcript response wait 10 seconds; local-history wait 3 seconds; spawn HTTP wait 45 seconds; Directive attach wait 5 seconds; Quiet claims after four hours (`worker/wrangler.jsonc:29-54`). History pages cap at 1,000 events, ID reads at 100, Updates at 4,000 characters and addressees at 20 (`shared/src/channel.ts:122-132`). These values bound particular operations and do not state sustainable total throughput.

[FACT-CODE] Scoped index construction can be **Blocked by a current architectural constraint** when the selected index exceeds the 80,000-event ceiling; `handleHistory` deliberately returns 501 (`worker/src/channel.ts:244-250`; `worker/src/index.ts:83-94`). [FACT-TEST] `worker/test/history-indexes.test.ts:60-69`, “never builds an index past the ceiling, and keeps saying so without counting again”, asserts the too-large index stays classified across later dates while smaller indexes build. The test uses small synthetic ceilings; it proves the decision logic, not the production workload's exact row usage. “charges the actor columns' one-time backfill…” (`:73-90`) checks migration accounting and copied actor IDs.

[INFERENCE] One DO named by repo is the central coordination partition, so a very busy Channel concentrates its SQL/event and websocket work there (`channelOf`, `worker/src/index.ts:64-65`; `Channel` composition, `worker/src/channel.ts:490-575`). No region pin is specified in that lookup/config; this audit cannot assert a particular physical region or cross-region recovery behavior. A DO-per-channel design is not evidence of application-level active-active replicas. **Status: Implemented and verified** for source-evidenced persistence schemas, index budgeting and sampled recovery rules; production deployment and real failure recovery are **Implemented but unverified** by this audit, with the scoped-index constraint qualified above.

Search performed before identifying deployment/recovery gaps: `rg -n 'failover|replica|backup|restore|locationHint|jurisdiction' worker/src cli/src worker/test cli/test scripts` found client configuration restore/test mock restore uses, not an application-level Channel failover/backup implementation. Inspected complete `worker/wrangler.jsonc` and `channelOf` as topology evidence. **Not implemented** within those searched sources: an application-managed Channel replication/failover or backup/restore workflow. This says nothing about Cloudflare's internal durability or available platform features, which were not queried. [RECOMMENDATION] Validate restoration, machine-loss behavior and large-channel degraded reads in an authorized operational exercise before promising organizational continuity (`worker/src/channel.ts:1670-1811`; `worker/src/index.ts:83-94`).

## Open questions and uncertainties

- [INFERENCE] Which baseline checks pass at this HEAD remains unanswered here. This audit executed none; CI defines checks and deployment prerequisites, but configuration is not an execution record (`.github/workflows/ci.yml:1-84`).
- [INFERENCE] Which provider versions honor every hook/settings restriction in a deployed fleet needs real-provider validation; local e2e deliberately substitutes agent CLIs (`cli/test/e2e.test.ts:1-4`; librarian settings `cli/src/librarian.ts:55-102`).
- [INFERENCE] How should central policy distinguish a human's signed keyboard approval from a rejected direct remote-approve API? Current mechanisms intentionally have different boundaries (`cli/src/terminal/gate.ts:103-123`; `docs/adr/0022-one-typist-holds-an-agents-keyboard.md:16-34`).
- [INFERENCE] Who owns conflict resolution for two Agents rewriting the same Brief page? Current `Brief.write` replaces the page and retains versions, without a compare-version argument in that method (`worker/src/brief.ts:162-206`).
- [INFERENCE] What retention/export/recovery commitment is needed for permanently lost local history? Current reads report machine gaps; the dataset is local and account-filtered, not a shared transcript archive (`worker/src/channel.ts:1670-1811`; `cli/test/dataset.test.ts:409-425`).
- [INFERENCE] What production workload crosses the history-index ceiling or per-day budgets? Constants and synthetic assertions establish constraints, not observed capacity (`worker/src/channel.ts:244-250`; `worker/test/history-indexes.test.ts:29-69`; `worker/wrangler.jsonc:35-54`).
- [INFERENCE] What benchmark labels distinguish useful collaboration from merely merged work? Existing outcome links and heuristic correction labels are reusable evidence, but require a defined evaluation protocol (`docs/dataset.md:75-100`; `cli/src/dataset/outcomes.ts:227`).
- [INFERENCE] Organizational vendor-neutral policy will need a decision about identity and policy scope beyond the current GitHub repo membership/Person/Agent/lead boundaries. The current extension points are concrete, but those boundaries are repo-centered (`worker/src/auth.ts:53-66`; `worker/src/index.ts:272-324`; `worker/src/channel.ts:1014-1035`).
