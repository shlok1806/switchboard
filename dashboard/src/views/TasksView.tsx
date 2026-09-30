import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, Task } from "@shared/index";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
import { NewTaskButton } from "@/components/domain/new-task";
import { IssueLink, Pending } from "@/components/domain/pending";
import { COLUMN_LABEL, columnOf, type Column } from "@/components/domain/task";
import { decideMove, heldByMe } from "@/components/domain/moves";
import { FilterSelect } from "@/components/domain/filters";
import { TakeoverAction } from "@/components/domain/takeover";
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
  type KanbanMove,
} from "@/components/kibo-ui/kanban";
import { PixelIcon } from "@/components/pixel-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { holderName } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";

/* Left to right the way work flows. Stale Claims are a lane above the board. */
const FLOW: Column[] = ["open", "claimed", "review", "done"];

const HINT: Record<Column, string> = {
  stale: "The holder is Gone. Held until a Person takes it over with Take over.",
  open: "No Claim yet. Drag a card to Claimed to claim it.",
  claimed: "Held by an Agent or a Person. Drag your own back to Open to release it.",
  review: "Finished. Its pull request is open.",
  done: "Closed on GitHub.",
};

type Card = { id: string; name: string; column: Column; task: Task };

type Filters = { mine: boolean; blocked: boolean; person: string; agent: string };
const NO_FILTERS: Filters = { mine: false, blocked: false, person: "", agent: "" };

/** Open Issues a Task still waits on. */
function openBlockers(t: Task, taskByNumber: Map<number, Task>) {
  return t.blockedBy.filter((n) => taskByNumber.get(n)?.status !== "done");
}

function holderPerson(t: Task, agentById: Map<AgentId, Agent>): string | null {
  const h = t.claim?.holder;
  if (!h) return null;
  return h.kind === "person" ? h.person : (agentById.get(h.agentId)?.person ?? h.agentId.split("/")[0]);
}

