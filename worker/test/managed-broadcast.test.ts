import { describe, expect, it } from "vitest";
import { Channel } from "../src/channel";

// Exercise the production method without opening a transport or initializing storage.
describe("managed broadcast generation fence", () => {
  it("drops stale generations and treats untagged sockets as generation zero", () => {
    const sockets = [[], ["binding:0"], ["binding:1"], ["binding:2"], ["person", "host:a", "binding:2"]];
    const sent: number[] = [];
    const webSockets = sockets.map((_, i) => ({ send: () => sent.push(i) }));
    const channel = Object.create(Channel.prototype);
    Object.assign(channel, {
      binding: { generation: 2 },
      ctx: { getWebSockets: () => webSockets, getTags: (ws: WebSocket) => sockets[webSockets.indexOf(ws as never)] },
    });
    const broadcast = () => (channel as unknown as { broadcast(m: unknown): void }).broadcast({ type: "test" });
    broadcast();
    expect(sent).toEqual([3]);
    sent.length = 0;
    Object.assign(channel, { binding: { generation: 0 } });
    broadcast();
    expect(sent).toEqual([0, 1]);
    expect(sockets[0]).toEqual([]);
  });
});
