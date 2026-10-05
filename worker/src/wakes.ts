// Idle wake, the Channel's side (see shared/src/wakes.ts). The wrapper wakes its own
// Agent; the Channel records it, so People can see why the Agent started a turn:
//
// - `wake`: a `wake` Event naming the Verdicts and Directives the wrapper typed. Only
//   ones that were Queued for that Agent count, whatever else the frame names.
// - `wake.capped`: the wrapper stopped waking its Agent at the cap. The Channel posts
//   an Update for the Agent saying so, with no Task, so it wakes no one in turn.

import type { AgentId, ChannelEvent, EventPayloads, Verdict } from "../../shared/src/index";
import { WAKE_WINDOW_MS, wakeCappedText } from "../../shared/src/index";
import type { NewEvent } from "./channel";

/** The most IDs one `wake` frame may name, of each kind. */
const MAX_WAKE_IDS = 200;

export interface WakesHost {
  sql: SqlStorage;
  append(event: NewEvent<"wake"> | NewEvent<"update">): ChannelEvent;
}

type Row = { id: string; type: string; payload: string };

export class Wakes {
  /** When the Channel last posted a cap Update per Agent, so a wrapper cannot flood the Channel with them. */
  private readonly lastCapped = new Map<AgentId, number>();

  constructor(private readonly host: WakesHost) {}

  /**
   * Agent `agent`'s wrapper woke it with these Deliveries (Verdict IDs) and Directives.
   * Records a `wake` Event with the ones that were Queued for that Agent, or nothing when none were.
   */
  woke(agent: AgentId, deliveries: readonly string[], directives: readonly string[]): ChannelEvent | null {
    const verdicts = this.events(deliveries).flatMap((row) => {
      if (row.type !== "verdict") return [];
      const verdict = JSON.parse(row.payload) as Verdict;
      return verdict.agent === agent && verdict.delivered === "queue" ? [{ id: row.id, event: verdict.event }] : [];
    });
    const sent = this.events(directives).filter(
      (row) => row.type === "directive" && (JSON.parse(row.payload) as EventPayloads["directive"]).to === agent,
    );
    if (verdicts.length === 0 && sent.length === 0) return null;
    return this.host.append({
      type: "wake",
      actor: { kind: "agent", agentId: agent },
      capture: null,
      payload: {
        verdicts: verdicts.map((verdict) => verdict.id),
        events: verdicts.map((verdict) => verdict.event),
        directives: sent.map((row) => row.id),
      },
    });
  }

  /** Agent `agent`'s wrapper stopped waking it: posts an Update saying so, at most once per window. */
  capped(agent: AgentId, now = Date.now()): ChannelEvent | null {
    const last = this.lastCapped.get(agent);
    if (last !== undefined && now - last < WAKE_WINDOW_MS) return null;
    this.lastCapped.set(agent, now);
    return this.host.append({
      type: "update",
      actor: { kind: "agent", agentId: agent },
      capture: null,
      payload: { text: wakeCappedText(agent) },
    });
  }

  /** The stored Events with these IDs, in the order given, each once. */
  private events(ids: readonly string[]): Row[] {
    const unique = [...new Set(ids)].slice(0, MAX_WAKE_IDS);
    const rows: Row[] = [];
    for (const id of unique) {
      const row = this.host.sql.exec<Row>("SELECT id, type, payload FROM events WHERE id = ?", id).toArray()[0];
      if (row) rows.push(row);
    }
    return rows;
  }
}
