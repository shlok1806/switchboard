import type { ChannelEvent, Task } from "../../shared/src/domain";
import { isDecisionRecord, LIBRARIAN_SCAN } from "../../shared/src/index";
import type { BriefBudget } from "./brief";
import { ManagedReadFailure } from "./managed-channel";
import type { SafeTask } from "./managed-projection";
import type { ConstituentDescriptor } from "./managed-query";
import {
  type ManagedAttributionHost,
  managedAgentAttribution,
  managedTaskProjection,
} from "./managed-query-attribution";
import type { ChannelAuthorization } from "./organization";

interface LibrarianHost extends ManagedAttributionHost {
  sql: SqlStorage;
  event(row: unknown): ChannelEvent;
  budget(): BriefBudget;
  quietAfterMs: number;
  now: number;
}
/** Shared-only changes. Unknown/private payloads never affect visible metadata. */
function change(event: ChannelEvent) {
  const base = { seq: event.seq, at: event.at };
  switch (event.type) {
    case "memory.note":
      return event.payload.tags.includes("decision") && event.actor.kind === "agent"
        ? {
            ...base,
            kind: "decision",
            by: event.actor.agentId,
            text: event.payload.text.slice(0, 600),
            ...(event.task === undefined ? {} : { task: event.task }),
          }
        : null;
    case "merge":
      return {
        ...base,
        kind: "merge",
        pr: event.payload.pr,
        branch: event.payload.branch,
        into: event.payload.into,
        files: event.payload.files.length,
        adrs: event.payload.files.map((file) => file.path).filter(isDecisionRecord),
      };
    case "task.create":
      return event.task === undefined
        ? null
        : { ...base, kind: "task-opened", task: event.task, title: event.payload.title };
    case "task.done":
      return event.task === undefined
        ? null
        : {
            ...base,
            kind: "task-closed",
            task: event.task,
            ...(event.payload.pr === undefined ? {} : { pr: event.payload.pr }),
          };
    case "task.reopen":
    case "task.remove":
      return event.task === undefined
        ? null
        : { ...base, kind: event.type === "task.reopen" ? "task-reopened" : "task-removed", task: event.task };
    case "claim.stale":
    case "claim.recovered":
      return event.task === undefined || event.payload.holder.kind !== "agent"
        ? null
        : {
            ...base,
            kind: event.type === "claim.stale" ? "claim-stale" : "claim-recovered",
            task: event.task,
            holder: event.payload.holder.agentId,
          };
    default:
      return null;
  }
}
export function managedLibrarian(host: LibrarianHost) {
  const { input, sql } = host;
  const page = { source: "stored" as const, selector: { kind: "tail" as const }, wakesOnly: false, limit: 10000 };
  const scope = (action: string, targetId: string): ChannelAuthorization => ({
    ...input,
    action,
    targetExecutionId: undefined,
    resource: { ...input.resource, targetId, operation: "librarian.constituent" },
  });
  let cursor: { seq: number; quiet: string } | undefined;
  let budget: BriefBudget | undefined;
  const constituents: ConstituentDescriptor<unknown>[] = [
    {
      id: "tasks",
      authorization: scope("task.read", "tasks"),
      page,
      readWindow: async (position, limit) => {
        const rows = sql
          .exec<{ number: number; data: string }>(
            "SELECT number, data FROM tasks WHERE number > ? ORDER BY number LIMIT ?",
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
        id: "librarian-task",
        project: async (row, context) => {
          const task = row.value as Task;
          return managedTaskProjection(host, task, context);
        },
      },
    },
    {
      id: "brief",
      authorization: scope("channel.update.read", "brief"),
      page,
      readWindow: async (position, limit) => {
        if (budget === undefined) budget = host.budget();
        const rows = sql
          .exec<{ page: string }>(
            "SELECT page FROM brief_pages WHERE page > ? ORDER BY page LIMIT ?",
            position ?? "",
            limit,
          )
          .toArray();
        return {
          rows: rows.map((row) => ({ key: row.page, value: row.page })),
          nextInternal: rows.at(-1)?.page ?? null,
          exhausted: rows.length === 0,
        };
      },
      projection: {
        id: "librarian-brief",
        project: async (row, context) => {
          // Budget covers every page. Do not release it if a page is inaccessible.
          if (!(await context.check(scope("channel.update.read", `brief/${row.value}`))))
            throw new ManagedReadFailure(404);
          return { page: row.value };
        },
      },
    },
    {
      id: "events",
      authorization: scope("channel.update.read", "events"),
      page,
      readWindow: async (position, limit) => {
        if (position === null)
          cursor = sql
            .exec<{ seq: number; quiet: string }>("SELECT seq, quiet FROM librarian_cursor WHERE id = 1")
            .toArray()[0];
        const rows = sql
          .exec<{ id: string; seq: number }>(
            "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
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
        id: "librarian-event",
        project: async (row, context) => {
          const event = host.event(row.value);
          if (event.actor.kind !== "agent") return null;
          const update = event.type === "update" && !event.payload.to?.length;
          const projected = change(event);
          if (!update && !projected) return null;
          if (!(await managedAgentAttribution(host, event.actor.agentId, context, Date.parse(event.at)))) return null;
          if (
            (event.type === "claim.stale" || event.type === "claim.recovered") &&
            (event.payload.holder.kind !== "agent" ||
              !(await managedAgentAttribution(host, event.payload.holder.agentId, context)))
          )
            return null;
          if (event.task !== undefined && !(await context.check(scope("task.read", String(event.task))))) return null;
          return { seq: event.seq, at: event.at, task: event.task, update, change: projected };
        },
      },
    },
  ];
  return {
    constituents,
    assemble(parts: ReadonlyMap<string, readonly unknown[]>) {
      if ([...parts.values()].some((rows) => rows.length >= page.limit) || !budget) throw new ManagedReadFailure(503);
      const tasks = parts.get("tasks") as SafeTask[];
      const events = parts.get("events") as {
        seq: number;
        at: string;
        task?: number;
        update: boolean;
        change: ReturnType<typeof change>;
      }[];
      // A legacy stored position is never disclosed unless an admitted boundary proves it.
      const storedCursor = cursor?.seq;
      const visibleCursor =
        storedCursor === undefined ? null : (events.filter((event) => event.seq <= storedCursor).at(-1)?.seq ?? 0);
      const changes = events.filter((event) => event.change !== null && event.seq > (cursor?.seq ?? 0));
      const selected = changes.slice(0, LIBRARIAN_SCAN);
      const latestUpdate = new Map<number, string>();
      for (const event of events) if (event.update && event.task !== undefined) latestUpdate.set(event.task, event.at);
      const quiet = tasks.flatMap((task) => {
        if (task.claim?.holder.kind !== "agent" || !["claimed", "review"].includes(task.status)) return [];
        const claimedAt = task.claim.claimedAt;
        const last = latestUpdate.get(task.number);
        const since = last !== undefined && last >= claimedAt ? last : claimedAt;
        return host.now - Date.parse(since) > host.quietAfterMs
          ? [{ task: task.number, title: task.title, holder: task.claim.holder.agentId, since }]
          : [];
      });
      const now = quiet.map((item) => item.task);
      const visibleTasks = new Set(tasks.map((task) => task.number));
      const told = cursor ? (JSON.parse(cursor.quiet) as number[]).filter((number) => visibleTasks.has(number)) : [];
      return {
        cursor: visibleCursor,
        through:
          changes.length > LIBRARIAN_SCAN && cursor !== undefined
            ? (selected.at(-1)?.seq ?? visibleCursor ?? 0)
            : (events.at(-1)?.seq ?? visibleCursor ?? 0),
        more: cursor === undefined ? false : changes.length > LIBRARIAN_SCAN,
        changes: cursor === undefined ? [] : selected.map((event) => event.change),
        quiet,
        quietStarted: now.filter((number) => !told.includes(number)),
        quietEnded: told.filter((number) => !now.includes(number)),
        brief: {
          pages: parts.get("brief")?.length ?? 0,
          writesToday: budget.writesToday,
          perDay: budget.perDay,
          librarianToday: budget.librarianToday,
          librarianPerDay: budget.librarianPerDay,
        },
      };
    },
  };
}
