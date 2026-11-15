import { describe, expect, it } from "vitest";
import type { ChannelEvent, Person } from "../../shared/src/domain";
import { safePerson, safeSharedEvent } from "../src/managed-projection";

describe("managed shared projection preparation", () => {
  it("constructs Persons by allowlist without copying account or future fields", () => {
    const source = {
      name: "alice",
      timeZone: "UTC",
      joinedAt: "now",
      account: "private-marker",
      future: "private-marker",
    };
    expect(safePerson(source as Person)).toEqual({ name: "alice", timeZone: "UTC", joinedAt: "now" });
  });
  it("constructs shared Update fields and actors without Capture or session metadata", () => {
    const event = {
      id: "event",
      seq: 1,
      at: "now",
      actor: { kind: "person", person: "alice", extra: "private-marker" },
      capture: "private-marker",
      turn: "private-marker",
      type: "update",
      payload: { text: "shared", extra: "private-marker" },
    };
    expect(safeSharedEvent(event as unknown as ChannelEvent)).toEqual({
      id: "event",
      seq: 1,
      at: "now",
      actor: { kind: "person", person: "alice" },
      type: "update",
      payload: { text: "shared" },
    });
  });
  for (const type of ["directive", "wake", "session.start", "approval.pending", "unknown"]) {
    it(`omits ${type} payloads by default`, () => {
      expect(
        safeSharedEvent({
          id: "event",
          seq: 1,
          at: "now",
          actor: { kind: "relay" },
          type,
          payload: { private: "private-marker" },
        } as unknown as ChannelEvent),
      ).toBeNull();
    });
  }
  it("omits directed Updates from the shared projection", () => {
    expect(
      safeSharedEvent({
        id: "event",
        seq: 1,
        at: "now",
        actor: { kind: "relay" },
        type: "update",
        payload: { text: "private-marker", to: ["alice/codex/session"] },
      } as unknown as ChannelEvent),
    ).toBeNull();
  });
});
