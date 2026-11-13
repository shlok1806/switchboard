import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personFromLogin } from "../../shared/src/index";
import { installGitHubSignIn } from "../src/github/index";
import { signNativeSession, signPayload, signSession, verifyNativeSession } from "../src/session";
import { M1_ORIGIN, M1_SECRET, NativeSignIn, nativeDirectory, nativeFetch, nativeIdentity } from "./m1-helpers";

let fixture: NativeSignIn;
beforeEach(async () => {
  await reset();
  fixture = new NativeSignIn();
  installGitHubSignIn(fixture);
});
afterEach(() => installGitHubSignIn(null));
async function web(native = true) {
  const start = await nativeFetch(`/auth/github/start?${native ? "destination=native" : "repo=shlok1806/switchboard"}`);
  const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => c.startsWith("sb_oauth="))
      ?.split(";")[0] ?? "";
  return nativeFetch(`/auth/github/callback?${new URLSearchParams({ state, code: "fixture-code" })}`, undefined, {
    headers: { Cookie: cookie },
  });
}
describe("native identity boundary", () => {
  it("supports native browser and device sign-in without repo permission", async () => {
    const response = await web();
    expect(response.headers.get("Location")).toBe("/");
    const cookie =
      response.headers
        .getSetCookie()
        .find((c) => c.startsWith("sb_session="))
        ?.split(";")[0] ?? "";
    expect((await nativeFetch("/api/m1/organizations", undefined, { headers: { Cookie: cookie } })).status).toBe(200);
    const code = (await (
      await nativeFetch("/auth/device/code?destination=native", undefined, { method: "POST" })
    ).json()) as { deviceCode: string };
    const poll = await nativeFetch("/auth/device/token", undefined, {
      method: "POST",
      body: JSON.stringify({ deviceCode: code.deviceCode, destination: "native" }),
    });
    const body = (await poll.json()) as { session: string };
    expect((await nativeFetch("/api/m1/organizations", body.session)).status).toBe(200);
  });
  it("preserves legacy browser and device membership prerequisites", async () => {
    expect((await web(false)).headers.get("Location")).not.toBe("/shlok1806/switchboard");
    const response = await nativeFetch("/auth/device/token", undefined, {
      method: "POST",
      body: JSON.stringify({ repo: "shlok1806/switchboard", deviceCode: "fixture-device" }),
    });
    expect(response.status).not.toBe(200);
  });
  it("preserves Person UUID across login changes", async () => {
    const first = await nativeDirectory().resolve("900", "old-login");
    expect(await nativeDirectory().resolve("900", "new-login")).toEqual(first);
  });
  it("rejects recycled-login legacy sessions for native access", async () => {
    await nativeDirectory().resolve("901", "native-human");
    const login = personFromLogin("native-human");
    if (!login) throw new Error("Invalid fixture login");
    const token = await signSession(M1_SECRET, login);
    expect((await nativeFetch("/api/m1/organizations", token)).status).toBe(401);
  });
  it("denies agent legacy connector and Host tokens on api m1", async () => {
    for (const token of [
      "sba_fixture",
      "host_fixture",
      "connector_fixture",
      await signPayload(M1_SECRET, { kind: "connector", sub: "native-human" }),
    ]) {
      expect((await nativeFetch("/api/m1/organizations", token)).status).toBe(401);
    }
  });
  it("rejects forged expired or mismatched native identity", async () => {
    const { actor, token } = await nativeIdentity();
    const invalid = [
      token.slice(0, -8),
      await signNativeSession(M1_SECRET, M1_ORIGIN, actor, "native-human", 0),
      await signNativeSession(M1_SECRET, "https://foreign.test", actor, "native-human"),
      await signNativeSession(M1_SECRET, M1_ORIGIN, { ...actor, githubId: "999" }, "native-human"),
    ];
    for (const candidate of invalid) expect((await nativeFetch("/api/m1/organizations", candidate)).status).toBe(401);
    expect(await verifyNativeSession(M1_SECRET, M1_ORIGIN, token)).toEqual(actor);
  });
  it("rejects native cookie writes with missing or foreign Origin", async () => {
    const { token } = await nativeIdentity();
    for (const origin of [undefined, "https://foreign.test"]) {
      expect(
        (
          await nativeFetch("/api/m1/organizations", undefined, {
            method: "POST",
            headers: {
              Cookie: `sb_session=${token}`,
              "Idempotency-Key": "cookie",
              ...(origin ? { Origin: origin } : {}),
            },
            body: JSON.stringify({ name: "Org" }),
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await nativeFetch("/api/m1/organizations", undefined, {
          method: "POST",
          headers: { Cookie: `sb_session=${token}`, Origin: M1_ORIGIN, "Idempotency-Key": "cookie" },
          body: JSON.stringify({ name: "Org" }),
        })
      ).status,
    ).toBe(201);
  });
  it("ignores body-supplied actor identity", async () => {
    const { actor, token } = await nativeIdentity();
    const other = await nativeIdentity("901", "other");
    const response = await nativeFetch("/api/m1/organizations", token, {
      method: "POST",
      headers: { "Idempotency-Key": "create" },
      body: JSON.stringify({ name: "Org", actor: other.actor }),
    });
    const body = (await response.json()) as { value: { id: string } };
    expect(await nativeDirectory().organizations(actor)).toMatchObject({ organizations: [{ id: body.value.id }] });
    expect((await nativeDirectory().organizations(other.actor)).organizations).toEqual([]);
  });
  it("authenticates native destination in device state", async () => {
    const response = await nativeFetch("/auth/device/token", undefined, {
      method: "POST",
      body: JSON.stringify({ deviceCode: "fixture-device", destination: "native" }),
    });
    expect(response.status).toBe(400);
  });
});
