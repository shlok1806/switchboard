/*
 * The Agents view (design.md's Workbench): one table of every Agent, grouped by Person,
 * each row a line with its state first, and an inspector at the right for the selected
 * row. Below 640px the rows stack, the inspector is not on the page, and a row opens its
 * Agent instead.
 */
import { useMemo, useState } from "react";
import type { Agent, Person, Task } from "@shared/index";
import { buttonVariants } from "@/components/atoms/Button";
import { PendingApproval } from "@/components/domain/approval";
import { ContextWindow } from "@/components/domain/context";
import { IssueLink, Pending } from "@/components/domain/pending";
import { StartAgentButton, useHostsSupported } from "@/components/domain/start-agent";
import { Glyph, State, useAgentStates } from "@/components/domain/state";
import { AgentUsage } from "@/components/domain/usage";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { useCapabilities, useChannel, useIndex, useMe } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { claimsByAgent } from "@/lib/canvas-layout";
import { CLI_LABEL, ago, elapsed, hostName } from "@/lib/format";
import { go, href } from "@/lib/router";
import { byState, countStates, type AgentState } from "@/lib/state";
import { modelLabel } from "@shared/index";
import { cn } from "@/lib/utils";

/** Every Claim each Agent holds, oldest first. One Agent may hold several. */
export function useClaimsOf() {
  const { tasks } = useChannel();
  return useMemo(() => claimsByAgent(tasks), [tasks]);
}

/** A Host an Agent was started on, by name. */
export function HostLabel({ host }: { host: string }) {
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]" title={`Started by a Host, with no terminal: ${host}`}>
      on {hostName(host)}
    </span>
  );
}

type Filter = "all" | "needs" | "running" | "idle" | "gone" | "mine";

const name = (a: Agent) => a.nickname ?? a.id;
/** The CLI's short name, as the Agent ID spells it. */
const cliShort = (a: Agent) => a.id.split("/")[1] ?? CLI_LABEL[a.cli];
const place = (zone: string) => zone.split("/").pop()?.replaceAll("_", " ") ?? zone;

function localTime(now: number, timeZone: string) {
  try {
    return new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
  } catch {
    return "";
  }
}

/** How long the Agent has run; a waiting prompt's own age is in the Working on line. */
const since = (a: Agent) => a.startedAt;

interface Line {
  agent: Agent;
  state: AgentState;
  claims: Task[];
}

