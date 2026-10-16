// `npm run dev` against a running Worker (SWITCHBOARD_WORKER), the way a Person uses it: the
// page's own POSTs and its stream go through the dev server's proxy, and the Worker refuses a
// cookie-carried one whose Origin is not its own (worker/src/auth.ts). A stand-in Worker
// records the Origin each request reaches it with.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { workerProxy } from "../worker-proxy";

let worker: Server;
let workerOrigin = "";
let dev: ViteDevServer;
let devOrigin = "";
let cache = "";
const seen: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "worker-proxy-test-"));
  worker = createHttpServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(204).end();
  });
  worker.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  workerOrigin = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  dev = await createServer({
    configFile: false,
    logLevel: "silent",
    root: import.meta.dirname,
    // Its own cache, so a dev server the Person runs at the same time keeps its optimized deps.
    cacheDir: cache,
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, proxy: workerProxy(workerOrigin) },
  });
  await dev.listen();
  devOrigin = `http://127.0.0.1:${(dev.httpServer?.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await dev?.close();
  worker?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

/** One request through the dev server, with the headers a browser would send; the Origin the Worker got. */
function through(path: string, headers: Record<string, string>, method = "POST"): Promise<string | undefined> {
  const before = seen.length;
  return new Promise((resolve, reject) => {
    const req = request(`${devOrigin}${path}`, { method, headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(seen[before]?.origin));
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(seen[before]?.origin);
    });
    req.on("error", (error) => (seen.length > before ? resolve(seen[before]?.origin) : reject(error)));
    req.end();
  });
}

describe("the dev server's proxy to a Worker", () => {
  it("passes the page's own POSTs on as same-origin, so the Worker takes them", async () => {
    expect(await through("/r/ana/app/api/join", { Origin: devOrigin, Cookie: "sb_session=x" })).toBe(workerOrigin);
    expect(await through("/auth/signout", { Origin: devOrigin })).toBe(workerOrigin);
  });

  it("opens the page's stream as same-origin", async () => {
    const origin = await through(
      "/r/ana/app/api/stream",
      {
        Origin: devOrigin,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
      "GET",
    );
    expect(origin).toBe(workerOrigin);
  });

  it("passes a request from another site on as it came, for the Worker to refuse", async () => {
    expect(await through("/r/ana/app/api/join", { Origin: "https://elsewhere.example" })).toBe("https://elsewhere.example");
  });
});
