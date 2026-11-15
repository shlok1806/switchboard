import type { AgentId, ChannelEvent, Task } from "../../shared/src/domain";
import { noteFromEvent, SUMMARY_MAX_NOTES, SUMMARY_MAX_UPDATES } from "../../shared/src/index";
import type { SafeAgent } from "../../shared/src/m1";
import { ManagedReadFailure } from "./managed-channel";
import { type SafeMemoryNote, type SafeTask, safeMemoryNote } from "./managed-projection";
import type { ConstituentDescriptor, ProjectionContext } from "./managed-query";
import {
  type ManagedAttributionHost,
  managedAgentAttribution,
  managedTaskProjection,
} from "./managed-query-attribution";
import type { ChannelAuthorization } from "./organization";

interface SummaryHost extends ManagedAttributionHost {
  sql: SqlStorage;
  event(row: unknown): ChannelEvent;
}
/** Declarative summary sources. No local-machine history or legacy memory attribution. */
export function managedSummary(host: SummaryHost) {
  const { sql, input } = host;
  const target = input.resource.targetId as AgentId;
  const heldTasks = new Set<number>();
  const page = { source: "stored" as const, selector: { kind: "tail" as const }, wakesOnly: false, limit: 10000 };
  const scope = (action: string, targetId: string, operation = "summary.constituent"): ChannelAuthorization => ({
    ...input,
    action,
    targetExecutionId: undefined,
    resource: { ...input.resource, targetId, operation },
  });
  const agent = (id: AgentId, context: ProjectionContext, eventAt?: number) =>
    managedAgentAttribution(host, id, context, eventAt);
  const taskCheck = (number: number) => scope("task.read", String(number), "summary.task");
  const eventWindow = (type: string) => async (position: string | null, limit: number) => {
    const rows = sql
      .exec<{ id: string; seq: number }>(
        "SELECT * FROM events WHERE type = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
        type,
        position === null ? Number.MAX_SAFE_INTEGER : Number(position),
        limit,
      )
      .toArray();
    return {
      rows: rows.map((row) => ({ key: row.id, value: row })),
      nextInternal: rows.length ? String(rows.at(-1)?.seq) : null,
      exhausted: rows.length === 0,
    };
  };
  const constituents: ConstituentDescriptor<unknown>[] = [
    {
      id: "history",
      authorization: scope("channel.history.read", "events"),
      page,
      projection: { id: "history-scope", project: async () => null },
      readWindow: async () => ({ rows: [], nextInternal: null, exhausted: true }),
    },
    {
      id: "agents",
      authorization: input,
      page,
      readWindow: async (position, limit) => {
        const rows = sql
          .exec<{ id: string }>(
            "SELECT id FROM agents WHERE (id = ? OR continues = ?) AND id > ? ORDER BY id LIMIT ?",
            target,
            target,
            position ?? "",
            limit,
          )
          .toArray();
        return {
          rows: rows.map((row) => ({ key: row.id, value: row.id })),
          nextInternal: rows.at(-1)?.id ?? null,
          exhausted: rows.length === 0,
        };
      },
      projection: { id: "safe-summary-agent", project: async (row, context) => agent(row.value as AgentId, context) },
    },
    {
      id: "tasks",
      authorization: scope("task.read", "tasks"),
      page,
      readWindow: async (position, limit) => {
        const rows = sql
          .exec<{ number: number; data: string }>(
            "SELECT number, data FROM tasks WHERE holder_agent = ? AND number > ? ORDER BY number LIMIT ?",
            target,
            position === null ? 0 : Number(position),
            limit,
          )
          .toArray();
        return {
          rows: rows.map((row) => ({ key: String(row.number), value: JSON.parse(row.data) })),
          nextInternal: rows.length ? String(rows.at(-1)?.number) : null,
          exhausted: rows.length === 0,
        };
      },
      projection: {
        id: "safe-summary-task",
        project: async (row, context) => {
          const task = row.value as Task;
          if (task.status === "done" || task.claim?.holder.kind !== "agent" || task.claim.holder.agentId !== target)
            return null;
          const projected = await managedTaskProjection(host, task, context);
          if (projected) heldTasks.add(task.number);
          return projected;
        },
      },
    },
    {
      id: "events",
      authorization: scope("channel.update.read", "updates"),
      page: { ...page, limit: SUMMARY_MAX_UPDATES },
      readWindow: eventWindow("update"),
      projection: {
        id: "safe-summary-update",
        project: async (row, context) => {
          const event = host.event(row.value);
          if (
            event.type !== "update" ||
            event.payload.to?.length ||
            event.actor.kind !== "agent" ||
            event.actor.agentId !== target
          )
            return null;
          if (!(await agent(target, context, Date.parse(event.at)))) return null;
          if (event.task !== undefined && !(await context.check(taskCheck(event.task)))) return null;
          return {
            seq: event.seq,
            at: event.at,
            text: event.payload.text,
            ...(event.task === undefined ? {} : { task: event.task }),
          };
        },
      },
    },
    {
      id: "notes",
      authorization: scope("channel.update.read", "memory"),
      page: { ...page, limit: SUMMARY_MAX_NOTES },
      readWindow: eventWindow("memory.note"),
      projection: {
        id: "safe-summary-note",
        project: async (row, context) => {
          const event = host.event(row.value);
          if (event.actor.kind !== "agent") return null;
          const note = noteFromEvent(event);
          if (
            !note ||
            !(
              event.actor.agentId === target ||
              (note.task !== undefined &&
                heldTasks.has(note.task) &&
                note.tags.some((tag) => tag === "question" || tag === "dead-end"))
            )
          )
            return null;
          if (!(await agent(event.actor.agentId, context, Date.parse(event.at)))) return null;
          if (note.task !== undefined && !(await context.check(taskCheck(note.task)))) return null;
          return safeMemoryNote(note, { kind: "agent", agentId: event.actor.agentId });
        },
      },
    },
  ];
  return {
    constituents,
    assemble(parts: ReadonlyMap<string, readonly unknown[]>) {
      const agents = parts.get("agents") as SafeAgent[];
      if (agents.length >= page.limit || (parts.get("tasks")?.length ?? 0) >= page.limit)
        throw new ManagedReadFailure(503);
      const targetAgent = agents.find((agent) => agent.id === target);
      if (!targetAgent) throw new ManagedReadFailure(404);
      const tasks = (parts.get("tasks") as SafeTask[]).toSorted(
        (a, b) => (b.claim?.claimedAt ?? "").localeCompare(a.claim?.claimedAt ?? "") || b.number - a.number,
      );
      const held = new Set(tasks.map((task) => task.number));
      const notes = (parts.get("notes") as SafeMemoryNote[]).filter(
        (note) =>
          (note.author.kind === "agent" && note.author.agentId === target) ||
          (note.task !== undefined &&
            held.has(note.task) &&
            note.tags.some((tag) => tag === "question" || tag === "dead-end")),
      );
      return {
        agent: targetAgent,
        tasks,
        updates: (parts.get("events") as { seq: number }[])
          .toSorted((a, b) => b.seq - a.seq)
          .slice(0, SUMMARY_MAX_UPDATES),
        notes: notes.toSorted((a, b) => b.seq - a.seq).slice(0, SUMMARY_MAX_NOTES),
        successors: agents.filter((agent) => agent.id !== target),
        files: [],
        historyUnavailable: "managed_local_history_unavailable",
      };
    },
  };
}
