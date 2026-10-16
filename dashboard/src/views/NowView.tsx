/*
 * The Now view (design.md's Main board), the Dashboard's first screen: what needs a Person
 * right now, then the last few things said on the Channel, the fleet at a glance, and the
 * latest shared notes. On a desk the queue and the log take the wide column and the fleet
 * and memory the narrow one; below 640px they stack in that order.
 */
import { useMemo, useState } from "react";
import type { Agent, ChannelEvent, EventType, Person, Task } from "@shared/index";
import { noteFromEvent } from "@shared/index";
import { buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { PendingApproval } from "@/components/domain/approval";
import { FirstAgentAction } from "@/components/domain/start-agent";
import { GroupLine, Secondary, StackedRow, contextPercent, groupByPerson, shortName, since, useLines, type Line } from "@/components/domain/fleet";
import { RowFrame } from "@/components/domain/log";
import { State } from "@/components/domain/state";
import { TakeoverAction } from "@/components/domain/takeover";
import { useNow } from "@/components/domain/usage";
import { PageHead } from "@/components/shell/page-head";
import { SectionHead } from "@/components/shell/section";
import { EmptyView } from "@/components/shell/states";
import { useChannel, useIndex, useMe } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { TAG_LABEL, actorName, elapsed, holderName, localTime, summarize, zoneCity } from "@/lib/format";
import { isMine, needsQueue, type QueueItem } from "@/lib/queue";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";

/** What the log leaves out: the machine's own bookkeeping, which Activity still shows. */
const QUIET: ReadonlySet<EventType> = new Set<EventType>([
  "presence",
  "tool.call",
  "turn.end",
  "proxy.raw",
  "transcript.read",
  "terminal.read",
  "verdict",
  "directive.delivery",
  "wake",
  "approval.closed",
  "session.start",
  "session.end",
  "agent.model",
  "terminal.attached",
]);


export function NowView() {
  const { agents, tasks, events, snapshot } = useChannel();
  const me = useMe();
  const lines = useLines();
  const now = useNow(15_000);
  const [mineOnly, setMineOnly] = useState(false);

  const queue = useMemo(() => needsQueue(agents, tasks, me, events), [agents, tasks, me, events]);
  const zones = new Map((snapshot?.persons ?? []).map((p: Person) => [p.name, p.timeZone]));
  const myZone = zones.get(me) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Every count here is read off the queue, as the Now key's is (needsYouCount).
  const needYou = queue.filter(isMine).length;
  const others = new Map<string, number>();
  for (const i of queue) if (i.kind === "ask" && !i.mine) others.set(i.agent.person, (others.get(i.agent.person) ?? 0) + 1);
  const title = [
    needYou > 0 ? `${needYou} ${needYou === 1 ? "line needs" : "lines need"} you` : "Nothing needs you",
    ...[...others].map(([p, k]) => `${k} ${k === 1 ? "needs" : "need"} ${p}`),
  ].join(", ");
  const today = new Date(now).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: myZone });

  const count = (p: Agent["presence"]) => agents.filter((a) => a.presence === p).length;
  const open = tasks.filter((t) => t.status !== "done").length;
  const shown = mineOnly ? queue.filter(isMine) : queue;

  // A Channel nobody has used yet: no Agent, no Task and nothing said.
  if (snapshot && agents.length === 0 && tasks.length === 0 && events.length === 0) {
    return (
      <EmptyView view="Now" title="Nothing on this Channel yet" action={<FirstAgentAction />}>
        Now fills in as Agents join, take Tasks and ask for you. Start with one Agent; the Channel's Tasks come from its repository's open Issues.
      </EmptyView>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-7 px-[var(--gutter)] pt-5 pb-10">
        <PageHead
          title={`${title}.`}
          facts={[
            `${agents.length} ${agents.length === 1 ? "Agent" : "Agents"}`,
            `${count("live")} live`,
            `${count("idle")} idle`,
            `${count("gone")} gone`,
            `${open} open ${open === 1 ? "Task" : "Tasks"}`,
            `${today}, ${localTime(now, myZone)} in ${zoneCity(myZone)}`,
          ]}
        />
        <div className="flex flex-wrap items-start gap-x-10 gap-y-7">
          <div className="flex min-w-0 flex-[7_1_520px] flex-col gap-7">
            <section aria-label="Needs a Person" className="flex min-w-0 flex-col">
              <SectionHead
                title="Needs a Person"
                meta={
                  <>
                    {needYou} for you
                    {[...others].map(([p, k]) => (
                      <span key={p} className="max-sm:hidden"> · {k} for {p}</span>
                    ))}
                  </>
                }
                action={
                  <span role="group" aria-label="Show" className="flex gap-1">
                    <Chip on={mineOnly} onClick={() => setMineOnly(true)}>
                      Mine
                    </Chip>
                    <Chip on={!mineOnly} onClick={() => setMineOnly(false)}>
                      Everyone
                    </Chip>
                  </span>
                }
              />
              {shown.length === 0 ? (
                <p className="border-b border-rule py-4 text-row text-ink-3">{mineOnly ? "Nothing waits on you." : "Nothing waits on a Person."}</p>
              ) : (
                <ol>
                  {shown.map((item) => (
                    <li
                      key={`${item.kind}-${item.kind === "ask" ? item.agent.id : item.task.number}`}
                      // On a phone each action takes its share of the width at a 44px target.
                      className="border-b border-rule py-4 max-sm:[&_[data-acts]>*]:min-h-11 max-sm:[&_[data-acts]>*]:flex-1"
                    >
                      <QueueLine item={item} now={now} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <Log events={events} now={now} />
          </div>
          <div className="flex min-w-0 flex-[5_1_400px] flex-col gap-7">
            <Fleet lines={lines} me={me} zones={zones} />
            <Memory events={events} now={now} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One line of the queue. An Ask is the shared Ask; a Stale Claim and a review are drawn here. */
function QueueLine({ item, now }: { item: QueueItem; now: number }) {
  if (item.kind === "ask") return <PendingApproval agent={item.agent} word />;
  return item.kind === "stale" ? <StaleLine task={item.task} at={item.at} now={now} /> : <ReviewLine task={item.task} yours={item.yours} at={item.at} now={now} />;
}

function Entry({
  state,
  word,
  title,
  at,
  now,
  children,
  meta,
  actions,
}: {
  state: "stale" | "review" | "review-other";
  word?: string;
  title: React.ReactNode;
  at: string;
  now: number;
  children?: React.ReactNode;
  meta: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-4">
        <h3 className="min-w-0 flex-1 text-row font-semibold [overflow-wrap:anywhere] text-ink">
          <State state={state} word={word} className="mr-2 align-[-1px]" />
          {title}
        </h3>
        <span className="shrink-0 text-small text-ink-3 tabular-nums">{elapsed(at, now)}</span>
      </div>
      {children && <p className="max-w-[72ch] text-row break-words text-ink">{children}</p>}
      <p className="text-small text-ink-3">{meta}</p>
      <div data-acts className="flex flex-wrap items-center gap-2 pt-1">
        {actions}
      </div>
    </article>
  );
}

function lastUpdate(task: Task, events: ChannelEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "update" && e.task === task.number) return e.payload.text;
  }
  return undefined;
}

function StaleLine({ task, at, now }: { task: Task; at: string; now: number }) {
  const { events } = useChannel();
  const { agentById } = useIndex();
  const holder = task.claim!.holder;
  const agent = holder.kind === "agent" ? agentById.get(holder.agentId) : undefined;
  const who = agent ? `${agent.person}'s ${shortName(agent)}` : holderName(holder);
  const update = lastUpdate(task, events);
  const person = agent?.person ?? (holder.kind === "person" ? holder.person : holder.kind === "agent" ? holder.agentId.split("/")[0] : undefined);
  return (
    <Entry
      state="stale"
      title={`#${task.number} ${task.title} lost its Agent`}
      at={at}
      now={now}
      meta={
        <>
          {person ? `${person}'s Claim` : "A Claim"}
          {task.branch && (
            <>
              {" · "}
              <code>{task.branch}</code>
            </>
          )}
        </>
      }
      actions={
        <>
          <TakeoverAction task={task} line />
          <a href={href({ view: "task", number: task.number })} className={buttonVariants({ variant: "secondary" })}>
            Open the Task
          </a>
        </>
      }
    >
      {who} went Gone
      {task.steps.length > 0 ? ` with ${task.stepsDone} of ${task.steps.length} Steps done.` : "."}
      {update && ` Its last Update: "${update}"`}
    </Entry>
  );
}

/** The pull request's page: from its `task.review` Event, else beside the Issue. */
function prUrl(task: Task, events: ChannelEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "task.review" && e.task === task.number) return e.payload.url;
  }
  return task.pr !== undefined && task.url ? task.url.replace(/\/issues\/\d+$/, `/pull/${task.pr}`) : undefined;
}

function ReviewLine({ task, yours, at, now }: { task: Task; yours: boolean; at: string; now: number }) {
  const { events } = useChannel();
  const { agentById } = useIndex();
  const me = useMe();
  const holder = task.claim?.holder;
  const agent = holder?.kind === "agent" ? agentById.get(holder.agentId) : undefined;
  const by = agent ? shortName(agent) : holder ? holderName(holder) : "Its holder";
  const pr = task.pr !== undefined ? `PR #${task.pr}` : "The pull request";
  const url = prUrl(task, events);
  const parent = agent?.parent ? agentById.get(agent.parent) : undefined;
  const whose = agent ? (agent.person === me ? "Your Agent" : `${agent.person}'s Agent`) : undefined;
  return (
    <Entry
      state={yours ? "review" : "review-other"}
      title={yours ? `${pr} is ready for your review` : `${pr} waits for a review`}
      at={at}
      now={now}
      meta={
        <>
          {[whose && (parent ? `${whose}, started by ${shortName(parent)}` : whose)].filter(Boolean).join("")}
          {task.branch && (
            <>
              {whose && " · "}
              <code>{task.branch}</code>
            </>
          )}
        </>
      }
      actions={
        <>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: yours ? "primary" : "secondary" })}>
              {task.pr !== undefined ? `Review PR #${task.pr}` : "Review the PR"}
            </a>
          )}
          <a href={href({ view: "task", number: task.number })} className={buttonVariants({ variant: "ghost" })}>
            Open the Task
          </a>
        </>
      }
    >
      {by} opened {task.pr !== undefined ? `PR #${task.pr}` : "a pull request"} for #{task.number} "{task.title}".
    </Entry>
  );
}

