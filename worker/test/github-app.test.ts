// The GitHub App client (ADR 0007, issue #2) against a stand-in for GitHub's API:
// the App's JWT, installation tokens minted once and cached until shortly before
// they expire, a refused token replaced, the membership permission read, and the
// status comment's create and edit calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApp, readPrivateKey } from "../src/github/index";

const API = "https://api.github.test";

async function keyPair(): Promise<{ pkcs8Pem: string; pkcs1Pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  // PKCS#8 wraps the PKCS#1 key in its last element, an OCTET STRING: unwrap it, as GitHub's download is.
  const pkcs1 = pkcs8.slice(pkcs8.length - octetLength(pkcs8));
  return { pkcs8Pem: pem("PRIVATE KEY", pkcs8), pkcs1Pem: pem("RSA PRIVATE KEY", pkcs1), publicKey: pair.publicKey };
}

/** The length of the content of the OCTET STRING that ends a PKCS#8 PrivateKeyInfo. */
function octetLength(der: Uint8Array): number {
  // SEQUENCE { INTEGER 0, AlgorithmIdentifier (15 bytes), OCTET STRING }
  let i = der[1] === 0x82 ? 4 : der[1] === 0x81 ? 3 : 2;
  i += 3 + 15;
  if (der[i] !== 0x04) throw new Error("Not a PKCS#8 RSA key");
  const first = der[i + 1] ?? 0;
  if (first < 0x80) return first;
  let length = 0;
  for (let n = 0; n < (first & 0x7f); n++) length = (length << 8) | (der[i + 2 + n] ?? 0);
  return length;
}

function pem(label: string, der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** GitHub's API, as far as the App client uses it. Records every call. */
function stubGitHub(tokenLifeMs = 60 * 60_000) {
  const calls: { method: string; path: string; auth: string }[] = [];
  let minted = 0;
  const refused = new Set<string>();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const auth = request.headers.get("Authorization") ?? "";
    calls.push({ method: request.method, path, auth });
    if (refused.has(auth)) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (path === "/repos/o/r/installation") return Response.json({ id: 42 });
    if (path === "/app/installations/42/access_tokens") {
      minted += 1;
      return Response.json(
        { token: `ghs_${minted}`, expires_at: new Date(Date.now() + tokenLifeMs).toISOString() },
        { status: 201 },
      );
    }
    if (path === "/repos/o/r/collaborators/sam/permission")
      return Response.json({ permission: "write", role_name: "maintain" });
    if (path === "/repos/o/r/collaborators/eve/permission")
      return Response.json({ permission: "read", role_name: "read" });
    if (path === "/repos/o/r/issues/3/comments") return Response.json({ id: 99 }, { status: 201 });
    if (path === "/repos/o/r/issues/comments/99") return Response.json({ id: 99 });
    if (path === "/repos/o/r/issues/comments/100") return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  return { calls, spy, refuse: (token: string) => refused.add(`Bearer ${token}`) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the GitHub App client", () => {
  it("signs its JWT with the App's key, read from PKCS#8 or GitHub's PKCS#1 file", async () => {
    const { pkcs8Pem, pkcs1Pem, publicKey } = await keyPair();
    expect(readPrivateKey(pkcs1Pem)).toEqual(readPrivateKey(pkcs8Pem));
    // A one-line secret with escaped newlines reads the same.
    expect(readPrivateKey(pkcs8Pem.replace(/\n/g, "\\n"))).toEqual(readPrivateKey(pkcs8Pem));

    for (const privateKey of [pkcs8Pem, pkcs1Pem]) {
      const app = new GitHubApp({ appId: "5138187", privateKey, clientId: "Iv1", clientSecret: "s", api: API });
      const jwt = await app.appJwt();
      const [header, claims, signature] = jwt.split(".");
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        fromBase64url(signature ?? ""),
        new TextEncoder().encode(`${header}.${claims}`),
      );
      expect(valid).toBe(true);
      const payload = JSON.parse(new TextDecoder().decode(fromBase64url(claims ?? "")));
      expect(payload.iss).toBe("5138187");
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    }
    expect(() => readPrivateKey("not a key")).toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });

  it("mints an installation token once, reuses it, and mints again shortly before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { pkcs8Pem } = await keyPair();
    const stub = stubGitHub();
    const app = new GitHubApp({ appId: "1", privateKey: pkcs8Pem, clientId: "c", clientSecret: "s", api: API });
    const repo = app.repo("o/r");

    expect(await repo.permission("sam")).toBe("maintain");
    expect(await repo.permission("eve")).toBe("read");
    expect(await repo.permission("nobody")).toBe("none");
    const mints = () => stub.calls.filter((c) => c.path.endsWith("/access_tokens")).length;
    expect(mints()).toBe(1);
    const reads = stub.calls.filter((c) => c.path.includes("/collaborators/"));
    expect(reads.every((c) => c.auth === "Bearer ghs_1")).toBe(true);

    vi.setSystemTime(Date.now() + 56 * 60_000);
    await repo.permission("sam");
    expect(mints()).toBe(2);
    expect(stub.calls.at(-1)?.auth).toBe("Bearer ghs_2");
  });

  it("replaces a token GitHub refuses, once", async () => {
    const { pkcs8Pem } = await keyPair();
    const stub = stubGitHub();
    const app = new GitHubApp({ appId: "2", privateKey: pkcs8Pem, clientId: "c", clientSecret: "s", api: API });
    const repo = app.repo("o/r");
    await repo.permission("sam");
    stub.refuse("ghs_1");
    expect(await repo.permission("sam")).toBe("maintain");
    expect(stub.calls.at(-1)?.auth).toBe("Bearer ghs_2");
  });

  it("creates a comment and returns its ID, and edits one, saying when it was deleted", async () => {
    const { pkcs8Pem } = await keyPair();
    stubGitHub();
    const repo = new GitHubApp({ appId: "3", privateKey: pkcs8Pem, clientId: "c", clientSecret: "s", api: API }).repo(
      "o/r",
    );
    expect(await repo.createComment(3, "status")).toBe(99);
    expect(await repo.updateComment(99, "status, edited")).toBe(true);
    expect(await repo.updateComment(100, "gone")).toBe(false);
  });
});
