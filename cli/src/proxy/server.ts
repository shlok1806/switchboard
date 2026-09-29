// The Proxy Capture's local proxy. The wrapper starts it on 127.0.0.1 and points
// the agent CLI at it with ANTHROPIC_BASE_URL. It forwards every request and
// response to the real upstream unchanged, byte for byte and as it arrives (SSE
// streams included), and keeps nothing of the headers, so auth headers are never
// captured. Alongside, it reads a copy of each model turn (`POST /v1/messages`)
// and hands the finished turn to `onTurn`. Anything that goes wrong in the capture
// is logged and dropped; it never touches the traffic.

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { PassThrough, type Transform } from "node:stream";
import * as zlib from "node:zlib";
import { RAW_PROXY_CAP_BYTES } from "../../../shared/src/index";
import { CappedBody, type TurnInput, TurnReader } from "./turn";

/** The Anthropic API, when the agent CLI had no ANTHROPIC_BASE_URL of its own. */
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/** Headers that belong to one connection, not to the message; Node sets its own. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

export interface ProxyServerOptions {
  /** Where requests really go, such as `https://api.anthropic.com` (a path prefix is kept). */
  upstream: string;
  /** Whether to capture turns right now. Asked per request, so a mode change applies to the next turn. */
  capturing: () => { capture: boolean; raw: boolean };
  /** A finished model turn. */
  onTurn: (turn: TurnInput) => void;
  log: (line: string) => void;
}

/** Whether a request is a model turn: `POST /v1/messages`, not `count_tokens`. */
function isModelTurn(method: string | undefined, path: string): boolean {
  return method === "POST" && /^\/v1\/messages(\?|$)/.test(path);
}

/** A decoder for the response's Content-Encoding, for the capture's copy only. */
function decoderFor(encoding: string | undefined): Transform | null {
  const name = (encoding ?? "").trim().toLowerCase();
  if (name === "" || name === "identity") return new PassThrough();
  if (name === "gzip" || name === "x-gzip") return zlib.createGunzip();
  if (name === "deflate") return zlib.createInflate();
  if (name === "br") return zlib.createBrotliDecompress();
  const zstd = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  if (name === "zstd" && zstd) return zstd();
  return null;
}

/** Raw header pairs, without hop-by-hop ones and with `host` set for the upstream. */
function forwardHeaders(raw: string[], host?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i] ?? "";
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (host !== undefined && lower === "host") continue;
    out.push(name, raw[i + 1] ?? "");
  }
  if (host !== undefined) out.push("Host", host);
  return out;
}

export class ProxyServer {
  private readonly server: Server;
  private readonly upstream: URL;
  private readonly inFlight = new Set<Promise<void>>();

  private constructor(private readonly options: ProxyServerOptions) {
    this.upstream = new URL(options.upstream);
    this.server = createServer((req, res) => this.forward(req, res));
    // Claude Code keeps connections alive between turns; do not cut them.
    this.server.keepAliveTimeout = 120_000;
    this.server.headersTimeout = 0;
    this.server.requestTimeout = 0;
  }

  /** Starts listening on a random port on 127.0.0.1. */
  static async start(options: ProxyServerOptions): Promise<ProxyServer> {
    const proxy = new ProxyServer(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, "127.0.0.1", () => {
        proxy.server.off("error", reject);
        resolve();
      });
    });
    proxy.server.on("error", (error) => options.log(`proxy server error: ${error.message}`));
    return proxy;
  }

  /** The base URL to give the agent CLI as ANTHROPIC_BASE_URL. */
  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Waits for turns still being read, up to `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? "/";
    const prefix = this.upstream.pathname.replace(/\/+$/, "");
    const target = new URL(`${prefix}${path}`, this.upstream.origin);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    const mode = isModelTurn(req.method, path) ? this.safe(() => this.options.capturing()) : undefined;
    const capture = mode?.capture ? { raw: mode.raw, request: new CappedBody(RAW_PROXY_CAP_BYTES) } : null;

    const upstreamReq = send(target, {
      method: req.method,
      headers: forwardHeaders(req.rawHeaders, target.host),
    });
    upstreamReq.on("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, forwardHeaders(upstreamRes.rawHeaders));
      res.flushHeaders();
      const status = upstreamRes.statusCode ?? 0;
      const turn = capture && status >= 200 && status < 300 ? this.startTurn(upstreamRes, capture) : null;
      upstreamRes.on("data", (chunk: Buffer) => {
        // The CLI's copy first, as it arrived; the capture reads it afterwards.
        res.write(chunk);
        if (turn) this.safe(() => turn.push(chunk));
      });
      upstreamRes.on("end", () => {
        res.end();
        if (turn) this.safe(() => turn.end());
      });
      upstreamRes.on("error", (error) => {
        this.options.log(`proxy: upstream response failed: ${error.message}`);
        res.destroy(error);
        turn?.abort();
      });
    });
    upstreamReq.on("error", (error) => {
      this.options.log(`proxy: ${req.method} ${path} failed upstream: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `Switchboard proxy: ${error.message}` },
          }),
        );
      } else {
        res.destroy(error);
      }
    });
    req.on("data", (chunk: Buffer) => {
      upstreamReq.write(chunk);
      if (capture?.raw) this.safe(() => capture.request.push(chunk));
    });
    req.on("end", () => upstreamReq.end());
    req.on("error", () => upstreamReq.destroy());
    res.on("close", () => {
      // The CLI gave up (Escape, or a timeout): stop the upstream call too, as without the proxy.
      if (!res.writableFinished) upstreamReq.destroy();
    });
  }

  /** Starts reading one model turn's response. */
  private startTurn(
    upstreamRes: IncomingMessage,
    capture: { raw: boolean; request: CappedBody },
  ): { push: (chunk: Buffer) => void; end: () => void; abort: () => void } | null {
    const decoder = decoderFor(upstreamRes.headers["content-encoding"]);
    if (!decoder) {
      this.options.log(`proxy: cannot read ${upstreamRes.headers["content-encoding"]} responses; turn not captured`);
      return null;
    }
    const streaming = /text\/event-stream/i.test(String(upstreamRes.headers["content-type"] ?? ""));
    const reader = new TurnReader(streaming);
    const response = new CappedBody(RAW_PROXY_CAP_BYTES);
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.inFlight.add(done);
    let failed = false;
    decoder.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      if (capture.raw) response.push(chunk);
    });
    decoder.on("error", (error) => {
      failed = true;
      this.options.log(`proxy: could not decode a response: ${error.message}`);
      this.inFlight.delete(done);
      finish();
    });
    decoder.on("end", () => {
      this.inFlight.delete(done);
      this.safe(() => {
        reader.end();
        if (!failed && reader.seen) {
          this.options.onTurn({
            reader,
            request: capture.request,
            response,
            requestText: () => capture.request.text(),
            responseText: () => response.text(),
          });
        }
      });
      finish();
    });
    return {
      push: (chunk) => decoder.write(chunk),
      end: () => decoder.end(),
      abort: () => {
        failed = true;
        decoder.destroy();
        this.inFlight.delete(done);
        finish();
      },
    };
  }

  private safe<T>(run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.options.log(`proxy capture failed: ${(error as Error).message}`);
      return undefined;
    }
  }
}