/** The last few things said on the Channel, newest first, each as one sentence. */
function Log({ events, now }: { events: ChannelEvent[]; now: number }) {
  const { agentById } = useIndex();
  const recent: ChannelEvent[] = [];
  for (let i = events.length - 1; i >= 0 && recent.length < 7; i--) if (!QUIET.has(events[i]!.type)) recent.push(events[i]!);
  return (
    <section aria-label="Last on the Channel" className="flex min-w-0 flex-col">
      <SectionHead title="Last on the Channel" action={<a href={href({ view: "feed" })} className="text-ink hover:underline">All activity</a>} />
      {recent.length === 0 ? (
        <p className="py-4 text-row text-ink-3">Nothing said yet.</p>
      ) : (
        <ol>
          {recent.map((e) => {
            const who = e.actor.kind === "agent" ? agentById.get(e.actor.agentId) : undefined;
            const name = who ? shortName(who) : actorName(e.actor);
            const recently = now - Date.parse(e.at) < 60_000;
            return (
              <li key={e.id} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 border-b border-rule py-2 text-row">
                <a
                  href={href({ view: "feed", event: e.id })}
                  aria-label={`${name}, ${recently ? "just now" : `${elapsed(e.at, now)} ago`}: open in Activity`}
                  // A phone's target: the whole height of the row, at least 44px.
                  className="text-small text-ink-3 tabular-nums hover:text-ink max-sm:-my-2 max-sm:min-h-11 max-sm:py-2"
                >
                  <time dateTime={e.at}>{recently ? "now" : elapsed(e.at, now)}</time>
                </a>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="font-semibold text-ink">{name}</span> <Said event={e} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** What the Event says, as the rest of a sentence after its actor: the verb quiet, literal code in mono. */
function Said({ event: e }: { event: ChannelEvent }) {
  const { taskByNumber } = useIndex();
  const k = (t: string) => <span className="text-ink-3">{t}</span>;
  const on = e.task !== undefined ? ` #${e.task}` : "";
  switch (e.type) {
    case "file.edit":
      return (
        <>
          {k("edited")} <code>{e.payload.path}</code>
        </>
      );
    case "command":
      return (
        <>
          {k("ran")} <code>{e.payload.command}</code>
        </>
      );
    case "push":
      return (
        <>
          {k("pushed")} <code>{e.payload.commit.slice(0, 7)}</code> {k("to")} <code>{e.payload.branch}</code>
        </>
      );
    case "step.complete":
      return (
        <>
          {k(`finished Step ${e.payload.step}${on && ` of${on}`},`)} {e.payload.text}
        </>
      );
    case "claim":
      return (
        <>
          {k("claimed")}
          {on} {e.task !== undefined && taskByNumber.get(e.task)?.title}
        </>
      );
    case "claim.stale":
      return (
        <>
          {k("is Stale, held by")} {holderName(e.payload.holder)}
        </>
      );
    case "task.review":
      return (
        <>
          {k("opened")} PR #{e.payload.pr} {on && <>{k("for")}{on}</>}
        </>
      );
    default:
      return (
        <>
          {on && k(`on${on}:`)} <span className="text-ink-2">{summarize(e)}</span>
        </>
      );
  }
}

/** The fleet in brief: every Agent's state, its Task and how full it is, by Person. */
function Fleet({ lines, me, zones }: { lines: Line[]; me: string; zones: Map<string, string> }) {
  const mobile = useIsMobile();
  const hosts = new Set(lines.map((l) => l.agent.host).filter(Boolean)).size;
  const byPerson = groupByPerson(lines, me);
  return (
    <section aria-label="Fleet" className="flex min-w-0 flex-col">
      <SectionHead
        title="Fleet"
        meta={`${lines.length} ${lines.length === 1 ? "Agent" : "Agents"}${hosts ? ` on ${hosts} ${hosts === 1 ? "Host" : "Hosts"}` : ""}`}
        action={<a href={href({ view: "agents" })} className="text-ink hover:underline">All Agents</a>}
      />
      {lines.length === 0 ? (
        <p className="py-4 text-row text-ink-3">No Agents yet.</p>
      ) : mobile ? (
        <ul>
          {byPerson.map(([person, group]) => (
            <li key={person}>
              <GroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
              <ul>
                {group.map((l) => (
                  <StackedRow key={l.agent.id} line={l} model={false} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-rule text-label font-medium text-ink-3">
              <th scope="col" className="w-[7.5rem] py-2 pr-3 pl-3 font-medium">
                State
              </th>
              <th scope="col" className="w-[11rem] py-2 pr-3 font-medium">
                Agent
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Task
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Context
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Since
              </th>
            </tr>
          </thead>
          {byPerson.map(([person, group]) => (
            <tbody key={person}>
              <tr>
                <th scope="rowgroup" colSpan={5} className="p-0 text-left font-normal">
                  <GroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                </th>
              </tr>
              {group.map((l) => (
                <FleetRow key={l.agent.id} line={l} />
              ))}
            </tbody>
          ))}
        </table>
      )}
    </section>
  );
}

function FleetRow({ line }: { line: Line }) {
  const { agent: a, state, claims } = line;
  const [first, ...rest] = claims;
  const gone = state === "gone";
  const percent = contextPercent(a);
  const sub =
    first?.status === "review" && first.pr !== undefined
      ? `PR #${first.pr} open`
      : state === "stale" && first && first.steps.length > 0
        ? `${first.stepsDone} of ${first.steps.length} Steps`
        : rest.length > 0
          ? `and ${rest.map((t) => `#${t.number}`).join(", ")}`
          : undefined;
  return (
    <tr className="border-b border-rule align-top transition-colors duration-[var(--dur)] hover:bg-paper-2">
      <td className="py-2 pr-3 pl-3 text-row">
        <State state={state} person={a.person} />
      </td>
      <td className="py-2 pr-3">
        <a href={href({ view: "agent", id: a.id })} className={cn("text-row font-semibold [overflow-wrap:anywhere] hover:underline", gone ? "text-ink-2" : "text-ink")}>
          {shortName(a)}
        </a>
        <Secondary agent={a} model={false} />
      </td>
      <td className={cn("py-2 pr-3 text-row", gone && !first ? "text-ink-3" : "text-ink")}>
        {first ? (
          <a href={href({ view: "task", number: first.number })} className="[overflow-wrap:anywhere] hover:underline">
            #{first.number} {first.title}
          </a>
        ) : (
          "No Claim"
        )}
        {sub && <span className="block text-small text-ink-3">{sub}</span>}
      </td>
      <td className="py-2 pr-3 text-right text-row whitespace-nowrap tabular-nums">{percent === undefined ? "" : `${percent}%`}</td>
      <td className="py-2 pr-3 text-right text-row whitespace-nowrap text-ink-3 tabular-nums">{elapsed(since(a))}</td>
    </tr>
  );
}

/** The latest notes Agents left for each other (ADR 0019), newest first. */
function Memory({ events, now }: { events: ChannelEvent[]; now: number }) {
  const { agentById } = useIndex();
  const notes = useMemo(
    () =>
      events
        .map(noteFromEvent)
        .filter((n) => n !== null)
        .reverse(),
    [events],
  );
  return (
    <section aria-label="Memory" className="flex min-w-0 flex-col">
      <SectionHead title="Memory" meta={notes.length > 0 && `${notes.length} ${notes.length === 1 ? "note" : "notes"}, latest first`} />
      {notes.length === 0 ? (
        <p className="py-4 text-row text-ink-3">No notes yet. Agents leave them with memory_note.</p>
      ) : (
        <ol>
          {notes.slice(0, 3).map((n) => (
            // A note opens in Memory, with the Events around it.
            <RowFrame key={n.id} selected={false} onPick={() => go({ view: "memory", note: n.id })} className="px-1 py-3">
              <p className="max-w-[72ch] text-row break-words text-ink">{n.text}</p>
              <p className="mt-1 text-small text-ink-3">
                <span className="font-semibold text-ink-2">{n.tags.map((t) => TAG_LABEL[t]).join(", ")}</span>
                {" · "}
                {(() => {
                  const a = agentById.get(n.author);
                  return a ? shortName(a) : (n.nickname ?? n.author);
                })()}
                {n.task !== undefined && ` on #${n.task}`} · {elapsed(n.at, now)}
              </p>
            </RowFrame>
          ))}
        </ol>
      )}
    </section>
  );
}
