/*
 * The Tasks board (design.md's board): Open, Claimed, In review and Done, left to right the
 * way work flows. A Stale Claim needs a Person, so it heads the Claimed column in a group of
 * its own instead of a lane of its own. A card is the Task's title, number and labels, who
 * holds it and how far its Steps are; a click fills the inspector at the right, and Open goes
 * to the Task's page. Dragging a card claims or releases it. Below 640px the columns scroll
 * sideways one at a time, a card's menu moves it, and the inspector opens as a sheet.
 */
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, Task } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { ClaimAction, ClaimForAgentItems, ClaimForLabel, ClaimForMeItem, claimable, useClaims } from "@/components/domain/claim";
import { FilterSelect } from "@/components/domain/filters";
import { decideMove, taskGlyph } from "@/components/domain/moves";
import { NewTaskButton } from "@/components/domain/new-task";
import { IssueLink, Pending } from "@/components/domain/pending";
import { Glyph, State } from "@/components/domain/state";
import { TakeoverAction } from "@/components/domain/takeover";
import { COLUMN_GLYPH, COLUMN_LABEL, HolderLabel, columnOf, holderPerson, openBlockers, shownLabels, type Column } from "@/components/domain/task";
import { KanbanBoard, KanbanCard, KanbanCards, KanbanHeader, KanbanProvider, type KanbanMove } from "@/components/kibo-ui/kanban";
import { InspectorFrame, SheetClose } from "@/components/shell/inspector";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCapabilities, useChannel, useIndex, useMe } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { EVENT_TYPE_LABEL, actorName, ago, summarize } from "@/lib/format";
import { href } from "@/lib/router";
import { heldByMe } from "@/lib/state";
import { cn } from "@/lib/utils";

/* Left to right the way work flows. Stale Claims head the Claimed column. */
const FLOW: Column[] = ["open", "claimed", "review", "done"];

type Card = { id: string; name: string; column: Column; task: Task };

type Show = "all" | "mine" | "stale" | "blocked";