export function TasksView() {
  const { tasks, agents, snapshot } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const store = useStore();
  const me = useMe();
  const can = useCapabilities();
  const mobile = useIsMobile();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Moves the Channel has not answered yet: the card waits in its new column.
  const [pending, setPending] = useState<Map<number, Column>>(new Map());

  const columns = FLOW.filter((c) => can.claims || (c !== "claimed" && c !== "review"));
  const persons = useMemo(() => {
    const names = new Set<string>((snapshot?.persons ?? []).map((p) => p.name));
    for (const t of tasks) {
      const p = holderPerson(t, agentById);
      if (p) names.add(p);
    }
    return [...names].sort();
  }, [snapshot, tasks, agentById]);

  const shown = useMemo(
    () =>
      tasks.filter((t) => {
        const h = t.claim?.holder;
        if (filters.mine && !(h && heldByMe(h, me, agentById))) return false;
        if (filters.blocked && openBlockers(t, taskByNumber).length === 0 && !t.claim?.blockedBy?.length) return false;
        if (filters.person && holderPerson(t, agentById) !== filters.person) return false;
        if (filters.agent && !(h?.kind === "agent" && h.agentId === filters.agent)) return false;
        return true;
      }),
    [tasks, filters, me, agentById, taskByNumber],
  );

  const cards: Card[] = useMemo(
    () =>
      [...shown]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((t) => ({ id: String(t.number), name: `#${t.number} ${t.title}`, column: pending.get(t.number) ?? columnOf(t), task: t })),
    [shown, pending],
  );
  const count = (c: Column) => cards.filter((x) => x.column === c).length;
  const stale = cards.filter((c) => c.column === "stale");

  const move = async ({ item, from: f, to: t }: KanbanMove<Card>) => {
    const from = f as Column;
    const to = t as Column;
    const task = item.task;
    const decision = decideMove(task, from, to, me, agentById, can.takeover);
    if (decision.kind === "refuse") {
      toast.error(`Can't move #${task.number} to ${COLUMN_LABEL[to]}`, { description: decision.reason });
      return;
    }
    setPending((p) => new Map(p).set(task.number, to));
    const result = decision.kind === "claim" ? await store.source.claim(task.number) : await store.source.release(task.number);
    if (result.ok) store.applyTask(result.task);
    setPending((p) => {
      const next = new Map(p);
      next.delete(task.number);
      return next;
    });
    if (result.ok) {
      toast.success(decision.kind === "claim" ? `Claimed #${task.number}` : `Released #${task.number}`, {
        description: decision.kind === "claim" ? `Held by ${me}. Mirrored to GitHub as an assignee.` : "It is Open again.",
      });
    } else {
      toast.error(decision.kind === "claim" ? `Could not claim #${task.number}` : `Could not release #${task.number}`, {
        // The Channel's reason already names the holder; say it only when it does not.
        description:
          result.heldBy && !result.reason.includes(holderName(result.heldBy))
            ? `${result.reason} Held by ${holderName(result.heldBy)}.`
            : result.reason,
      });
    }
  };

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Pending title="No Tasks yet">
          Every open GitHub Issue in the repo shows up here as a Task. If there should be some, the Channel may not reach
          GitHub right now.
        </Pending>
        <NewTaskButton />
      </div>
    );
  }

  const set = <K extends keyof Filters>(k: K) => (v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const active = Object.values(filters).filter(Boolean).length;
  const card = (c: Card) => (
    <KanbanCard key={c.id} {...c} onOpen={() => go({ view: "task", number: c.task.number })} className={cn(pending.has(c.task.number) && "opacity-70")}>
      <TaskCard
        task={c.task}
        agentById={agentById}
        taskByNumber={taskByNumber}
        me={me}
        waiting={pending.has(c.task.number)}
        moveMenu={
          mobile && can.claims ? (
            <MoveMenu column={c.column} onPick={(to) => move({ item: c, from: c.column, to })} options={columns} />
          ) : null
        }
      />
    </KanbanCard>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Quick filters, as on a Jira board */}
      <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-secondary px-2 py-1.5 sm:px-3">
        <span className="type-label hidden shrink-0 pr-1 md:inline">Quick filters</span>
        <Toggle on={filters.mine} onClick={() => set("mine")(!filters.mine)}>
          My Tasks
        </Toggle>
        <Toggle on={filters.blocked} onClick={() => set("blocked")(!filters.blocked)}>
          <PixelIcon name="blocked" /> Only blocked
        </Toggle>
        <FilterSelect label="Person" value={filters.person} onChange={set("person")} allLabel="Any Person" options={persons.map((p) => ({ value: p, label: p }))} />
        {can.agents && (
          <FilterSelect
            label="Agent"
            value={filters.agent}
            onChange={set("agent")}
            allLabel="Any Agent"
            options={agents.map((a) => ({ value: a.id, label: a.id }))}
          />
        )}
        {active > 0 && (
          <button type="button" className="btn-motif h-[26px] shrink-0 px-2 text-[12px] coarse:h-9" onClick={() => setFilters(NO_FILTERS)}>
            <PixelIcon name="close" /> Clear {active}
          </button>
        )}
        <span className="ml-auto shrink-0 pl-2 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground">
          {shown.length === tasks.length ? `${tasks.length} Tasks` : `${shown.length} of ${tasks.length}`}
        </span>
        <span className="shrink-0">
          <NewTaskButton />
        </span>
      </div>
      {!can.claims && (
        <p className="border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
          Claims arrive with <IssueLink capability="claims" />.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-hidden p-1.5 sm:p-2">
        <KanbanProvider<Card>
          columns={columns.map((c) => ({ id: c, name: COLUMN_LABEL[c] }))}
          data={cards}
          onMove={move}
          pointerDrag={!mobile}
          className={cn(
            "min-h-0",
            // A phone shows one column at a time and scrolls sideways between them.
            mobile ? "no-scrollbar snap-x snap-mandatory auto-cols-[calc(100%-28px)] overflow-x-auto" : "auto-cols-[minmax(200px,1fr)]",
          )}
          lane={
            can.claims && stale.length > 0 ? (
              <StaleLane count={stale.length}>
                <KanbanCards<Card> id="stale" className="flex-row flex-nowrap overflow-x-auto">
                  {(c) => (
                    <div key={c.id} className="w-[min(280px,80vw)] shrink-0">
                      {card(c)}
                    </div>
                  )}
                </KanbanCards>
              </StaleLane>
            ) : null
          }
        >
          {(column) => (
            <KanbanBoard key={column.id} id={column.id} className="min-h-0 snap-start">
              <KanbanHeader className="flex items-center gap-2" title={HINT[column.id as Column]}>
                <h2 className="type-label !text-secondary-foreground">{column.name}</h2>
                <span className="bevel-thin-in bg-card px-1.5 font-mono text-[11px] leading-[16px] tabular-nums">{count(column.id as Column)}</span>
              </KanbanHeader>
              <KanbanCards<Card> id={column.id} empty={<Empty column={column.id as Column} filtered={active > 0} />}>
                {card}
              </KanbanCards>
            </KanbanBoard>
          )}
        </KanbanProvider>
      </div>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("btn-motif h-[26px] shrink-0 px-2.5 text-[12px] coarse:h-9", on && "bg-muted font-bold")}
    >
      {children}
    </button>
  );
}

function StaleLane({ count, children }: { count: number; children: ReactNode }) {
  return (
    <section aria-label="Stale Claims" className="bevel-out mb-2 flex flex-col bg-secondary">
      <header className="titlebar-alert flex h-[22px] items-center gap-2 px-2 text-[12px] leading-none font-bold">
        <PixelIcon name="alert" />
        Stale Claim
        <span className="font-mono font-normal">{count}</span>
        <span className="ml-2 hidden truncate font-normal sm:inline">{HINT.stale}</span>
      </header>
      {children}
    </section>
  );
}

function Empty({ column, filtered }: { column: Column; filtered: boolean }) {
  if (filtered) return <p className="px-2 py-6 text-center text-[12px] text-faint">No Task here matches.</p>;
  const text: Record<Column, string> = {
    stale: "No Stale Claims.",
    open: "Nothing unclaimed.",
    claimed: "Nobody holds a Task.",
    review: "No Claim has a PR open.",
    done: "Nothing closed yet.",
  };
  return <p className="px-2 py-6 text-center text-[12px] text-faint">{text[column]}</p>;
}

