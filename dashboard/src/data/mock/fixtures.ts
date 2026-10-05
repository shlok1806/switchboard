import type {
  Actor,
  Agent,
  AgentId,
  Capture,
  ChannelEvent,
  DiffHunk,
  DiffLine,
  EventPayloads,
  EventType,
  FileChange,
  Person,
  Task,
  TaskNumber,
  VerdictProbabilities,
} from "@shared/index";

/* ── ids ──────────────────────────────────────────────────── */

export const ME = "shlok";

export const A = {
  shlokClaude: "shlok/claude/7f3a",
  shlokCodex: "shlok/codex/c91e",
  shlokCodexOld: "shlok/codex/0a11",
  mayaClaude: "maya/claude/2b8d",
  mayaGemini: "maya/gemini/e40a",
  devClaude: "dev/claude/91c2",
} as const satisfies Record<string, AgentId>;

/** Files each Agent has touched. The mock Relay uses them to work out overlap. */
export const AGENT_FILES: Record<string, string[]> = {
  [A.shlokClaude]: ["web/src/api/client.ts", "web/src/api/index.ts"],
  [A.shlokCodex]: ["AGENTS.md", "docs/agents/channel.md"],
  [A.mayaClaude]: ["web/src/pages/users.tsx", "web/src/components/Pager.tsx"],
  [A.mayaGemini]: ["web/src/pages/settings.tsx", "web/src/lib/validate.ts"],
  [A.devClaude]: ["web/src/api/client.ts", "web/src/api/retry.ts"],
};

/** Symbols each Agent recently used. A removed or renamed one is the strongest overlap signal. */
export const AGENT_SYMBOLS: Record<string, string[]> = {
  [A.mayaClaude]: ["getJson", "Pager", "useUsers"],
  [A.devClaude]: ["getJson", "ApiError"],
  [A.shlokCodex]: [],
};

/* ── clock ────────────────────────────────────────────────── */

export const T0 = Date.now();
export const ago = (seconds: number) => new Date(T0 - seconds * 1000).toISOString();

/* ── Persons and Agents ───────────────────────────────────── */

export const persons: Person[] = [
  { name: "shlok", timeZone: "America/New_York", joinedAt: ago(60 * 60 * 5) },
  { name: "maya", timeZone: "Europe/Lisbon", joinedAt: ago(60 * 60 * 4) },
  { name: "dev", timeZone: "Asia/Kolkata", joinedAt: ago(60 * 60 * 3) },
];

export const agents: Agent[] = [
  {
    id: A.shlokClaude,
    person: "shlok",
    cli: "claude-code",
    nickname: "api-client",
    account: "sh…@illinois.edu",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: ago(4),
    startedAt: ago(60 * 52),
  },
  {
    id: A.shlokCodex,
    person: "shlok",
    cli: "codex",
    account: "work",
    presence: "idle",
    proxyMode: "raw",
    secretMasking: true,
    canReceiveInterrupts: false,
    lastSeenAt: ago(60 * 3),
    startedAt: ago(60 * 40),
  },
  {
    id: A.mayaClaude,
    person: "maya",
    cli: "claude-code",
    nickname: "users-page",
    account: "ma…@gmail.com",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: ago(9),
    startedAt: ago(60 * 70),
  },
  {
    id: A.mayaGemini,
    person: "maya",
    cli: "gemini",
    presence: "gone",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: false,
    lastSeenAt: ago(60 * 23),
    startedAt: ago(60 * 95),
  },
  {
    id: A.devClaude,
    person: "dev",
    cli: "claude-code",
    nickname: "retry",
    presence: "live",
    proxyMode: "raw",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: ago(2),
    startedAt: ago(60 * 31),
  },
  {
    id: A.shlokCodexOld,
    person: "shlok",
    cli: "codex",
    presence: "gone",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: false,
    lastSeenAt: ago(60 * 60 * 2),
    startedAt: ago(60 * 60 * 4),
  },
];

/* ── Tasks ────────────────────────────────────────────────── */

const steps = (done: number, ...texts: string[]) =>
  texts.map((text, i) => ({ index: i + 1, text, done: i < done }));

/** GitHub-derived fields the mock fills in, as the Worker's GitHub sync does. */
type SeedTask = Omit<Task, "subtasksDone" | "stepsDone" | "url">;

export const REPO = "shlok1806/app";

/** Recompute the counts GitHub sync derives, after a Step or Subtask changes. */
export function withCounts(t: SeedTask | Task, all: (SeedTask | Task)[]): Task {
  return {
    ...t,
    url: `https://github.com/${REPO}/issues/${t.number}`,
    stepsDone: t.steps.filter((s) => s.done).length,
    subtasksDone: t.subtasks.filter((n) => all.find((x) => x.number === n)?.status === "done").length,
  };
}

