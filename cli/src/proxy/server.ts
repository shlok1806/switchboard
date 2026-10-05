// The Proxy Capture's local proxy. The wrapper starts it on 127.0.0.1 and points
// the agent CLI at it with the CLI's own base-URL setting (ANTHROPIC_BASE_URL for
// Claude Code). It forwards every request and response to the real upstream
// unchanged, byte for byte and as it arrives (SSE streams included), and tunnels
// WebSockets the same way. It keeps nothing of the headers, so auth headers are
// never captured. Alongside, it reads a copy of each model turn (which requests
// are turns, and how to read them, is the API format's business: api.ts) and
// hands the finished turn to `onTurn`. Anything that goes wrong in the capture is
// logged and dropped; it never touches the traffic.

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { PassThrough, type Transform } from "node:stream";
import * as zlib from "node:zlib";
import { RAW_PROXY_CAP_BYTES } from "../../../shared/src/index";
import { anthropicMessages } from "./anthropic";
import { type ApiFormat, type EventParser, type RequestedModel, record, safeParse } from "./api";
import { CappedBody, type TurnInput } from "./turn";
import { agreedDeflate, MessageReader } from "./websocket";

/** The Anthropic API, when the agent CLI had no ANTHROPIC_BASE_URL of its own. */
export const DEFAULT_UPSTREAM = anthropicMessages.defaultUpstream;

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
  /** The model API the traffic speaks. Anthropic's Messages API unless set. */
  api?: ApiFormat;
  /** Whether to capture turns right now. Asked per request, so a mode change applies to the next turn. */
  capturing: () => { capture: boolean; raw: boolean };
  /** A finished model turn. */
  onTurn: (turn: TurnInput) => void;
  log: (line: string) => void;
}

/** The most of a request read to tell a CLI's own calls from turns; past it, a request counts as a turn. */
const MAX_REQUEST_READ_BYTES = 32 * 1024 * 1024;

/** What the capture keeps of one turn request. */
interface Capture {
  raw: boolean;
  path: string;
  /** The request as a Raw Proxy Event shows it: raw mode only, cut to the cap. */
  request: CappedBody;
  /** The whole request, for the API format's `background` check. */
  whole: CappedBody | null;
  /** Resolves once the request has all been read (and decoded), or given up on. */
  requestRead: Promise<void>;
}

/** How long a finished answer waits for the rest of its request before the turn goes on without it. */
const REQUEST_READ_TIMEOUT_MS = 10_000;

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

/** A WebSocket handshake's headers for the upstream: the upgrade kept, `host` set for the upstream. */
function upgradeHeaders(raw: string[], host: string): string[] {
  const out = forwardHeaders(raw, host);
  for (let i = 0; i < raw.length; i += 2) {
    const lower = (raw[i] ?? "").toLowerCase();
    if (lower === "connection" || lower === "upgrade") out.push(raw[i] ?? "", raw[i + 1] ?? "");
  }
  return out;
}

