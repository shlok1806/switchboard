// Identity and GitHub (#1, #2, ADR 0007), driven through the Worker the way the
// Dashboard, the CLI and GitHub reach it: sign-in with GitHub (web and device flows,
// with a fake GitHub), membership of the repo and its re-check, what an Agent
// token may and may not do, its revocation, one Channel per repo, the status
// comment, and a deployment without the GitHub App.

import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentId,
  AgentResponse,
  AuthConfigResponse,
  DeviceCodeResponse,
  DeviceTokenResponse,
  DevSessionResponse,
  ErrorResponse,
  HistoryResponse,
  JoinResponse,
  PostUpdateResponse,
} from "../../shared/src/index";
import { agentPath, claimPath, releasePath, takeoverPath } from "../../shared/src/index";
import type { DevicePoll, GitHubSignIn } from "../src/github/index";
import { installGitHub, installGitHubSignIn, sign } from "../src/github/index";
import { STATUS_MARKER } from "../src/status-comment";
import {
  bearer,
  channelStub,
  forgetTokens,
  OTHER_REPO,
  PROD_BASE,
  REPO,
  remember,
  streamQuery,
  tokenOf,
  url,
} from "./client";
import { FakeGitHub } from "./fake-github";

/** GitHub's side of sign-in: a code or a device code stands for a login. */
class FakeSignIn implements GitHubSignIn {
  /** Web-flow codes, and the login each signs in. */
  readonly codes = new Map<string, string>();
  /** Device codes: the login once the Person approved, null while pending. */
  readonly devices = new Map<string, string | null>();

