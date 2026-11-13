import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { PersonActor } from "../../shared/src/m1";
import type { GitHubSignIn } from "../src/github/app";
import { signNativeSession } from "../src/session";

export const M1_ORIGIN = "https://switchboard.test";
export const M1_SECRET = "test-session-secret-at-least-32-characters-long";
export const nativeDirectory = () => env.IDENTITY_DIRECTORY.getByName("directory-v1");
export async function nativeIdentity(githubId = "900", login = "native-human") {
  const actor = (await nativeDirectory().resolve(githubId, login)) as PersonActor;
  const token = await signNativeSession(M1_SECRET, M1_ORIGIN, actor, login);
  return { actor, token };
}
export function nativeFetch(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return exports.default.fetch(new Request(`${M1_ORIGIN}${path}`, { ...init, headers, redirect: "manual" }));
}
/** Independent native fixture: no edits to the legacy FakeSignIn. */
export class NativeSignIn implements GitHubSignIn {
  githubId = "900";
  login = "native-human";
  authorizeUrl(state: string) {
    return `https://github.test/authorize?state=${state}`;
  }
  async exchangeCode() {
    return "fixture-user-token";
  }
  async userLogin() {
    return this.login;
  }
  async userIdentity() {
    return { githubId: this.githubId, login: this.login };
  }
  async startDevice() {
    return {
      deviceCode: "fixture-device",
      userCode: "CODE",
      verificationUri: "https://github.test/device",
      interval: 5,
      expiresIn: 600,
    };
  }
  async pollDevice() {
    return { ok: true, userToken: "fixture-user-token" } as const;
  }
}