/** An HTTP response head, as the upstream sent it, for a tunnelled socket. */
function responseHead(res: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ""}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export class ProxyServer {
  private readonly server: Server;
  private readonly upstream: URL;
  private readonly api: ApiFormat;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly sockets = new Set<Socket>();

  private constructor(private readonly options: ProxyServerOptions) {
    this.upstream = new URL(options.upstream);
    this.api = options.api ?? anthropicMessages;
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.tunnel(req, socket, head));
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
    for (const socket of this.sockets) socket.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Where a request for `path` goes upstream. */
  private target(path: string): URL {
    const prefix = this.upstream.pathname.replace(/\/+$/, "");
    return new URL(`${prefix}${path}`, this.upstream.origin);
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? "/";
    const target = this.target(path);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    const mode = this.api.isTurn(req.method, path) ? this.safe(() => this.options.capturing()) : undefined;
    // Resolved once the request is all in, the CLI gave up on it, or the guard ran out.
    let read: () => void = () => {};
    const requestRead = new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, REQUEST_READ_TIMEOUT_MS);
      guard.unref();
      read = () => {
        clearTimeout(guard);
        resolve();
      };
    });
    const capture: Capture | null = mode?.capture
      ? {
          raw: mode.raw,
          path,
          request: new CappedBody(RAW_PROXY_CAP_BYTES),
          // The whole request, in either mode, when the API can tell the CLI's own calls
          // from it, or read the model it asks for (ADR 0010).
          whole: this.api.background || this.api.requested ? new CappedBody(MAX_REQUEST_READ_BYTES) : null,
          requestRead,
        }
      : null;
    const reading = capture !== null && (capture.raw || capture.whole !== null);
    const keep = (chunk: Buffer) => {
      if (capture?.raw) capture.request.push(chunk);
      capture?.whole?.push(chunk);
    };
    // A compressed request body (Codex sends zstd) is read decoded, for the capture's copy only.
    const requestEncoding = String(req.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase();
    const requestDecoder =
      reading && requestEncoding !== "" && requestEncoding !== "identity" ? decoderFor(requestEncoding) : null;
    if (requestDecoder) {
      requestDecoder.on("data", (chunk: Buffer) => this.safe(() => keep(chunk)));
      // Read once the decoder has handed over its last bytes, or failed.
      requestDecoder.on("end", read);
      requestDecoder.on("close", read);
      requestDecoder.on("error", (error) => {
        this.options.log(`proxy: could not decode a request: ${error.message}`);
        read();
      });
    }

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
      if (requestDecoder) this.safe(() => requestDecoder.write(chunk));
      else if (reading) this.safe(() => keep(chunk));
    });
    req.on("end", () => {
      upstreamReq.end();
      if (requestDecoder) requestDecoder.end();
      else read();
    });
    // The CLI went away mid-request: what was read is all there will be, and the turn
    // need not wait for more.
    req.on("error", () => {
      upstreamReq.destroy();
      read();
    });
    // Once the answer is done, Node detaches the request from its connection, so the request
    // no longer hears that the CLI left: the connection's close says so instead.
    const connection = req.socket;
    connection.once("close", read);
    void requestRead.then(() => connection.off("close", read));
    req.on("close", () => {
      if (!requestDecoder || !req.complete) read();
      else if (!requestDecoder.writableEnded) requestDecoder.end();
    });
    res.on("close", () => {
      if (res.writableFinished) return;
      // The CLI gave up (Escape, or a timeout): stop the upstream call too, as without the proxy.
      upstreamReq.destroy();
      read();
    });
  }

  /** The whole request, parsed, or null when it was not kept or is unreadable. */
  private wholeRequest(capture: Capture): Record<string, unknown> | null {
    if (!capture.whole || capture.whole.truncated) return null;
    const body = safeParse(capture.whole.text());
    return typeof body === "object" && body !== null && !Array.isArray(body) ? record(body) : null;
  }

  /** What a request is when the CLI made it for itself, from the whole request; null for a turn or when unreadable. */
  private backgroundCall(body: Record<string, unknown> | null): string | null {
    return this.api.background && body !== null ? this.api.background(body) : null;
  }

  /** Starts reading one model turn's response. */
  private startTurn(
    upstreamRes: IncomingMessage,
    capture: Capture,
  ): { push: (chunk: Buffer) => void; end: () => void; abort: () => void } | null {
    const decoder = decoderFor(upstreamRes.headers["content-encoding"]);
    if (!decoder) {
      this.options.log(`proxy: cannot read ${upstreamRes.headers["content-encoding"]} responses; turn not captured`);
      return null;
    }
    const reader = this.api.reader({
      path: capture.path,
      contentType: String(upstreamRes.headers["content-type"] ?? ""),
    });
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
      // The answer can end before the request is in, or decoded (an API may answer early,
      // and a compressed request decodes on its own time): the turn needs both.
      void capture.requestRead.then(() => {
        this.inFlight.delete(done);
        this.safe(() => {
          reader.end();
          const body = !failed && reader.seen ? this.wholeRequest(capture) : null;
          const own = this.backgroundCall(body);
          if (own !== null) this.options.log(`proxy: not captured: ${own}`);
          else if (!failed && reader.seen) {
            const requested = body !== null ? this.api.requested?.(body) : undefined;
            this.options.onTurn({
              reader,
              request: capture.request,
              response,
              requestText: () => capture.request.text(),
              responseText: () => response.text(),
              ...(requested === undefined ? {} : { requested }),
            });
          }
        });
        finish();
      });
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

  /**
   * Tunnels a WebSocket to the upstream: the handshake and then every byte both
   * ways, unchanged and as they arrive. For an API that runs turns over it, the
   * capture reads a copy of each direction's messages.
   */
  private tunnel(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = req.url ?? "/";
    const target = this.target(path);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamReq = send(target, {
      method: req.method,
      headers: upgradeHeaders(req.rawHeaders, target.host),
    });
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => upstreamReq.destroy());
    upstreamReq.on("upgrade", (upstreamRes: IncomingMessage, upstream: Socket, upstreamHead: Buffer) => {
      this.sockets.add(upstream);
      upstream.on("close", () => {
        this.sockets.delete(upstream);
        socket.destroy();
      });
      socket.on("close", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.write(responseHead(upstreamRes));
      const reading = this.api.websocket?.isTurnSocket(path)
        ? this.safe(() => this.readTurns(agreedDeflate(upstreamRes.headers["sec-websocket-extensions"])))
        : undefined;
      // The CLI's copy first, as it arrived; the capture reads it afterwards.
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
        if (reading) this.safe(() => reading.fromUpstream(upstreamHead));
      }
      if (head.length > 0) {
        upstream.write(head);
        if (reading) this.safe(() => reading.fromClient(head));
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
      if (reading) {
        upstream.on("data", (chunk: Buffer) => this.safe(() => reading.fromUpstream(chunk)));
        socket.on("data", (chunk: Buffer) => this.safe(() => reading.fromClient(chunk)));
        socket.on("close", () => reading.close());
      }
    });
    upstreamReq.on("response", (upstreamRes) => {
      // The upstream refused the upgrade: pass its answer on as it is.
      socket.write(responseHead(upstreamRes));
      upstreamRes.pipe(socket);
    });
    upstreamReq.on("error", (error) => {
      this.options.log(`proxy: WebSocket ${path} failed upstream: ${error.message}`);
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    });
    upstreamReq.end();
  }

  /** Reads model turns from a copy of a WebSocket's messages: a client message starts one, events fill it. */
  private readTurns(deflate: boolean): {
    fromClient: (chunk: Buffer) => void;
    fromUpstream: (chunk: Buffer) => void;
    close: () => void;
  } {
    const ws = this.api.websocket;
    if (!ws) throw new Error("this API has no WebSocket turns");
    type Turn = {
      reader: EventParser;
      raw: boolean;
      request: CappedBody;
      response: CappedBody;
      finish: () => void;
      requested?: RequestedModel;
    };
    let turn: Turn | null = null;
    const stop = (current: Turn | null) => {
      if (!current) return;
      if (turn === current) turn = null;
      current.finish();
    };
    const failed = (reason: string) => {
      this.options.log(`proxy: ${reason}; WebSocket turns not captured`);
      stop(turn);
    };
    const client = new MessageReader(
      deflate,
      (text) =>
        this.safe(() => {
          const message = record(safeParse(text));
          if (!ws.startsTurn(message)) return;
          stop(turn);
          const mode = this.options.capturing();
          if (!mode.capture) return;
          let finish: () => void = () => {};
          const done = new Promise<void>((resolve) => {
            finish = () => {
              this.inFlight.delete(done);
              resolve();
            };
          });
          this.inFlight.add(done);
          const next: Turn = {
            reader: ws.reader(),
            raw: mode.raw,
            request: new CappedBody(RAW_PROXY_CAP_BYTES),
            response: new CappedBody(RAW_PROXY_CAP_BYTES),
            finish,
            ...(this.api.requested ? { requested: this.api.requested(message) } : {}),
          };
          if (mode.raw) next.request.push(Buffer.from(text, "utf8"));
          turn = next;
        }),
      failed,
    );
    const upstream = new MessageReader(
      deflate,
      (text) => {
        const current = turn;
        if (!current) return;
        this.safe(() => {
          current.reader.event(record(safeParse(text)));
          if (current.raw) current.response.push(Buffer.from(`${text}\n`, "utf8"));
          if (!current.reader.done) return;
          stop(current);
          if (current.reader.seen) {
            this.options.onTurn({
              reader: current.reader,
              request: current.request,
              response: current.response,
              requestText: () => current.request.text(),
              responseText: () => current.response.text(),
              ...(current.requested === undefined ? {} : { requested: current.requested }),
            });
          }
        });
      },
      failed,
    );
    return {
      fromClient: (chunk) => client.push(chunk),
      fromUpstream: (chunk) => upstream.push(chunk),
      close: () => {
        // Let messages already read finish, then drop an unfinished turn.
        void Promise.all([client.settled(), upstream.settled()]).then(() => {
          client.close();
          upstream.close();
          stop(turn);
        });
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
