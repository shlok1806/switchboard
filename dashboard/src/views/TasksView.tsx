import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, Task } from "@shared/index";
import { useCapabilities, useChannel, useIndex, useMe } from "@/data/store";
import { ClaimForAgentItems, ClaimForLabel, ClaimForMeItem, claimable, useClaims } from "@/components/domain/claim";
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
import { AlertTriangle, Ban, Bot, Ellipsis, GitPullRequest, Info, ListTree, Loader2, MoveRight, UserRound, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/components/shell/nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { holderName } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";

/* Left to right the way work flows. Stale Claims are a lane above the board. */
const FLOW: Column[] = ["open", "claimed", "review", "done"];

const HINT: Record<Column, string> = {
  stale: "The holder is Gone. Held until a Person takes it over.",
  open: "No Claim yet. Drag a card to Claimed to claim it.",
  claimed: "Held by an Agent or a Person. Drag your own back to Open to release it.",
  review: "Finished, pull request open.",
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
  const me = useMe();
  const claims = useClaims();
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
    // A drag claims for the Person; the card's menu can claim for one of their Agents.
    await waitFor(task.number, to, () => (decision.kind === "claim" ? claims.claim(task) : claims.release(task)));
  };

  /** The card waits in `to` until the Channel answers. */
  const waitFor = async (number: number, to: Column, work: () => Promise<boolean>) => {
    setPending((p) => new Map(p).set(number, to));
    await work();
    setPending((p) => {
      const next = new Map(p);
      next.delete(number);
      return next;
    });
  };

  const claimFor = (task: Task, agent?: AgentId) => waitFor(task.number, "claimed", () => claims.claim(task, agent));

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Pending title="No Tasks yet">Open GitHub Issues show up here.</Pending>
        <NewTaskButton />
      </div>
    );
  }

  const set = <K extends keyof Filters>(k: K) => (v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const active = Object.values(filters).filter(Boolean).length;
  const card = (c: Card) => (
    <KanbanCard key={c.id} {...c} onOpen={() => go({ view: "task", number: c.task.number })} className={cn("group", pending.has(c.task.number) && "opacity-70")}>
      <TaskCard
        task={c.task}
        agentById={agentById}
        taskByNumber={taskByNumber}
        me={me}
        waiting={pending.has(c.task.number)}
        menu={
          !can.claims ? null : mobile ? (
            <MoveMenu
              column={c.column}
              onPick={(to) => move({ item: c, from: c.column, to })}
              options={columns}
              claimFor={c.column === "open" && claimable(c.task) ? claims.mine : []}
              onClaimFor={(agent) => void claimFor(c.task, agent)}
            />
          ) : c.column === "open" && claimable(c.task) && !pending.has(c.task.number) ? (
            <ClaimMenu me={me} agents={claims.mine} onPick={(agent) => void claimFor(c.task, agent)} />
          ) : null
        }
      />
    </KanbanCard>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Quick filters, as on a Jira board */}
      <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5 sm:px-6 md:flex-nowrap md:gap-2 md:overflow-x-auto">
        <Toggle on={filters.mine} onClick={() => set("mine")(!filters.mine)} label="Mine">
          <UserRound className="size-3.5" aria-hidden />
        </Toggle>
        <Toggle on={filters.blocked} onClick={() => set("blocked")(!filters.blocked)} label="Blocked">
          <Ban className="size-3.5" aria-hidden />
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
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] text-ink-3 hover:bg-hover hover:text-ink"
            onClick={() => setFilters(NO_FILTERS)}
          >
            <X className="size-3.5" aria-hidden /> Clear
          </button>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[13px] whitespace-nowrap text-ink-3 tabular-nums max-md:hidden">
          {shown.length === tasks.length ? tasks.length : `${shown.length} / ${tasks.length}`}
        </span>
        <span className="shrink-0 max-md:ml-auto">
          <NewTaskButton />
        </span>
      </div>
      {!can.claims && (
        <p className="border-b border-line px-4 py-2 text-[13px] text-ink-3 sm:px-6">
          Claims arrive with <IssueLink capability="claims" />.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-hidden px-3 pt-3 sm:px-6 sm:pt-4">
        <KanbanProvider<Card>
          columns={columns.map((c) => ({ id: c, name: COLUMN_LABEL[c] }))}
          data={cards}
          onMove={move}
          pointerDrag={!mobile}
          className={cn(
            "min-h-0",
            // A phone shows one column at a time and scrolls sideways between them.
            mobile ? "snap-x snap-mandatory auto-cols-[calc(100%-40px)] overflow-x-auto pb-3" : "auto-cols-[minmax(220px,1fr)] pb-4",
          )}
          lane={
            can.claims && stale.length > 0 ? (
              <StaleLane count={stale.length}>
                <KanbanCards<Card> id="stale" className="flex-row flex-nowrap overflow-x-auto">
                  {(c) => (
                    <div key={c.id} className="w-[min(300px,78vw)] shrink-0">
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
              <KanbanHeader className="flex items-center gap-2">
                <ColumnDot column={column.id as Column} />
                <h2 className="text-[13px] font-medium text-ink">{column.name}</h2>
                <span className="text-[13px] text-ink-3 tabular-nums">{count(column.id as Column)}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label={`About ${column.name}`} className="ml-auto grid size-6 place-items-center rounded text-ink-4 hover:text-ink-2">
                      <Info className="size-3.5" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{HINT[column.id as Column]}</TooltipContent>
                </Tooltip>
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

const COLUMN_DOT: Record<Column, string> = {
  stale: "bg-red",
  open: "border border-ink-4",
  claimed: "bg-accent",
  review: "bg-orange",
  done: "bg-green",
};

function ColumnDot({ column }: { column: Column }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", COLUMN_DOT[column])} />;
}

/** A quick filter. On a phone only its icon shows; the name stays for screen readers and on hover. */
function Toggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={label}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors max-md:h-7 max-md:px-2.5",
        on ? "border-transparent bg-accent-tint text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong",
      )}
    >
      {children}
      <span className="max-md:sr-only">{label}</span>
    </button>
  );
}

function StaleLane({ count, children }: { count: number; children: ReactNode }) {
  return (
    <section aria-label="Stale Claims" className="mb-3 flex flex-col rounded-xl bg-red-tint p-2">
      <header className="flex items-center gap-2 px-1.5 pt-0.5 pb-2 text-[13px] font-medium text-red">
        <AlertTriangle className="size-4" aria-hidden />
        Stale Claim
        <span className="tabular-nums opacity-80">{count}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="About Stale Claims" className="grid size-6 place-items-center rounded opacity-70 hover:opacity-100">
              <Info className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>{HINT.stale}</TooltipContent>
        </Tooltip>
      </header>
      {children}
    </section>
  );
}

function Empty({ column, filtered }: { column: Column; filtered: boolean }) {
  return <p className="px-2 py-8 text-center text-[13px] text-ink-3">{filtered ? "No match" : column === "stale" ? "None" : "Empty"}</p>;
}

/** The "Move to" menu that replaces dragging on a phone. An Open card can also be claimed for one of your Agents. */
function MoveMenu({
  column,
  options,
  onPick,
  claimFor,
  onClaimFor,
}: {
  column: Column;
  options: Column[];
  onPick: (c: Column) => void;
  claimFor: Agent[];
  onClaimFor: (agent: AgentId) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Move to"
          className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-hover"
          onClick={(e) => e.stopPropagation()}
        >
          <MoveRight className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)] min-w-[180px]">
        <DropdownMenuLabel className="text-[12px] font-normal text-ink-3">Move to</DropdownMenuLabel>
        {options
          .filter((c) => c !== column)
          .map((c) => (
            <DropdownMenuItem key={c} onSelect={() => onPick(c)}>
              <ColumnDot column={c} />
              {COLUMN_LABEL[c]}
            </DropdownMenuItem>
          ))}
        {claimFor.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-line" />
            <ClaimForLabel />
            <ClaimForAgentItems agents={claimFor} onPick={onClaimFor} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An Open card's menu on a desktop: claim for yourself or one of your own Agents. A drag claims for yourself. */
function ClaimMenu({ me, agents, onPick }: { me: string; agents: Agent[]; onPick: (agent?: AgentId) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Claim for"
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 data-[state=open]:bg-hover data-[state=open]:opacity-100"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]" onClick={(e) => e.stopPropagation()}>
        <ClaimForLabel />
        <ClaimForMeItem me={me} onPick={() => onPick()} />
        <ClaimForAgentItems agents={agents} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskCard({
  task,
  agentById,
  taskByNumber,
  me,
  waiting,
  menu,
}: {
  task: Task;
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  me: string;
  waiting: boolean;
  menu: ReactNode;
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
    <article className="flex flex-col gap-2.5 text-[13.5px] leading-snug">
      <p className={cn("line-clamp-3 break-words", done ? "text-ink-3" : "text-ink")}>{task.title}</p>

      {(labels.length > 0 || blockers.length > 0 || blockedAfterClaim.length > 0) && (
        <ul className="flex flex-wrap gap-1" aria-label="Labels and flags">
          {blockers.length > 0 && (
            <li>
              <Flag tone="red" hint={`Blocked by ${blockers.map((n) => `#${n}`).join(", ")}`}>
                <Ban className="size-3" aria-hidden />
                {blockers.map((n) => `#${n}`).join(" ")}
              </Flag>
            </li>
          )}
          {blockedAfterClaim.length > 0 && (
            <li>
              <Flag tone="orange" hint={`Claimed, then blocked by ${blockedAfterClaim.map((n) => `#${n}`).join(", ")}. The Claim stays held.`}>
                <Ban className="size-3" aria-hidden />
                {blockedAfterClaim.map((n) => `#${n}`).join(" ")}
              </Flag>
            </li>
          )}
          {labels.map((l) => (
            <li key={l} className="rounded-full bg-hover px-2 py-px text-[11.5px] text-ink-3">
              {l}
            </li>
          ))}
        </ul>
      )}

      <footer className="flex min-h-6 items-center gap-2.5 text-[12px] text-ink-3">
        <span className={cn("font-mono tabular-nums", done && "line-through")}>#{task.number}</span>
        {steps.total > 0 && <StepMeter done={steps.done} total={steps.total} />}
        {subs.total > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <ListTree className="size-3.5" aria-hidden />
                {subs.done}/{subs.total}
                <span className="sr-only">Subtasks done</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{`${subs.done} of ${subs.total} Subtasks done`}</TooltipContent>
          </Tooltip>
        )}
        {task.pr !== undefined && !done && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <GitPullRequest className="size-3.5" aria-hidden />
                {task.pr}
              </span>
            </TooltipTrigger>
            <TooltipContent>{`Pull request #${task.pr}`}</TooltipContent>
          </Tooltip>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {waiting && <Loader2 className="size-3.5 animate-spin" aria-label="Waiting for the Channel" />}
          {task.claim?.stale && <TakeoverAction task={task} compact />}
          {h && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "relative grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
                    task.claim?.stale ? "bg-red-tint text-red" : mine ? "bg-accent-tint text-accent-ink" : "bg-hover-2 text-ink-2",
                  )}
                  aria-label={`Held by ${holderName(h)}`}
                  role="img"
                >
                  {initials(person ?? "?")}
                  {h.kind === "agent" && (
                    <span className="absolute -right-0.5 -bottom-0.5 grid size-3 place-items-center rounded-full bg-surface ring-1 ring-line">
                      <Bot className="size-2" strokeWidth={2.2} />
                    </span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent className="font-mono">{holderName(h)}</TooltipContent>
            </Tooltip>
          )}
          {menu}
        </span>
      </footer>
    </article>
  );
}

function Flag({ tone, hint, children }: { tone: "red" | "orange"; hint: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-px font-mono text-[11.5px]",
            tone === "red" ? "bg-red-tint text-red" : "bg-orange-tint text-orange",
          )}
        >
          {children}
          <span className="sr-only">{hint}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Steps as a thin bar with a count. */
function StepMeter({ done, total }: { done: number; total: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-hover-2">
            <span className={cn("block h-full rounded-full", done === total ? "bg-green" : "bg-accent")} style={{ width: `${(done / total) * 100}%` }} />
          </span>
          {done}/{total}
          <span className="sr-only">Steps done</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{`${done} of ${total} Steps done`}</TooltipContent>
    </Tooltip>
  );
}
