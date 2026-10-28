// What the Host's supervisor does with frames that are valid JSON but no frame at all
// (ADR 0015). It reads them off a real socket from a stand-in Channel, and has to keep
// running, and keep answering, whatever comes.

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostSupervisor } from "../src/host/supervisor";

/** A Channel that speaks just enough WebSocket: it sends text frames and reads the Host's. */
async function standInChannel() {
  const received: string[] = [];
  let socket: Socket | undefined;
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const server: Server = createServer();
  server.on("upgrade", (request, upgraded: Socket) => {
    const key = String(request.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    upgraded.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    upgraded.on("data", (data: Buffer) => {
      // The Host's frames are masked text frames under 64 KiB, each in one read.
      const short = (data[1] ?? 0) & 0x7f;
      const [length, start] = short === 126 ? [data.readUInt16BE(2), 4] : [short, 2];
      const mask = data.subarray(start, start + 4);
      const payload = data.subarray(start + 4, start + 4 + length).map((byte, i) => byte ^ (mask[i % 4] ?? 0));
      received.push(Buffer.from(payload).toString("utf8"));
    });
    socket = upgraded;
    connected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ready,
    received,
    send(text: string) {
      const payload = Buffer.from(text);
      socket?.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    },
    close: () => {
      socket?.destroy();
      server.close();
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the Host's supervisor", () => {
  it("ignores null, a list, a number and an untyped object, and still answers the next spawn", async () => {
    const channel = await standInChannel();
    const dir = await mkdtemp(join(tmpdir(), "host-frames-"));
    const lines: string[] = [];
    const supervisor = new HostSupervisor({
      config: { url: channel.url, repo: "shlok/app", session: "s", person: "shlok" },
      settings: {
        name: "studio",
        repo: "shlok/app",
        roots: [dir],
        maxPermissionMode: "default",
        maxAgents: 2,
        allow: [],
        allowChannel: false,
      },
      node: process.execPath,
      cli: "/nonexistent",
      env: { ...process.env, SWITCHBOARD_CONFIG_DIR: dir },
      log: (line) => lines.push(line),
    });
    cleanups.push(
      () => rm(dir, { recursive: true, force: true }),
      channel.close,
      () => supervisor.shutdown(),
    );
    supervisor.start();
    await channel.ready;

    for (const frame of [
      "null",
      "[1]",
      "7",
      '"host.spawn"',
      "{}",
      '{"type":null}',
      '{"type":"host.spawn","spawn":null}',
    ]) {
      channel.send(frame);
    }
    // A spawn asking for a folder outside the Host's: the Host must still be there to refuse it.
    channel.send(JSON.stringify({ type: "host.spawn", spawn: "sp_1", cli: "claude-code", cwd: "/", by: "shlok" }));
    const deadline = Date.now() + 5000;
    while (channel.received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    expect(channel.received.map((text) => JSON.parse(text))).toEqual([
      expect.objectContaining({ type: "host.spawn.failed", spawn: "sp_1" }),
    ]);
    expect(lines.filter((line) => line.startsWith("could not handle"))).toEqual([]);
  });
});