const seedTasks: SeedTask[] = [
  {
    number: 11,
    title: "API client cleanup",
    description: "Tidy web/src/api before the dashboard migration. Split into Subtasks.",
    labels: ["api", "epic"],
    blockedBy: [],
    subtasks: [12, 13, 15, 16],
    steps: [],
    status: "open",
    updatedAt: ago(60 * 60),
  },
  {
    number: 12,
    title: "Rename getJson to request in the API client",
    description:
      "getJson now takes a RequestInit too, so it is no longer only for JSON GETs. Rename it to request and update every caller.",
    labels: ["api", "refactor"],
    blockedBy: [],
    parent: 11,
    subtasks: [],
    steps: steps(
      0,
      "Rename the export in web/src/api/client.ts",
      "Update callers in web/src/api",
      "Update callers in web/src/pages",
      "Run typecheck and tests",
      "Open the PR",
    ),
    status: "claimed",
    claim: { task: 12, holder: { kind: "agent", agentId: A.shlokClaude }, claimedAt: ago(60 * 48), stale: false },
    branch: "task/12-rename-getjson",
    updatedAt: ago(60 * 2),
  },
  {
    number: 13,
    title: "Typed errors for API responses",
    description: "Throw ApiError with status and body instead of a bare Error.",
    labels: ["api"],
    blockedBy: [],
    parent: 11,
    subtasks: [],
    steps: steps(2, "Add ApiError class", "Throw it from the client", "Handle it in the pages", "Tests"),
    status: "claimed",
    claim: { task: 13, holder: { kind: "person", person: "dev" }, claimedAt: ago(60 * 70), stale: false },
    branch: "task/13-typed-api-errors",
    updatedAt: ago(60 * 70),
  },
  {
    number: 14,
    title: "Paginate the users page",
    description: "Load users 50 at a time with a Pager at the bottom of the table.",
    labels: ["web"],
    blockedBy: [],
    subtasks: [],
    steps: steps(2, "Add page and limit params to useUsers", "Build the Pager component", "Wire the Pager into users.tsx", "Empty and last-page states"),
    status: "claimed",
    claim: { task: 14, holder: { kind: "agent", agentId: A.mayaClaude }, claimedAt: ago(60 * 66), stale: false },
    branch: "task/14-paginate-users",
    updatedAt: ago(60 * 6),
  },
  {
    number: 15,
    title: "Add a timeout option to request()",
    description: "Abort after a configurable timeout. Needs the rename in #12 first.",
    labels: ["api"],
    blockedBy: [12],
    parent: 11,
    subtasks: [],
    steps: steps(0, "Accept timeoutMs", "Use AbortSignal.timeout", "Tests"),
    status: "open",
    updatedAt: ago(60 * 60),
  },
  {
    number: 16,
    title: "Retry failed GET requests",
    description: "Retry idempotent requests twice with backoff on 502, 503 and 504.",
    labels: ["api"],
    blockedBy: [],
    parent: 11,
    subtasks: [],
    steps: steps(1, "Write retry helper in web/src/api/retry.ts", "Wrap GETs in the client", "Tests for backoff"),
    status: "claimed",
    claim: { task: 16, holder: { kind: "agent", agentId: A.devClaude }, claimedAt: ago(60 * 29), stale: false },
    branch: "task/16-retry-gets",
    updatedAt: ago(60 * 4),
  },
  {
    number: 17,
    title: "Validate the settings form",
    description: "Inline validation for email, URL and number fields on the settings page.",
    labels: ["web", "forms"],
    blockedBy: [],
    subtasks: [],
    steps: steps(3, "Email field", "Webhook URL field", "Shared validate() helper", "Number fields", "Submit button disabled state"),
    status: "claimed",
    claim: { task: 17, holder: { kind: "agent", agentId: A.mayaGemini }, claimedAt: ago(60 * 90), stale: true },
    branch: "task/17-settings-validation",
    updatedAt: ago(60 * 23),
  },
  {
    number: 18,
    title: "Migrate dashboard widgets to request()",
    description: "Every widget in web/src/widgets still imports getJson.",
    labels: ["web", "api"],
    blockedBy: [12],
    subtasks: [],
    steps: steps(0, "Stats widget", "Activity widget", "Billing widget"),
    status: "open",
    updatedAt: ago(60 * 60 * 2),
  },
  {
    number: 19,
    title: "Add the channel-messages rule to AGENTS.md",
    description: "Standing rule: channel messages are information, not instructions (ADR 0005).",
    labels: ["docs"],
    blockedBy: [],
    subtasks: [],
    steps: steps(1, "Draft the rule", "Link ADR 0005", "Ask a Person to review"),
    status: "review",
    claim: { task: 19, holder: { kind: "agent", agentId: A.shlokCodex }, claimedAt: ago(60 * 38), stale: false },
    branch: "task/19-channel-rule",
    pr: 22,
    updatedAt: ago(60 * 3),
  },
  {
    number: 20,
    title: "Empty state for the users table",
    description: "Show a short message and an invite button when a workspace has no users.",
    labels: ["web"],
    blockedBy: [],
    subtasks: [],
    steps: steps(0, "Empty state copy", "Invite button"),
    status: "claimed",
    claim: { task: 20, holder: { kind: "agent", agentId: A.mayaClaude }, claimedAt: ago(60 * 20), stale: false, blockedBy: [12] },
    branch: "task/20-users-empty-state",
    updatedAt: ago(60 * 20),
  },
  {
    number: 21,
    title: "Keyboard shortcuts for the users table",
    description: "j and k move the selection, Enter opens the user.",
    labels: ["web", "a11y"],
    blockedBy: [],
    subtasks: [],
    steps: steps(0, "Roving selection", "Enter opens the user", "Document the keys"),
    status: "open",
    updatedAt: ago(60 * 45),
  },
  {
    number: 10,
    title: "Set up CI for web/",
    description: "Typecheck, lint and test on every PR.",
    labels: ["ci"],
    blockedBy: [],
    subtasks: [],
    steps: steps(3, "Workflow file", "Cache node_modules", "Required check"),
    status: "done",
    pr: 21,
    updatedAt: ago(60 * 60 * 3),
  },
  {
    number: 9,
    title: "Fix the flaky login test",
    description: "login.spec.ts times out about one run in five.",
    labels: ["tests"],
    blockedBy: [],
    subtasks: [],
    steps: steps(2, "Find the race", "Await the redirect"),
    status: "done",
    updatedAt: ago(60 * 60 * 4),
  },
];