export function AgentsView() {
  const { agents, snapshot } = useChannel();
  const me = useMe();
  const states = useAgentStates();
  const claimsOf = useClaimsOf();
  const can = useCapabilities();
  const hosts = useHostsSupported();
  const mobile = useIsMobile();
  const [filter, setFilter] = useState<Filter>("all");
  const [find, setFind] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const lines: Line[] = useMemo(
    () =>
      agents
        .map((a) => ({ agent: a, state: states.get(a.id) ?? "gone", claims: claimsOf.get(a.id) ?? [] }))
        .sort((x, y) => byState(x.state, y.state) || x.agent.id.localeCompare(y.agent.id)),
    [agents, states, claimsOf],
  );

  if (agents.length === 0) {
    return (
      <Pending title={can.agents ? "No Agents yet" : "Agents are not on this Channel yet"} className="h-full">
        {can.agents ? (
          // Shown once the Channel says whether it has Hosts, so the text never changes under the reader.
          hosts !== null && (
            <>
              Run <code className="text-ink-2">switchboard run claude</code> to add one
              {hosts ? <>, or start one on a&nbsp;Host.</> : "."}
              {hosts && (
                <span className="mt-4 flex justify-center">
                  <StartAgentButton />
                </span>
              )}
            </>
          )
        ) : (
          <>
            Agents appear once <IssueLink capability="agents" /> lands.
          </>
        )}
      </Pending>
    );
  }

  const n = countStates(lines.map((l) => l.state));
  const needPerson = n.needs + n["needs-other"] + n.stale;
  const persons = new Set(agents.map((a) => a.person)).size;
  const q = find.trim().toLowerCase();
  const shown = lines.filter((l) => {
    const keep =
      filter === "all" ||
      (filter === "needs" && (l.state === "needs" || l.state === "needs-other" || l.state === "stale")) ||
      (filter === "mine" && l.agent.person === me) ||
      l.state === filter;
    if (!keep || !q) return keep;
    return [l.agent.id, l.agent.nickname, l.agent.host, ...l.claims.map((t) => `#${t.number} ${t.title}`)].some((s) => s?.toLowerCase().includes(q));
  });
  const chips: { id: Filter; label: string; n: number; signal?: boolean }[] = [
    { id: "all", label: "All", n: lines.length },
    { id: "needs", label: "Needs a Person", n: needPerson, signal: true },
    { id: "running", label: "Live", n: n.running },
    { id: "idle", label: "Idle", n: n.idle },
    { id: "gone", label: "Gone", n: n.gone },
    { id: "mine", label: "Mine", n: lines.filter((l) => l.agent.person === me).length },
  ];
  const selected = shown.find((l) => l.agent.id === picked) ?? shown[0];
  const byPerson = groupByPerson(shown, me);
  const zones = new Map((snapshot?.persons ?? []).map((p: Person) => [p.name, p.timeZone]));

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Agents"
          facts={[
            `${lines.length} for ${persons} ${persons === 1 ? "Person" : "People"}`,
            `${n.running} live`,
            needPerson > 0 && `${needPerson} ${needPerson === 1 ? "needs" : "need"} a Person`,
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={filter === c.id}
                onClick={() => setFilter(c.id)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-[var(--r)] border px-2 text-label font-medium whitespace-nowrap transition-colors duration-[var(--dur)]",
                  filter === c.id ? "border-ink text-ink" : "border-rule text-ink-2 hover:border-ink-3 hover:text-ink",
                )}
              >
                {c.label}
                <span className={cn("tabular-nums", c.signal && c.n > 0 ? "font-semibold text-signal" : "text-ink-3")}>{c.n}</span>
              </button>
            ))}
          </div>
          <span className="text-small font-medium text-ink max-sm:hidden">Grouped by Person</span>
          <label className="ml-auto flex items-center gap-2 text-small text-ink-3 max-sm:w-full">
            <span>Find</span>
            <input
              type="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="name, Task or Host"
              className="h-[30px] w-56 min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus max-sm:flex-1 max-sm:text-[16px]"
            />
          </label>
          <StartAgentButton />
        </div>

        {shown.length === 0 ? (
          <p className="border-t border-rule py-6 text-row text-ink-3">No Agent matches.</p>
        ) : mobile ? (
          <ul className="flex flex-col">
            {byPerson.map(([person, group]) => (
              <li key={person}>
                <GroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                <ul>
                  {group.map((l) => (
                    <StackedRow key={l.agent.id} line={l} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rule text-label font-medium text-ink-3">
                <th className="w-[9.5rem] py-2 pr-3 pl-3 font-medium">State</th>
                <th className="py-2 pr-3 font-medium">Agent</th>
                <th className="py-2 pr-3 font-medium">Working on</th>
                <th className="w-[7.5rem] py-2 pr-3 text-right font-medium">Context</th>
                <th className="py-2 pr-3 font-medium max-[900px]:hidden">Host</th>
                <th className="w-20 py-2 pr-3 text-right font-medium">Since</th>
              </tr>
            </thead>
            {byPerson.map(([person, group]) => (
              <tbody key={person}>
                <tr>
                  <td colSpan={6} className="p-0">
                    <GroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                  </td>
                </tr>
                {group.map((l) => (
                  <Row key={l.agent.id} line={l} selected={l === selected} onSelect={() => setPicked(l.agent.id)} />
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
      {!mobile && selected && <Inspector line={selected} />}
    </div>
  );
}

function groupByPerson(lines: Line[], me: string): [string, Line[]][] {
  const m = new Map<string, Line[]>();
  for (const l of lines) m.set(l.agent.person, [...(m.get(l.agent.person) ?? []), l]);
  return [...m.entries()].sort(([a], [b]) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
}

/** A Person's group line: who, where and what time it is for them. */
function GroupLine({ person, me, zone, count }: { person: string; me: string; zone?: string; count: number }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 border-b border-rule-2 px-3 pt-4 pb-2 text-small text-ink-3">
      <span className="font-semibold text-ink">{person}</span>
      {[person === me && "you", zone && `${place(zone)} ${localTime(Date.now(), zone)}`, `${count} ${count === 1 ? "Agent" : "Agents"}`]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/** The Agent's second line: its CLI, model and its place among leads. */
function Secondary({ agent }: { agent: Agent }) {
  const { agents } = useChannel();
  const led = agent.role === "lead" ? agents.filter((a) => a.parent === agent.id).length : 0;
  const parent = agent.parent ? agents.find((a) => a.id === agent.parent) : undefined;
  const parts = [
    cliShort(agent),
    agent.model && modelLabel(agent.model),
    agent.role === "lead" && `lead of ${led}`,
    parent && `started by ${name(parent)}`,
  ].filter(Boolean);
  return <span className="block text-small text-ink-3">{parts.join(" · ")}</span>;
}

/** What the Agent works on: its Claim, and a line on where that stands. */
function WorkingOn({ line }: { line: Line }) {
  const { agent: a, state, claims } = line;
  const [first, ...rest] = claims;
  const note =
    a.approval && (state === "needs" || state === "needs-other")
      ? `Asked to run ${a.approval.tool} ${elapsed(a.approval.openedAt)} ago`
      : state === "stale" && first
        ? `${first.stepsDone} of ${first.steps.length} Steps done. Anyone can take it over.`
        : (a.context?.activity ?? a.context?.task);
  return (
    <>
      {first ? (
        <a href={href({ view: "task", number: first.number })} onClick={(e) => e.stopPropagation()} className="text-row text-ink hover:underline">
          #{first.number} {first.title}
          {rest.length > 0 && `, and ${rest.map((t) => `#${t.number}`).join(", ")}`}
        </a>
      ) : (
        <span className="text-row text-ink-3">No Claim</span>
      )}
      {note && <span className="block text-small text-ink-3">{note}</span>}
    </>
  );
}

function Row({ line, selected, onSelect }: { line: Line; selected: boolean; onSelect: () => void }) {
  const { agent: a, state } = line;
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") go({ view: "agent", id: a.id });
        if (e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "cursor-pointer border-b border-rule align-top transition-colors duration-[var(--dur)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
        selected ? "bg-paper-3" : "hover:bg-paper-2",
      )}
    >
      <td className="py-2 pr-3 pl-3">
        <State state={state} person={a.person} />
      </td>
      <td className="py-2 pr-3">
        <a
          href={href({ view: "agent", id: a.id })}
          onClick={(e) => e.stopPropagation()}
          className={cn("text-row font-semibold [overflow-wrap:anywhere] hover:underline", state === "gone" ? "text-ink-2" : "text-ink")}
        >
          {name(a)}
        </a>
        <Secondary agent={a} />
      </td>
      <td className="py-2 pr-3">
        <WorkingOn line={line} />
      </td>
      <td className="py-2 pr-3 text-right text-row">
        <ContextWindow agent={a} compact />
      </td>
      <td className="py-2 pr-3 text-row text-ink-2 max-[900px]:hidden">{a.host ? hostName(a.host) : "terminal"}</td>
      <td className="py-2 pr-3 text-right text-row text-ink-3 tabular-nums">{elapsed(since(a))}</td>
    </tr>
  );
}

/** A row on a phone: state and age; the name and its context; the Task. It opens the Agent. */
function StackedRow({ line }: { line: Line }) {
  const { agent: a, state } = line;
  const c = a.context;
  const percent = c?.tokens !== undefined && c.window ? Math.round((c.tokens / c.window) * 100) : undefined;
  return (
    <li>
      <a href={href({ view: "agent", id: a.id })} className="flex flex-col gap-1 border-b border-rule px-3 py-3 hover:bg-paper-2 hover:no-underline">
        <span className="flex items-center justify-between gap-3 text-row">
          <State state={state} person={a.person} />
          <span className="text-ink-3 tabular-nums">{elapsed(since(a))}</span>
        </span>
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-row font-semibold [overflow-wrap:anywhere] text-ink">{name(a)}</span>
            <Secondary agent={a} />
          </span>
          {percent !== undefined && <span className="shrink-0 text-row text-ink tabular-nums">{percent}%</span>}
        </span>
        <span className="text-row text-ink-2">
          {line.claims[0] ? `#${line.claims[0].number} ${line.claims[0].title}` : <span className="text-ink-3">No Claim</span>}
        </span>
      </a>
    </li>
  );
}

/** The selected Agent, read without leaving the list. */
function Inspector({ line }: { line: Line }) {
  const { agent: a, state, claims } = line;
  const me = useMe();
  const { agents } = useChannel();
  const { agentById } = useIndex();
  const led = agents.filter((x) => x.parent === a.id);
  const parent = a.parent ? agentById.get(a.parent) : undefined;
  const task = claims[0];
  const firstOpen = task?.steps.findIndex((s) => !s.done) ?? -1;
  const fact = [
    `${a.person === me ? "Your" : `${a.person}'s`} ${CLI_LABEL[a.cli]} ${a.host ? `on ${hostName(a.host)}` : "in a terminal"}.`,
    a.model && `${modelLabel(a.model)}${a.effort ? `, ${a.effort} effort` : ""}.`,
    `Started ${ago(a.startedAt)}${led.length ? `, leads ${led.map(name).join(", ")}` : ""}${parent ? `, started by ${name(parent)}` : ""}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <aside aria-label={`${name(a)}, in the inspector`} className="flex w-[var(--inspector-w)] shrink-0 flex-col gap-6 overflow-y-auto border-l border-rule px-5 pt-5 pb-12">
      <div className="flex flex-col gap-2">
        <h2 className="flex flex-wrap items-center gap-x-2 text-title font-semibold [overflow-wrap:anywhere] text-ink">
          <Glyph state={state} />
          {name(a)}
          <State state={state} person={a.person} className="[&>svg]:hidden" />
        </h2>
        <p className="text-row text-ink-2">{fact}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <a href={href({ view: "agent", id: a.id })} className={buttonVariants({ variant: "primary" })}>
            Open the terminal
          </a>
        </div>
      </div>
      <PendingApproval agent={a} />
      {task && (
        <Section
          title={
            <a href={href({ view: "task", number: task.number })} className="hover:underline">
              #{task.number} {task.title}
            </a>
          }
          meta={task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length}`}
          bodyClassName="pt-0"
        >
          {task.steps.length > 0 ? (
            <ul>
              {task.steps.map((s, i) => (
                <li key={s.index} className={cn("flex items-baseline gap-2.5 border-b border-rule py-2 text-row", s.done || i === firstOpen ? "text-ink" : "text-ink-3")}>
                  <Glyph state={s.done ? "done" : i === firstOpen ? "running" : "idle"} className="relative top-px" />
                  <span className="sr-only">{s.done ? "Done:" : i === firstOpen ? "Next:" : "Open:"}</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pt-3 text-small text-ink-3">No Steps on this Task.</p>
          )}
        </Section>
      )}
      <Section title="Context window">
        <ContextWindow agent={a} />
      </Section>
      {a.usage && (
        <Section title="Account">
          <AgentUsage agent={a} />
        </Section>
      )}
      <Section title="Where">
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-row">
          <dt className="text-ink-3">Host</dt>
          <dd>{a.host ? hostName(a.host) : "a terminal"}</dd>
          {a.context?.cwd && (
            <>
              <dt className="text-ink-3">Folder</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{a.context.cwd}</code>
              </dd>
            </>
          )}
          {a.context?.branch && (
            <>
              <dt className="text-ink-3">Branch</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{a.context.branch}</code>
              </dd>
            </>
          )}
          {led.length > 0 && (
            <>
              <dt className="text-ink-3">Leads</dt>
              <dd>{led.map(name).join(", ")}</dd>
            </>
          )}
        </dl>
      </Section>
    </aside>
  );
}