/** The "Move to" menu that replaces dragging on a phone. */
function MoveMenu({ column, options, onPick }: { column: Column; options: Column[]; onPick: (c: Column) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Move to" className="btn-motif h-8 shrink-0 px-2 text-[12px]" onClick={(e) => e.stopPropagation()}>
          Move to <PixelIcon name="down" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {options
          .filter((c) => c !== column)
          .map((c) => (
            <DropdownMenuItem key={c} onSelect={() => onPick(c)}>
              {COLUMN_LABEL[c]}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two letters for a holder, the way Jira draws an assignee without a photo. */
function initials(name: string) {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function TaskCard({
  task,
  agentById,
  taskByNumber,
  me,
  waiting,
  moveMenu,
}: {
  task: Task;
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  me: string;
  waiting: boolean;
  moveMenu: ReactNode;
}) {
  const blockers = openBlockers(task, taskByNumber);
  // Claimed, and blocked only after the Claim was taken (#11): the Claim stays held.
  const blockedAfterClaim = task.claim?.blockedBy?.filter((n) => !blockers.includes(n)) ?? [];
  const h = task.claim?.holder;
  const person = h ? (h.kind === "person" ? h.person : (agentById.get(h.agentId)?.person ?? h.agentId.split("/")[0])) : null;
  const mine = h ? heldByMe(h, me, agentById) : false;
  const steps = { done: task.stepsDone, total: task.steps.length };
  const subs = { done: task.subtasksDone, total: task.subtasks.length };
  const done = task.status === "done";
  // `status:*` labels mirror the column the card already sits in (ADR 0001), so the card leaves them out.
  const labels = task.labels.filter((l) => !l.startsWith("status:"));

  return (
    <article className="flex flex-col gap-1.5 text-[13px] leading-snug">
      <p className={cn("line-clamp-3 break-words", done && "text-muted-foreground")}>{task.title}</p>

      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Labels">
          {labels.map((l) => (
            <li key={l} className="bevel-thin-in bg-muted px-1.5 font-mono text-[10.5px] leading-[16px] text-muted-foreground">
              {l}
            </li>
          ))}
        </ul>
      )}

      {blockers.length > 0 && (
        <p className="flex items-center gap-1 text-[12px] font-semibold text-red">
          <PixelIcon name="blocked" />
          Blocked by {blockers.map((n) => `#${n}`).join(", ")}
        </p>
      )}
      {blockedAfterClaim.length > 0 && (
        <p className="flex items-center gap-1 text-[12px] font-semibold text-orange" title="The Claim stays held until the blocker closes.">
          <PixelIcon name="blocked" />
          Claimed, now blocked by {blockedAfterClaim.map((n) => `#${n}`).join(", ")}
        </p>
      )}

      {h && (
        <p className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "grid size-5 shrink-0 place-items-center font-mono text-[9.5px] leading-none font-bold",
              task.claim?.stale ? "bg-destructive text-destructive-foreground" : mine ? "bg-primary text-primary-foreground" : "bevel-thin bg-secondary",
            )}
          >
            {initials(person ?? "?")}
          </span>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" title={holderName(h)}>
            {holderName(h)}
          </span>
        </p>
      )}

      <footer className="flex items-center gap-2 pt-0.5 text-[11.5px] text-muted-foreground">
        <span className={cn("flex items-center gap-1 font-mono font-bold", done ? "text-faint line-through" : "text-accent-ink")}>
          <PixelIcon name={done ? "boxcheck" : "document"} />#{task.number}
        </span>
        {steps.total > 0 && <StepMeter done={steps.done} total={steps.total} />}
        {subs.total > 0 && (
          <span className="font-mono tabular-nums" title={`${subs.done} of ${subs.total} Subtasks done`}>
            {subs.done}/{subs.total} sub
          </span>
        )}
        {task.pr !== undefined && !done && (
          <span className="flex items-center gap-0.5 font-mono" title={`Pull request #${task.pr}`}>
            <PixelIcon name="commit" />PR {task.pr}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {waiting && <PixelIcon name="hourglass" aria-label="Waiting for the Channel" />}
          {task.claim?.stale && <TakeoverAction task={task} compact />}
          {moveMenu}
        </span>
      </footer>
    </article>
  );
}

/** Steps as a row of one-bit cells, filled for each one done. */
function StepMeter({ done, total }: { done: number; total: number }) {
  const cells = Math.min(total, 8);
  const filled = Math.round((done / total) * cells);
  return (
    <span className="flex items-center gap-1" title={`${done} of ${total} Steps done`}>
      <span aria-hidden className="bevel-thin-in flex gap-px bg-card p-px">
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className={cn("h-1.5 w-1", i < filled ? "bg-accent-ink" : "bg-transparent")} />
        ))}
      </span>
      <span className="font-mono tabular-nums">
        {done}/{total}
      </span>
      <span className="sr-only">Steps done</span>
    </span>
  );
}