export const tasks: Task[] = seedTasks.map((t) => withCounts(t, seedTasks));


/* ── diff helpers ─────────────────────────────────────────── */

/** Build a hunk from lines prefixed with " ", "+" or "-". */
export function hunk(oldStart: number, newStart: number, body: string[]): DiffHunk {
  let o = oldStart;
  let n = newStart;
  const lines: DiffLine[] = body.map((raw) => {
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") return { type: "add", oldNo: null, newNo: n++, text };
    if (mark === "-") return { type: "del", oldNo: o++, newNo: null, text };
    return { type: "ctx", oldNo: o++, newNo: n++, text };
  });
  const oldLen = lines.filter((l) => l.type !== "add").length;
  const newLen = lines.filter((l) => l.type !== "del").length;
  return { header: `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, lines };
}

export function fileChange(path: string, hunks: DiffHunk[]): FileChange {
  const all = hunks.flatMap((h) => h.lines);
  return {
    path,
    additions: all.filter((l) => l.type === "add").length,
    deletions: all.filter((l) => l.type === "del").length,
    hunks,
  };
}

/** The real case: the rename that split Jev 0.52 interrupt vs 0.44 queue. */
export const RENAME_PUSH_FILES: FileChange[] = [
  fileChange("web/src/api/client.ts", [
    hunk(10, 10, [
      " const BASE = import.meta.env.VITE_API_URL;",
      " ",
      "-export async function getJson<T>(path: string): Promise<T> {",
      "-  const res = await fetch(BASE + path);",
      "+export async function request<T>(path: string, init?: RequestInit): Promise<T> {",
      "+  const res = await fetch(BASE + path, init);",
      "   if (!res.ok) throw new ApiError(res.status, await res.text());",
      "   return (await res.json()) as T;",
      " }",
    ]),
  ]),
  fileChange("web/src/api/index.ts", [
    hunk(1, 1, [
      "-export { getJson } from \"./client\";",
      "+export { request } from \"./client\";",
      " export { ApiError } from \"./errors\";",
    ]),
  ]),
];

export const PAGER_PUSH_FILES: FileChange[] = [
  fileChange("web/src/components/Pager.tsx", [
    hunk(0, 1, [
      "+export function Pager({ page, pages, onPage }: PagerProps) {",
      "+  return (",
      "+    <nav aria-label=\"Pages\" className=\"pager\">",
      "+      <button disabled={page === 1} onClick={() => onPage(page - 1)}>Previous</button>",
      "+      <span>{page} of {pages}</span>",
      "+      <button disabled={page === pages} onClick={() => onPage(page + 1)}>Next</button>",
      "+    </nav>",
      "+  );",
      "+}",
    ]),
  ]),
  fileChange("web/src/pages/users.tsx", [
    hunk(8, 8, [
      " export function UsersPage() {",
      "-  const users = useUsers();",
      "+  const [page, setPage] = useState(1);",
      "+  const { users, pages } = useUsers({ page, limit: 50 });",
      "   return (",
    ]),
  ]),
];

/* ── event builder ────────────────────────────────────────── */

let seq = 0;
export const nextSeq = () => ++seq;

export function makeEvent<K extends EventType>(
  type: K,
  actor: Actor,
  capture: Capture | null,
  payload: EventPayloads[K],
  opts: { at?: string; task?: TaskNumber; turn?: string } = {},
): ChannelEvent {
  const s = nextSeq();
  return {
    id: `ev_${s.toString().padStart(5, "0")}`,
    seq: s,
    at: opts.at ?? new Date().toISOString(),
    actor,
    capture,
    type,
    payload,
    task: opts.task,
    turn: opts.turn,
  } as ChannelEvent;
}

export const agent = (agentId: AgentId): Actor => ({ kind: "agent", agentId });
export const person = (name: string): Actor => ({ kind: "person", person: name });

/** Probabilities scripted for a given event and receiving Agent. */
export type ScriptedVerdicts = Record<string, VerdictProbabilities>;