  authorizeUrl(state: string, redirectUri: string): string {
    return `https://github.test/login/oauth/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const login = this.codes.get(code);
    if (login === undefined) throw new Error("bad_verification_code");
    return `user-token-${login}`;
  }

  async startDevice(): Promise<DeviceCodeResponse> {
    const deviceCode = `device-${this.devices.size + 1}`;
    this.devices.set(deviceCode, null);
    return {
      deviceCode,
      userCode: "ABCD-1234",
      verificationUri: "https://github.test/login/device",
      interval: 5,
      expiresIn: 900,
    };
  }

  async pollDevice(deviceCode: string): Promise<DevicePoll> {
    const login = this.devices.get(deviceCode);
    if (login === undefined) return { ok: false, pending: false, error: "expired", reason: "The code expired." };
    if (login === null) return { ok: false, pending: true, slowDown: false };
    return { ok: true, userToken: `user-token-${login}` };
  }

  async userLogin(userToken: string): Promise<string> {
    return userToken.slice("user-token-".length);
  }
}

let github: FakeGitHub;
let signIn: FakeSignIn;

function fetchWorker(target: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(target, { redirect: "manual", ...init }));
}

/** The `name=value` part of a Set-Cookie header for cookie `name`, or null. */
function setCookie(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header;
  }
  return null;
}

function cookieValue(header: string | null): string {
  return header?.split(";")[0]?.split("=").slice(1).join("=") ?? "";
}

/** Signs `login` in through GitHub's web flow on a deployed Worker, as a browser does. Returns the final redirect. */
async function webSignIn(login: string, repo = REPO): Promise<Response> {
  const start = await fetchWorker(`${PROD_BASE}/auth/github/start?repo=${repo}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const nonce = cookieValue(setCookie(start, "sb_oauth"));
  const code = `code-${login}`;
  signIn.codes.set(code, login);
  return fetchWorker(`${PROD_BASE}/auth/github/callback?${new URLSearchParams({ code, state })}`, {
    headers: { Cookie: `sb_oauth=${nonce}` },
  });
}

/** A Channel API call on a deployed Worker carrying the Dashboard's session cookie. */
function withCookie(path: string, session: string, init: RequestInit = {}, repo = REPO): Promise<Response> {
  return fetchWorker(url(path, repo, PROD_BASE), {
    ...init,
    headers: { Cookie: `sb_session=${session}`, "Content-Type": "application/json", ...init.headers },
  });
}

async function call(
  path: string,
  as: string | { person: string; agent: AgentId },
  init: RequestInit = {},
  repo = REPO,
) {
  return fetchWorker(url(path, repo), {
    ...init,
    headers: { Authorization: await bearer(as), "Content-Type": "application/json", ...init.headers },
  });
}

let sessions = 0;
async function register(person: string): Promise<AgentId> {
  sessions += 1;
  const sessionId = `${sessions.toString(16).padStart(4, "0")}eeee-0000-4000-8000-000000000000`;
  const response = await call("/api/agents", person, {
    method: "POST",
    body: JSON.stringify({ cli: "claude-code", sessionId, cwd: "/repo" }),
  });
  expect(response.status).toBe(200);
  const answer = remember(await response.json<AgentResponse>());
  expect(answer.token).toMatch(/^sba_/);
  return answer.agent.id;
}

beforeEach(() => {
  github = new FakeGitHub();
  signIn = new FakeSignIn();
  installGitHub(github);
  installGitHubSignIn(signIn);
});

afterEach(async () => {
  vi.useRealTimers();
  installGitHub(null);
  installGitHubSignIn(null);
  forgetTokens();
  await reset();
});

describe("signing in to the Dashboard with GitHub", () => {
  it("goes to GitHub and comes back with an HttpOnly session cookie, whose Person is the GitHub login", async () => {
    const start = await fetchWorker(`${PROD_BASE}/auth/github/start?repo=Shlok1806/Switchboard`);
    const location = new URL(start.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.test/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(`${PROD_BASE}/auth/github/callback`);
    expect(setCookie(start, "sb_oauth")).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const back = await webSignIn("Shlok1806");
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe(`/${REPO}`);
    const cookie = setCookie(back, "sb_session");
    expect(cookie).toMatch(/; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);

    const joined = await withCookie("/api/join", cookieValue(cookie), { method: "POST", body: "{}" });
    expect(joined.status).toBe(200);
    expect((await joined.json<JoinResponse>()).person.name).toBe("shlok1806");
  });

  it("refuses a callback whose state was not issued to this browser", async () => {
    const start = await fetchWorker(`${PROD_BASE}/auth/github/start?repo=${REPO}`);
    const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    signIn.codes.set("c", "shlok1806");
    const stolen = await fetchWorker(`${PROD_BASE}/auth/github/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(stolen.headers.get("Location")).toBe(`/${REPO}?signin=failed`);
    expect(setCookie(stolen, "sb_session")).toBeNull();
    const forged = await fetchWorker(`${PROD_BASE}/auth/github/callback?code=c&state=v1.e30.AAAA`);
    expect(forged.headers.get("Location")).toBe("/?signin=failed");
  });

  it("refuses a Person without write access to the repo", async () => {
    github.permissions.set("reader", "read");
    const back = await webSignIn("reader");
    expect(back.headers.get("Location")).toBe(`/${REPO}?signin=not-a-member`);
    expect(setCookie(back, "sb_session")).toBeNull();
  });

  it("offers no sign-in for a repo that may not have a Channel here", async () => {
    const start = await fetchWorker(`${PROD_BASE}/auth/github/start?repo=someone/else`);
    expect(start.headers.get("Location")).toBe("/?signin=not-allowed");
  });

  it("refuses a cookie-carried change from another site", async () => {
    const session = cookieValue(setCookie(await webSignIn("shlok1806"), "sb_session"));
    const posted = await withCookie("/api/updates", session, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
      headers: { Origin: "https://evil.test" },
    });
    expect(posted.status).toBe(403);
    const same = await withCookie("/api/updates", session, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
      headers: { Origin: PROD_BASE },
    });
    expect(same.status).toBe(201);
  });

  it("signs out by clearing the cookie", async () => {
    const out = await fetchWorker(`${PROD_BASE}/auth/signout`, { method: "POST" });
    expect(out.status).toBe(204);
    expect(setCookie(out, "sb_session")).toMatch(/^sb_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
  });
});

describe("signing in from the CLI with GitHub's device flow", () => {
  it("waits for the Person to enter the code, then hands out a session", async () => {
    const started = await fetchWorker(`${PROD_BASE}/auth/device/code`, { method: "POST" });
    expect(started.status).toBe(200);
    const { deviceCode, userCode } = await started.json<DeviceCodeResponse>();
    expect(userCode).toBe("ABCD-1234");

    const poll = () =>
      fetchWorker(`${PROD_BASE}/auth/device/token`, {
        method: "POST",
        body: JSON.stringify({ deviceCode, repo: REPO }),
      });
    expect(await (await poll()).json<DeviceTokenResponse>()).toEqual({ ok: false, pending: true, slowDown: false });

    signIn.devices.set(deviceCode, "Sam-Dev");
    const done = await (await poll()).json<DeviceTokenResponse>();
    if (!done.ok) throw new Error("expected a session");
    expect(done).toMatchObject({ person: "sam-dev", repo: REPO });

    const joined = await fetchWorker(url("/api/join", REPO, PROD_BASE), {
      method: "POST",
      headers: { Authorization: `Bearer ${done.session}` },
      body: "{}",
    });
    expect((await joined.json<JoinResponse>()).person.name).toBe("sam-dev");
  });

  it("refuses a Person without write access, and an unknown repo", async () => {
    github.permissions.set("outsider", "none");
    const { deviceCode } = await (
      await fetchWorker(`${PROD_BASE}/auth/device/code`, { method: "POST" })
    ).json<DeviceCodeResponse>();
    signIn.devices.set(deviceCode, "outsider");
    const refused = await fetchWorker(`${PROD_BASE}/auth/device/token`, {
      method: "POST",
      body: JSON.stringify({ deviceCode, repo: REPO }),
    });
    expect(refused.status).toBe(403);
    expect((await refused.json<ErrorResponse>()).reason).toContain("does not have write access");
    const unknown = await fetchWorker(`${PROD_BASE}/auth/device/token`, {
      method: "POST",
      body: JSON.stringify({ deviceCode, repo: "someone/else" }),
    });
    expect(unknown.status).toBe(404);
  });
});

describe("membership", () => {
  it("re-checks write access at most every 5 minutes, and refuses someone who lost it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const session = cookieValue(setCookie(await webSignIn("sam"), "sb_session"));
    const events = () => withCookie("/api/events", session);
    expect((await events()).status).toBe(200);
    const checks = github.permissionChecks;

    // Removed from the repo: the cached answer stands for a few minutes, without asking GitHub.
    github.permissions.set("sam", "read");
    expect((await events()).status).toBe(200);
    expect(github.permissionChecks).toBe(checks);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    const refused = await events();
    expect(refused.status).toBe(403);
    expect((await refused.json<ErrorResponse>()).reason).toBe(
      `sam does not have write access to ${REPO}, so cannot join its Channel.`,
    );
    expect(github.permissionChecks).toBe(checks + 1);

    // Given access back, they are in again at the next check.
    github.permissions.set("sam", "maintain");
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    expect((await events()).status).toBe(200);
  });

  it("keeps a recent member in while GitHub cannot be reached, and nobody else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await call("/api/join", "sam", { method: "POST", body: "{}" });
    github.permissionsDown = true;
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await call("/api/events", "sam")).status).toBe(200);
    const stranger = await call("/api/events", "newcomer");
    expect(stranger.status).toBe(503);
  });

  it("closes the stream of someone who lost access, at the next re-check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const response = await fetchWorker(url(`/api/stream?${await streamQuery("sam")}`), {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error("No WebSocket");
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    socket.accept();

    github.permissions.set("sam", "none");
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    await runDurableObjectAlarm(channelStub());
    expect(await closed).toBe(4003);
  });
});

describe("Agent tokens", () => {
  it("are issued when the Person's session registers an Agent, and act as that Agent", async () => {
    const number = github.open({ title: "Claims" }).number;
    const id = await register("shlok");
    const agent = { person: "shlok", agent: id };
    const posted = await call("/api/updates", agent, { method: "POST", body: JSON.stringify({ text: "on it" }) });
    expect(posted.status).toBe(201);
    expect((await posted.json<PostUpdateResponse>()).event).toMatchObject({
      actor: { kind: "agent", agentId: id },
      capture: "tool",
    });
    expect((await call("/api/events", agent)).status).toBe(200);
    expect((await call("/api/tasks", agent)).status).toBe(200);
    expect((await call("/api/agents", agent)).status).toBe(200);
    expect(
      (await call(`${agentPath(id)}/heartbeat`, agent, { method: "POST", body: '{"presence":"idle"}' })).status,
    ).toBe(200);
    expect((await call(claimPath(number), agent, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await call(releasePath(number), agent, { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("cannot send Directives, act as the Person, or touch other Agents", async () => {
    const mine = await register("shlok");
    const sibling = await register("shlok");
    const theirs = await register("sam");
    const agent = { person: "shlok", agent: mine };
    const post = (path: string, body: unknown = {}) =>
      call(path, agent, { method: "POST", body: JSON.stringify(body) });

    const refusals: [string, Response][] = [
      ["a Directive", await post("/api/directives", { to: theirs, text: "stop" })],
      ["a Directive to a sibling", await post("/api/directives", { to: sibling, text: "stop" })],
      ["a new Task", await post("/api/tasks", { title: "x" })],
      ["registering an Agent", await post("/api/agents", { cli: "claude-code", sessionId: "ffff0000-1", cwd: "/" })],
      ["another Agent's heartbeat", await post(`${agentPath(sibling)}/heartbeat`, { presence: "live" })],
      ["ending another Agent", await post(`${agentPath(theirs)}/end`)],
      ["another Agent's Proxy mode", await post(`${agentPath(sibling)}/proxy-mode`, { mode: "raw" })],
      ["its own Proxy mode", await post(`${agentPath(mine)}/proxy-mode`, { mode: "raw" })],
      ["a Takeover", await post(takeoverPath(1), { to: { kind: "person", person: "shlok" } })],
      ["a Claim for another Agent", await post(claimPath(1), { for: sibling })],
      ["joining as the Person", await post("/api/join")],
    ];
    for (const [what, response] of refusals) expect(response.status, what).toBe(403);
    expect((await call("/api/events", "shlok")).status).toBe(200);
    const directives = (await (await call("/api/events", "shlok")).json<HistoryResponse>()).events.filter(
      (e) => e.type === "directive",
    );
    expect(directives).toEqual([]);
  });

  it("stop working when the Agent goes Gone, and resuming issues a new one", async () => {
    const id = await register("shlok");
    const first = tokenOf(id);
    const agent = { person: "shlok", agent: id };
    const stream = await fetchWorker(url(`/api/stream?${await streamQuery(agent)}`), {
      headers: { Upgrade: "websocket" },
    });
    const socket = stream.webSocket;
    if (!socket) throw new Error("No WebSocket");
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    socket.accept();

    expect((await call(`${agentPath(id)}/end`, agent, { method: "POST", body: "{}" })).status).toBe(200);
    expect(await closed).toBe(4001);
    const revoked = await call("/api/events", agent);
    expect(revoked.status).toBe(401);
    expect((await revoked.json<ErrorResponse>()).reason).toContain("revoked");

    const again = await call("/api/agents", "shlok", {
      method: "POST",
      body: JSON.stringify({
        cli: "claude-code",
        sessionId: `${sessions.toString(16).padStart(4, "0")}eeee-0000-4000-8000-000000000000`,
        cwd: "/repo",
        resumed: true,
      }),
    });
    const second = remember(await again.json<AgentResponse>()).token;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await call("/api/events", agent)).status).toBe(200);
  });

  it("refuse a token nobody issued", async () => {
    const response = await fetchWorker(url("/api/events"), { headers: { Authorization: "Bearer sba_made_up" } });
    expect(response.status).toBe(401);
  });
});

describe("one Channel per repo", () => {
  it("keeps each repo's Events apart, and has no Channel for a repo that is not allowed", async () => {
    installGitHub(null);
    await call("/api/updates", "shlok", { method: "POST", body: JSON.stringify({ text: "in switchboard" }) });
    await call("/api/updates", "shlok", { method: "POST", body: JSON.stringify({ text: "in other" }) }, OTHER_REPO);
    const texts = async (repo: string) =>
      (await (await call("/api/events", "shlok", {}, repo)).json<HistoryResponse>()).events.flatMap((e) =>
        e.type === "update" ? [e.payload.text] : [],
      );
    expect(await texts(REPO)).toEqual(["in switchboard"]);
    expect(await texts(OTHER_REPO)).toEqual(["in other"]);
    // Case does not make a second Channel.
    expect(await texts("Shlok1806/Switchboard")).toEqual(["in switchboard"]);

    const elsewhere = await call("/api/events", "shlok", {}, "someone/else");
    expect(elsewhere.status).toBe(404);
    expect((await fetchWorker(`${PROD_BASE}/api/events`)).status).toBe(404);
  });

  it("routes each webhook delivery by its repository, and acknowledges App-only events", async () => {
    const signed = async (event: string, payload: unknown) => {
      const body = JSON.stringify(payload);
      return fetchWorker(url("/api/github/webhook"), {
        method: "POST",
        body,
        headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": await sign("test-webhook-secret", body) },
      });
    };
    const opened = github.open({ title: "Routed" });
    expect((await signed(opened.event, opened.payload)).status).toBe(204);
    const tasks = await (await call("/api/tasks", "shlok")).json<{ tasks: { title: string }[] }>();
    expect(tasks.tasks.map((t) => t.title)).toEqual(["Routed"]);

    const stranger = { ...opened.payload, repository: { full_name: "someone/else" } };
    expect((await signed("issues", stranger)).status).toBe(204);
    for (const event of ["installation", "installation_repositories", "issue_comment", "ping"]) {
      expect((await signed(event, { action: "created", repository: { full_name: REPO } })).status, event).toBe(204);
    }
  });
});

describe("the status comment", () => {
  it("is one comment per Issue, edited in place, re-posted when deleted, and shows the last Update", async () => {
    const number = github.open({ title: "Claims", body: "- [ ] one\n- [ ] two" }).number;
    const id = await register("shlok");
    const agent = { person: "shlok", agent: id };
    const post = (path: string, body: unknown = {}) =>
      call(path, agent, { method: "POST", body: JSON.stringify(body) });

    await post(claimPath(number));
    const [first] = github.commentIds(number);
    expect(github.issue(number).comments).toEqual([expect.stringContaining(STATUS_MARKER)]);

    await post(`/api/tasks/${number}/steps/0/complete`);
    await post("/api/updates", { text: "Schema done, starting on two", task: number });
    await vi.waitFor(() => expect(github.issue(number).comments[0]).toContain("> Schema done, starting on two"));
    expect(github.commentIds(number)).toEqual([first]);
    const body = github.issue(number).comments[0] ?? "";
    expect(body).toContain(`Held by Agent \`${id}\` of \`shlok\``);
    expect(body).toContain("Steps done: 1 of 2.");
    expect(body).toContain(`Last Update, from Agent \`${id}\``);

    // Someone deletes it on GitHub: the next change posts a new one.
    github.deleteComment(first ?? 0);
    await post(releasePath(number));
    const after = github.commentIds(number);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first);
    expect(github.issue(number).comments[0]).toContain("Not claimed.");
    expect(github.calls.filter(([method]) => method === "createComment")).toHaveLength(2);
  });
});

describe("a deployment without the GitHub App", () => {
  beforeEach(() => {
    installGitHub(null);
    installGitHubSignIn(null);
  });

  it("says sign-in is not configured, everywhere, without failing", async () => {
    const config = await (await fetchWorker(`${PROD_BASE}/auth/config`)).json<AuthConfigResponse>();
    expect(config).toMatchObject({ configured: false, repos: [REPO, OTHER_REPO], devSignIn: false });
    expect(config.reason).toContain("GitHub App not configured");
    expect(config.reason).toContain("GITHUB_APP_ID");

    const start = await fetchWorker(`${PROD_BASE}/auth/github/start?repo=${REPO}`);
    expect(start.headers.get("Location")).toBe(`/${REPO}?signin=not-configured`);
    const device = await fetchWorker(`${PROD_BASE}/auth/device/code`, { method: "POST" });
    expect(device.status).toBe(503);
    expect((await device.json<ErrorResponse>()).reason).toContain("GitHub App not configured");

    // A session alone gets nowhere either: membership needs the App.
    const session = await bearer("shlok");
    const events = await fetchWorker(url("/api/events", REPO, PROD_BASE), { headers: { Authorization: session } });
    expect(events.status).toBe(503);
    expect((await events.json<ErrorResponse>()).reason).toContain("GitHub App not configured");
  });

  it("keeps the dev-only fake sign-in off unless the request is local", async () => {
    const remote = await fetchWorker(`${PROD_BASE}/auth/dev/session`, {
      method: "POST",
      body: JSON.stringify({ login: "shlok", repo: REPO }),
    });
    expect(remote.status).toBe(404);

    const local = await fetchWorker(url("/auth/dev/session"), {
      method: "POST",
      body: JSON.stringify({ login: "Shlok", repo: REPO }),
    });
    expect(local.status).toBe(200);
    const { session, person } = await local.json<DevSessionResponse>();
    expect(person).toBe("shlok");
    const joined = await fetchWorker(url("/api/join"), {
      method: "POST",
      headers: { Authorization: `Bearer ${session}` },
      body: "{}",
    });
    expect(joined.status).toBe(200);
    expect((await (await fetchWorker(url("/auth/config"))).json<AuthConfigResponse>()).devSignIn).toBe(true);
  });
});
