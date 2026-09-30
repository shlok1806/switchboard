// A minimal WebSocket client (RFC 6455, offering permessage-deflate from RFC 7692),
// the way Codex opens its Responses API socket: masked frames, compressed messages
// with the window kept between them. Used by the tests and the fake Codex, since
// Node's own WebSocket cannot open plain ws:// connections on every Node version.

import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import * as zlib from "node:zlib";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC11B80";
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

function sync(stream, data) {
  return new Promise((resolve, reject) => {
    const out = [];
    const onData = (chunk) => out.push(chunk);
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

function frame(opcode, payload, rsv1) {
  const head = [0x80 | (rsv1 ? 0x40 : 0) | opcode];
  if (payload.length < 126) head.push(0x80 | payload.length);
  else if (payload.length < 65536) head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  else {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    head.push(0x80 | 127, ...len);
  }
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(head), key, body]);
}

/**
 * Opens a WebSocket to `url` (ws://). Resolves once open; rejects with the status
 * when the server refuses the upgrade.
 */
export function connect(url, headers = {}) {
  const target = new URL(url.replace(/^ws/, "http"));
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = request(target, {
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
      },
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`WebSocket refused: ${res.statusCode}`));
    });
    req.on("error", reject);
    req.on("upgrade", (res, socket, head) => {
      const accept = createHash("sha1")
        .update(key + GUID)
        .digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        reject(new Error("bad Sec-WebSocket-Accept"));
        return;
      }
      const deflate = /permessage-deflate/i.test(String(res.headers["sec-websocket-extensions"] ?? ""));
      const compressor = deflate ? zlib.createDeflateRaw({ windowBits: 15 }) : null;
      const decompressor = deflate ? zlib.createInflateRaw({ windowBits: 15 }) : null;
      let buffer = Buffer.alloc(0);
      let parts = [];
      let compressed = false;
      let chain = Promise.resolve();
      let sending = Promise.resolve();
      let closedResolve;
      const ws = {
        deflate,
        messages: [],
        onMessage: undefined,
        closed: new Promise((r) => {
          closedResolve = r;
        }),
        send(text) {
          sending = sending.then(async () => {
            let payload = Buffer.from(text, "utf8");
            if (compressor) {
              const out = await sync(compressor, payload);
              payload = out.subarray(0, out.length - 4);
            }
            socket.write(frame(0x1, payload, compressor !== null));
          });
          return sending;
        },
        close() {
          socket.end(frame(0x8, Buffer.from([0x03, 0xe8]), false));
        },
      };
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const b0 = buffer[0];
          let len = buffer[1] & 0x7f;
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
          if (buffer.length < off + len) return;
          const payload = buffer.subarray(off, off + len);
          buffer = buffer.subarray(off + len);
          const opcode = b0 & 0x0f;
          if (opcode === 0x8) {
            socket.end();
            return;
          }
          if (opcode >= 0x8) continue;
          if (opcode !== 0) {
            parts = [];
            compressed = (b0 & 0x40) !== 0;
          }
          parts.push(Buffer.from(payload));
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
      };
      socket.on("data", onData);
      socket.on("error", () => {});
      socket.on("close", () => {
        compressor?.destroy();
        decompressor?.destroy();
        closedResolve();
      });
      if (head.length > 0) onData(head);
      resolve(ws);
    });
    req.end();
  });
}
