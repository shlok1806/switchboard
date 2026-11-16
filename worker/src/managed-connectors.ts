import type { ChannelEvent } from "../../shared/src/domain";
import { noteFromEvent } from "../../shared/src/index";
import { safeMemoryNote } from "./managed-projection";
import type { ConstituentDescriptor } from "./managed-query";
import { type ManagedAttributionHost, managedAgentAttribution } from "./managed-query-attribution";
import type { ChannelAuthorization } from "./organization";

const page = { source: "stored" as const, selector: { kind: "tail" as const }, wakesOnly: false, limit: 10000 };
const scope = (input: ChannelAuthorization, action: string, targetId: string): ChannelAuthorization => ({
  ...input,
  action,
  targetExecutionId: undefined,
  resource: { ...input.resource, targetId, operation: "connector.constituent" },
});

/** Legacy authors and earlier versions never cross the managed boundary. */
export function managedBriefConstituent(
  sql: SqlStorage,
  input: ChannelAuthorization,
  area?: string,
): ConstituentDescriptor<unknown> {
  return {
    id: "brief",
    authorization: scope(input, "channel.update.read", "brief"),
    page,
    readWindow: async (position, limit) => {
      const rows = sql
        .exec<{ page: string; title: string; text: string; version: number }>(
          "SELECT page,title,text,version FROM brief_pages WHERE page > ? ORDER BY page LIMIT ?",
          position ?? "",
          limit,
        )
        .toArray();
      return {
        rows: rows.map((row) => ({ key: row.page, value: row })),
        nextInternal: rows.at(-1)?.page ?? null,
        exhausted: rows.length === 0,
      };
    },
    projection: {
      id: "safe-brief",
      project: async (row, context) => {
        const value = row.value as { page: string; title: string; text: string; version: number };
        if (area !== undefined && value.page !== area) return null;
        if (!(await context.check(scope(input, "channel.update.read", `brief/${value.page}`)))) return null;
        return { page: value.page, title: value.title, text: value.text, version: value.version };
      },
    },
  };
}

/** Native historical attribution and independently protected constituent sources. */
export function managedConnectorConstituents(
  host: ManagedAttributionHost & { sql: SqlStorage; event(row: unknown): ChannelEvent },
): ConstituentDescriptor<unknown>[] {
  return [
    {
      id: "history",
      authorization: scope(host.input, "channel.history.read", "events"),
      page,
      readWindow: async () => ({ rows: [], nextInternal: null, exhausted: true }),
      projection: { id: "history-scope", project: async () => null },
    },
    {
      id: "notes",
      authorization: scope(host.input, "channel.update.read", "memory"),
      page,
      readWindow: async (position, limit) => {
        const rows = host.sql
          .exec<{ id: string; seq: number }>(
            "SELECT * FROM events WHERE type='memory.note' AND seq > ? ORDER BY seq LIMIT ?",
            position === null ? 0 : Number(position),
            limit,
          )
          .toArray();
        return {
          rows: rows.map((row) => ({ key: row.id, value: row })),
          nextInternal: rows.length ? String(rows.at(-1)?.seq) : null,
          exhausted: rows.length === 0,
        };
      },
      projection: {
        id: "safe-connector-note",
        project: async (row, context) => {
          const event = host.event(row.value);
          const note = noteFromEvent(event);
          if (!note || event.actor.kind !== "agent") return null;
          if (!(await managedAgentAttribution(host, event.actor.agentId, context, Date.parse(event.at)))) return null;
          if (note.task !== undefined && !(await context.check(scope(host.input, "task.read", String(note.task)))))
            return null;
          return safeMemoryNote(note, { kind: "agent", agentId: event.actor.agentId });
        },
      },
    },
  ];
}