export function TasksView() {
  const { tasks, agents, snapshot } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const me = useMe();
  const claims = useClaims();
  const can = useCapabilities();
  const mobile = useIsMobile();
  const [show, setShow] = useState<Show>("all");
  const [person, setPerson] = useState("");
  const [agent, setAgent] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  // On a phone the picked Task opens as a sheet, and only when a card is tapped.
  const [sheet, setSheet] = useState<number | null>(null);
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

  const blocked = (t: Task) => openBlockers(t, taskByNumber).length > 0 || (t.claim?.blockedBy?.length ?? 0) > 0;
  const mine = (t: Task) => (t.claim ? heldByMe(t.claim.holder, me, agentById) : false);
  const shown = useMemo(
    () =>
      tasks.filter((t) => {
        if (show === "mine" && !mine(t)) return false;
        if (show === "stale" && !t.claim?.stale) return false;
        if (show === "blocked" && !blocked(t)) return false;
        if (person && holderPerson(t, agentById) !== person) return false;
        if (agent && !(t.claim?.holder.kind === "agent" && t.claim.holder.agentId === agent)) return false;
        return true;
      }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `mine` and `blocked` read only what is listed.
    [tasks, show, person, agent, me, agentById, taskByNumber],
  );

  const cards: Card[] = useMemo(
    () =>
      [...shown]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((t) => ({ id: String(t.number), name: `#${t.number} ${t.title}`, column: pending.get(t.number) ?? columnOf(t), task: t })),
    [shown, pending],
  );

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
  const claimFor = (task: Task, forAgent?: AgentId) => waitFor(task.number, "claimed", () => claims.claim(task, forAgent));

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Pending title="No Tasks yet">Open GitHub Issues show up here.</Pending>
        <NewTaskButton />
      </div>
    );
  }

  const count = (c: Column) => tasks.filter((t) => columnOf(t) === c).length;
  const inColumn = (c: Column) => cards.filter((x) => x.column === c).length;
  const filtered = show !== "all" || person !== "" || agent !== "";
  const chips: { id: Show; label: string; n: number }[] = [
    { id: "all", label: "All", n: tasks.length },
    { id: "mine", label: "Mine", n: tasks.filter(mine).length },
    { id: "stale", label: "Stale", n: count("stale") },
    { id: "blocked", label: "Blocked", n: tasks.filter(blocked).length },
  ];
  // The Task in the inspector: the one picked, else the first that needs a Person, else the newest at work.
  const first = cards.find((c) => c.column === "stale") ?? cards.find((c) => c.column === "claimed") ?? cards[0];
  const selected = (picked !== null && taskByNumber.get(picked)) || first?.task;
  const sheetTask = sheet !== null ? taskByNumber.get(sheet) : undefined;

  const card = (c: Card) => {
    const waiting = pending.has(c.task.number);
    return (
      <KanbanCard
        key={c.id}
        {...c}
        onOpen={() => (mobile ? setSheet(c.task.number) : setPicked(c.task.number))}
        className={cn(
          "rounded-[var(--r)] border border-rule-2 bg-paper p-3 hover:bg-paper-2",
          c.column === "stale" && "border-signal outline outline-1 -outline-offset-2 outline-signal",
          !mobile && c.task === selected && "border-ink outline outline-1 -outline-offset-2 outline-ink",
          waiting && "opacity-70",
        )}
      >
        <TaskCard
          task={c.task}
          waiting={waiting}
          menu={
            !can.claims ? null : mobile ? (
              <MoveMenu
                column={c.column}
                options={columns}
                onPick={(to) => void move({ item: c, from: c.column, to })}
                claimFor={c.column === "open" && claimable(c.task) ? claims.mine : []}
                onClaimFor={(id) => void claimFor(c.task, id)}
              />
            ) : c.column === "open" && claimable(c.task) && !waiting ? (
              <ClaimMenu me={me} agents={claims.mine} onPick={(id) => void claimFor(c.task, id)} />
            ) : null
          }
        />
      </KanbanCard>
    );
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-5 px-[var(--gutter)] pt-5">
        <PageHead
          title="Tasks"
          facts={[
            `${count("open")} open`,
            `${count("claimed") + count("stale")} claimed`,
            count("stale") > 0 && `${count("stale")} stale`,
            `${count("review")} in review`,
            `${count("done")} done`,
          ]}
          actions={<NewTaskButton />}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <Chip key={c.id} on={show === c.id} onClick={() => setShow(c.id)} count={c.n}>
                {c.label}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterSelect label="Person" value={person} onChange={setPerson} allLabel="Any Person" options={persons.map((p) => ({ value: p, label: p }))} />
            {can.agents && (
              <FilterSelect label="Agent" value={agent} onChange={setAgent} allLabel="Any Agent" options={agents.map((a) => ({ value: a.id, label: a.id }))} />
            )}
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShow("all");
                  setPerson("");
                  setAgent("");
                }}
              >
                Clear
              </Button>
            )}
          </div>
          <span className="ml-auto text-small text-ink-3 tabular-nums max-sm:hidden">
            {shown.length === tasks.length ? `${tasks.length} Tasks` : `${shown.length} of ${tasks.length} Tasks`}
          </span>
        </div>
        {!can.claims && (
          <p className="text-small text-ink-3">
            Claims arrive with <IssueLink capability="claims" />.
          </p>
        )}

        <div className="min-h-0 flex-1">
          <KanbanProvider<Card>
            columns={columns.map((c) => ({ id: c, name: COLUMN_LABEL[c] }))}
            data={cards}
            onMove={move}
            pointerDrag={!mobile}
            className={cn(
              "min-h-0 gap-4",
              // A phone shows one column at a time and scrolls sideways between them; a tablet too narrow for four columns scrolls as well.
              mobile ? "snap-x snap-mandatory auto-cols-[calc(100%-40px)] overflow-x-auto" : "auto-cols-[minmax(220px,1fr)] overflow-x-auto",
            )}
          >
            {(column) => {
              const id = column.id as Column;
              const stale = id === "claimed" ? inColumn("stale") : 0;
              return (
                <KanbanBoard key={id} id={id} className="min-h-0 snap-start rounded-none bg-transparent">
                  <KanbanHeader className="flex items-center gap-2 border-b border-rule-2 px-0 pt-0 pb-2">
                    <Glyph state={COLUMN_GLYPH[id]} />
                    <h2 className="text-title font-semibold text-ink">{column.name}</h2>
                    <span className="text-small text-ink-3 tabular-nums">{inColumn(id) + stale}</span>
                  </KanbanHeader>
                  {stale > 0 && (
                    <section aria-label="Stale Claims" className="shrink-0 border-b border-rule pb-3">
                      <p className="pt-3 pb-2 text-small text-ink-3">
                        <State state="stale" word={`${stale} Stale ${stale === 1 ? "Claim" : "Claims"}`} className="text-small" />, held by a Gone Agent. Anyone may take it over.
                      </p>
                      <KanbanCards<Card> id="stale" className="min-h-0 px-0 pb-0">
                        {card}
                      </KanbanCards>
                    </section>
                  )}
                  <KanbanCards<Card> id={id} className="px-0 pt-3 pb-6" empty={<p className="py-6 text-small text-ink-3">{filtered ? "Nothing matches." : "Nothing here."}</p>}>
                    {card}
                  </KanbanCards>
                </KanbanBoard>
              );
            }}
          </KanbanProvider>
        </div>
      </div>
      {!mobile && selected && <TaskInspector key={selected.number} task={selected} />}
      {mobile && sheetTask && <TaskInspector key={sheetTask.number} task={sheetTask} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** A card: the title, its number and labels, a blocker, who holds it, its Steps and its PR. */
function TaskCard({ task, waiting, menu }: { task: Task; waiting: boolean; menu: ReactNode }) {
  const { taskByNumber } = useIndex();
  const blockers = openBlockers(task, taskByNumber);
  // Claimed, and blocked only after the Claim was taken (#11): the Claim stays held.
  const blockedAfter = task.claim?.blockedBy?.filter((n) => !blockers.includes(n)) ?? [];
  const blockedBy = [...blockers, ...blockedAfter];
  const done = task.status === "done";
  const meta = [`#${task.number}`, ...shownLabels(task)];
  const subs = task.subtasks.length;
  return (
    <article className="flex flex-col gap-1.5">
      <p className={cn("text-row font-semibold [overflow-wrap:anywhere]", done ? "text-ink-2" : "text-ink")}>{task.title}</p>
      <p className="text-small text-ink-3">
        <span className="tabular-nums">{meta.join(" · ")}</span>
        {subs > 0 && ` · ${task.subtasksDone} of ${subs} Subtasks`}
      </p>
      {blockedBy.length > 0 && <p className="text-small font-medium text-ink">Blocked by {blockedBy.map((n) => `#${n}`).join(", ")}</p>}
      {(task.claim || task.steps.length > 0 || task.pr !== undefined || menu) && (
        <footer className="mt-1 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-ink-2">
          {task.claim && <HolderLabel holder={task.claim.holder} link={false} className="min-w-0" />}
          <span className="ml-auto flex items-center gap-3">
            {task.steps.length > 0 && <StepMeter done={task.stepsDone} total={task.steps.length} />}
            {task.pr !== undefined && !done && <span className="tabular-nums">PR #{task.pr}</span>}
            {waiting && <span className="text-ink-3">Moving</span>}
            {menu}
          </span>
          {task.claim?.stale && <TakeoverAction task={task} compact />}
        </footer>
      )}
    </article>
  );
}

/** Steps as design.md's meter, short enough for a card, with its count. */
function StepMeter({ done, total }: { done: number; total: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" title={`${done} of ${total} Steps done`}>
      <span aria-hidden className="h-1 w-8 bg-rule">
        <span className="block h-full bg-ink-2" style={{ width: `${(done / total) * 100}%` }} />
      </span>
      {done}/{total}
      <span className="sr-only">Steps done</span>
    </span>
  );
}

/** The selected Task, read without leaving the board: where it stands, its Steps, its branch and its last work. */
function TaskInspector({ task, onClose }: { task: Task; onClose?: () => void }) {
  const { events } = useChannel();
  const { agentById } = useIndex();
  const me = useMe();
  const can = useCapabilities();
  // Claim leads when the Task is free to claim; otherwise Open does.
  const claimHere = can.claims && claimable(task);
  const column = columnOf(task);
  const work = useMemo(() => events.filter((e) => e.task === task.number).reverse(), [events, task.number]);
  const update = work.find((e) => e.type === "update");
  const firstOpen = task.steps.findIndex((s) => !s.done);
  const halted = task.claim?.stale === true || (task.claim?.blockedBy?.length ?? 0) > 0;
  const fact = [
    task.claim
      ? `${task.claim.stale ? "Stale: its holder is Gone" : "Claimed"} ${ago(task.claim.claimedAt)}.`
      : task.status === "done"
        ? "Done."
        : "Nobody has claimed it yet.",
    task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length} Steps done.`,
    task.pr !== undefined && `PR #${task.pr}${task.status === "review" ? " in review" : ""}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <InspectorFrame label={`#${task.number} ${task.title}, in the inspector`} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-title font-semibold [overflow-wrap:anywhere] text-ink">
            #{task.number} {task.title}
          </h2>
          <SheetClose onClose={onClose} />
        </div>
        <State state={taskGlyph(task, me, agentById)} word={COLUMN_LABEL[column]} className="text-small" />
        {task.claim && (
          <p className="text-row text-ink-2">
            Held by <HolderLabel holder={task.claim.holder} />
          </p>
        )}
        <p className="text-row text-ink-2">{fact}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {task.claim?.stale ? (
            <>
              <TakeoverAction task={task} size="md" compact />
              <a href={href({ view: "task", number: task.number })} className={buttonVariants({ variant: "secondary" })}>
                Open
              </a>
            </>
          ) : (
            <>
              <a href={href({ view: "task", number: task.number })} className={buttonVariants({ variant: claimHere ? "secondary" : "primary" })}>
                Open
              </a>
              {claimHere && (
                <span className="w-28">
                  <ClaimAction task={task} />
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <Section title="Steps" meta={task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length}`} as="h3" bodyClassName="pt-0">
        {task.steps.length > 0 ? (
          <ol>
            {task.steps.map((s, i) => {
              const next = !halted && i === firstOpen;
              return (
                <li key={s.index} className={cn("flex items-baseline gap-2.5 border-b border-rule py-2 text-row", s.done || next ? "text-ink" : "text-ink-3")}>
                  <Glyph state={s.done ? "done" : next ? "running" : "idle"} className="relative top-px" />
                  <span className="sr-only">{s.done ? "Done:" : next ? "In progress:" : "To do:"}</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="pt-3 text-small text-ink-3">No Steps on this Task.</p>
        )}
      </Section>
      {update && (
        <Section title="Last Update" meta={ago(update.at)} as="h3">
          <p className="text-row text-ink [overflow-wrap:anywhere]">{summarize(update)}</p>
          <p className="mt-1 text-small text-ink-3">{actorName(update.actor)}</p>
        </Section>
      )}
      {task.branch && (
        <Section title="Branch" as="h3">
          <code className="block rounded-[var(--r)] bg-paper-2 px-2.5 py-1.5 text-small [overflow-wrap:anywhere] text-ink">git switch {task.branch}</code>
        </Section>
      )}
      <Section
        title="Timeline"
        meta={work.length > 5 && "the last five"}
        action={
          <a href={href({ view: "task", number: task.number })} className="text-ink hover:underline">
            All of it
          </a>
        }
        as="h3"
        bodyClassName="pt-0"
      >
        {work.length === 0 ? (
          <p className="pt-3 text-small text-ink-3">Nothing on the Channel about it yet.</p>
        ) : (
          <ol>
            {work.slice(0, 5).map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 border-b border-rule py-2">
                <span className="flex items-baseline justify-between gap-3 text-small">
                  <span className="min-w-0 [overflow-wrap:anywhere] text-ink-3">
                    <span className="font-semibold text-ink">{EVENT_TYPE_LABEL[e.type]}</span> · {actorName(e.actor)}
                  </span>
                  <time dateTime={e.at} className="shrink-0 text-ink-3 tabular-nums">
                    {ago(e.at)}
                  </time>
                </span>
                <span className="text-row text-ink-2 [overflow-wrap:anywhere]">{summarize(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </InspectorFrame>
  );
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
        <Button variant="secondary" size="sm" onClick={(e) => e.stopPropagation()}>
          Move
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)] min-w-[180px]">
        <DropdownMenuLabel className="text-small font-normal text-ink-3">Move to</DropdownMenuLabel>
        {options
          .filter((c) => c !== column)
          .map((c) => (
            <DropdownMenuItem key={c} onSelect={() => onPick(c)}>
              <Glyph state={COLUMN_GLYPH[c]} />
              {COLUMN_LABEL[c]}
            </DropdownMenuItem>
          ))}
        {claimFor.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-rule" />
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
        <Button variant="secondary" size="sm" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          Claim
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]" onClick={(e) => e.stopPropagation()}>
        <ClaimForLabel />
        <ClaimForMeItem me={me} onPick={() => onPick()} />
        <ClaimForAgentItems agents={agents} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
