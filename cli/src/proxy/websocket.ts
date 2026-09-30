// Reads a copy of one direction of a WebSocket (RFC 6455) as whole messages, for
// the Proxy Capture. The proxy tunnels the socket's bytes unchanged; this only
// watches them. Compressed messages (permessage-deflate, RFC 7692) are inflated
// in order with one inflater per direction, since each side may refer back to its
// earlier messages. Anything it cannot read stops the capture of that direction,
// never the traffic.

import * as zlib from "node:zlib";

/** A message bigger than this is not read (the traffic still passes). */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** What RFC 7692 says to add back to a message before inflating it. */
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/** Inflates one direction's compressed messages, in order, keeping the window between them. */
class MessageInflater {
  private readonly inflate = zlib.createInflateRaw({ windowBits: 15 });
  private output: Buffer[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.inflate.on("data", (chunk: Buffer) => this.output.push(chunk));
  }

  decode(data: Buffer): Promise<Buffer> {
    const next = this.chain.then(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          this.output = [];
          const failed = (error: Error) => reject(error);
          this.inflate.once("error", failed);
          this.inflate.write(Buffer.concat([data, DEFLATE_TAIL]));
          this.inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
            this.inflate.off("error", failed);
            resolve(Buffer.concat(this.output));
          });
        }),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.inflate.destroy();
  }
}

/** Reads one direction of a WebSocket's bytes as text messages. */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private opcode = 0;
  private compressed = false;
  private broken = false;
  private readonly inflater: MessageInflater | null;
  private delivery: Promise<unknown> = Promise.resolve();

  /**
   * `deflate`: permessage-deflate was agreed for the socket. `onMessage` gets each
   * text message, in order. `onError` is told once if the stream cannot be read.
   */
  constructor(
    deflate: boolean,
    private readonly onMessage: (text: string) => void,
    private readonly onError: (reason: string) => void,
  ) {
    this.inflater = deflate ? new MessageInflater() : null;
  }

  push(chunk: Buffer): void {
    if (this.broken) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.broken) {
      const frame = this.nextFrame();
      if (!frame) break;
      this.frame(frame.fin, frame.rsv1, frame.opcode, frame.payload);
    }
  }

  /** Resolves once every message read so far has been handed on. */
  settled(): Promise<void> {
    return this.delivery.then(() => undefined);
  }

  close(): void {
    this.broken = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.inflater?.close();
  }

  private fail(reason: string): void {
    if (this.broken) return;
    this.close();
    this.onError(reason);
  }

  private nextFrame(): { fin: boolean; rsv1: boolean; opcode: number; payload: Buffer } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const first = b[0] ?? 0;
    const second = b[1] ?? 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.fail("a WebSocket frame is too big to read");
        return null;
      }
      length = Number(big);
      offset = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskAt = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return null;
    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (b[maskAt + (i % 4)] ?? 0);
    }
    this.buffer = b.subarray(offset + length);
    return { fin: (first & 0x80) !== 0, rsv1: (first & 0x40) !== 0, opcode: first & 0x0f, payload };
  }

  private frame(fin: boolean, rsv1: boolean, opcode: number, payload: Buffer): void {
    // Control frames (close, ping, pong) carry no messages.
    if (opcode >= 0x8) return;
    if (opcode !== 0x0) {
      this.opcode = opcode;
      this.compressed = rsv1;
      this.fragments = [];
      this.fragmentBytes = 0;
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      this.fail("a WebSocket message is too big to read");
      return;
    }
    if (!fin) return;
    const data = this.fragments.length === 1 ? (this.fragments[0] ?? Buffer.alloc(0)) : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    const text = this.opcode === 0x1;
    if (this.compressed) {
      if (!this.inflater) {
        this.fail("a compressed WebSocket message without permessage-deflate");
        return;
      }
      // Binary messages are inflated too, to keep the window in step.
      const decoded = this.inflater.decode(data);
      this.delivery = this.delivery.then(() =>
        decoded.then(
          (message) => {
            if (text && !this.broken) this.onMessage(message.toString("utf8"));
          },
          (error: Error) => this.fail(`could not inflate a WebSocket message: ${error.message}`),
        ),
      );
    } else if (text) {
      this.delivery = this.delivery.then(() => {
        if (!this.broken) this.onMessage(data.toString("utf8"));
      });
    }
  }
}

/** Whether a WebSocket handshake's response agreed on permessage-deflate. */
export function agreedDeflate(extensions: string | string[] | undefined): boolean {
  const value = Array.isArray(extensions) ? extensions.join(",") : (extensions ?? "");
  return value.split(",").some((ext) => (ext.split(";")[0] ?? "").trim().toLowerCase() === "permessage-deflate");
}
