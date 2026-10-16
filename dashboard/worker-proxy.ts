// The dev server's proxy to a running Worker (`npm run dev` with SWITCHBOARD_WORKER).
//
// The Worker refuses a cookie-carried call that changes something, or opens the
// stream, when its Origin is not the Worker's own (worker/src/auth.ts). Through this
// proxy the page's origin is the dev server's, so every POST and the stream were
// refused as cross-site. The proxy stands in for the page: a request from the dev
// server's own page goes on with the Worker's origin. Any other Origin is passed on
// as it came, so the Worker still refuses a request from another site.

import type { IncomingMessage } from "node:http";
import type { ProxyOptions } from "vite";

/** The Origin header a request from the dev server's own page carries. */
function fromDevPage(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return origin !== undefined && host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
}

export function workerProxy(target: string): Record<string, ProxyOptions> {
  const workerOrigin = new URL(target).origin;
  const sameOrigin: ProxyOptions["configure"] = (proxy) => {
    const rewrite = (proxyReq: { setHeader(name: string, value: string): unknown }, req: IncomingMessage) => {
      if (fromDevPage(req)) proxyReq.setHeader("origin", workerOrigin);
    };
    proxy.on("proxyReq", rewrite);
    proxy.on("proxyReqWs", rewrite);
  };
  const route = (ws: boolean): ProxyOptions => ({ target, changeOrigin: true, ws, configure: sameOrigin });
  return {
    // Each Channel's API (/r/<owner>/<repo>/api) and its stream, sign-in (/auth) and the webhook (/api).
    "/r": route(true),
    "/auth": route(false),
    "/api": route(false),
  };
}
