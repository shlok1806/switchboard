// A minimal WebSocket server (RFC 6455, with permessage-deflate from RFC 7692 when
// the client offers it), for fake model APIs that run turns over a WebSocket the
// way the Responses API does for Codex. Server frames go unmasked; client frames
// are unmasked on arrival. Compression keeps its window across messages (context
// takeover), as real servers do by default.

import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import * as zlib from "node:zlib";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC11B80";
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

export interface WsConnection {
  path: string;
  headers: IncomingMessage["headers"];
  deflate: boolean;
  /** Sends one text message, split into `fragments` frames. */
  send(text: string, fragments?: number): Promise<void>;
  /** Every text message the client sent, in order. */
  messages: string[];
  onMessage?: (text: string) => void;
  close(): void;
}

function frame(opcode: number, fin: boolean, rsv1: boolean, payload: Buffer): Buffer {
  const head: number[] = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
  if (payload.length < 126) head.push(payload.length);
  else if (payload.length < 65536) head.push(126, payload.length >> 8, payload.length & 0xff);
  else {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    head.push(127, ...len);
  }
  return Buffer.concat([Buffer.from(head), payload]);
}

function sync(stream: zlib.DeflateRaw | zlib.InflateRaw, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const onData = (chunk: Buffer) => out.push(chunk);
    stream.on("data", onData);
    stream.once("error", reject);
    stream.write(data);
    stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      stream.off("data", onData);
      stream.off("error", reject);
      resolve(Buffer.concat(out));
    });
  });
}

/** Accepts WebSocket upgrades on `server`; `onConnection` gets each one. */
export function acceptWebSockets(
  server: Server,
  onConnection: (ws: WsConnection) => void,
  options: { deflate?: boolean; refuse?: () => boolean } = {},
): void {
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    if (options.refuse?.()) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    const offered = /permessage-deflate/i.test(String(req.headers["sec-websocket-extensions"] ?? ""));
    const deflate = offered && options.deflate !== false;
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(deflate ? ["Sec-WebSocket-Extensions: permessage-deflate"] : []),
        "",
        "",
      ].join("\r\n"),
    );
    const compressor = deflate ? zlib.createDeflateRaw({ windowBits: 15 }) : null;
    const decompressor = deflate ? zlib.createInflateRaw({ windowBits: 15 }) : null;
    let buffer: Buffer = Buffer.alloc(0);
    let parts: Buffer[] = [];
    let compressed = false;
    let chain: Promise<unknown> = Promise.resolve();
    let sending: Promise<unknown> = Promise.resolve();
    const ws: WsConnection = {
      path: req.url ?? "/",
      headers: req.headers,
      deflate,
      messages: [],
      send(text, fragments = 1) {
        sending = sending.then(async () => {
          let payload: Buffer = Buffer.from(text, "utf8");
          if (compressor) {
            const out = await sync(compressor, payload);
            payload = out.subarray(0, out.length - 4);
          }
          const size = Math.ceil(payload.length / fragments) || 1;
          for (let i = 0; i < fragments; i++) {
            const part = payload.subarray(i * size, (i + 1) * size);
            socket.write(frame(i === 0 ? 0x1 : 0x0, i === fragments - 1, i === 0 && compressor !== null, part));
          }
        });
        return sending.then(() => undefined);
      },
      close() {
        socket.end(frame(0x8, true, false, Buffer.from([0x03, 0xe8])));
      },
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const b0 = buffer[0] ?? 0;
        const b1 = buffer[1] ?? 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          off = 10;
        }
        const mask = buffer.subarray(off, off + 4);
        off += 4;
        if (buffer.length < off + len) return;
        const payload = Buffer.from(buffer.subarray(off, off + len));
        for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
        buffer = buffer.subarray(off + len);
        const opcode = b0 & 0x0f;
        if (opcode === 0x8) {
          socket.end(frame(0x8, true, false, Buffer.from([0x03, 0xe8])));
          return;
        }
        if (opcode >= 0x8) continue;
        if (opcode !== 0) {
          parts = [];
          compressed = (b0 & 0x40) !== 0;
        }
        parts.push(payload);
        if ((b0 & 0x80) === 0) continue;
        const data = Buffer.concat(parts);
        const wasCompressed = compressed;
        chain = chain.then(async () => {
          const text = (
            wasCompressed && decompressor ? await sync(decompressor, Buffer.concat([data, TAIL])) : data
          ).toString("utf8");
          ws.messages.push(text);
          ws.onMessage?.(text);
        });
      }
    });
    socket.on("error", () => {});
    // An upgraded socket is half-open; close ours when the client closes its side.
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      compressor?.destroy();
      decompressor?.destroy();
    });
    onConnection(ws);
  });
}
