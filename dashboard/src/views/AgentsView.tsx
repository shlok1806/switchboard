/*
 * The Agents view (design.md's Workbench): one table of every Agent, grouped by Person,
 * each row a line with its state first, and an inspector at the right for the selected
 * row. Below 640px the rows stack, the inspector is not on the page, and a row opens its
 * Agent instead.
 */
import { useState } from "react";
import type { Person } from "@shared/index";
import { buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { PendingApproval } from "@/components/domain/approval";
import { ContextWindow } from "@/components/domain/context";
import { IssueLink, Pending } from "@/components/domain/pending";
import { StartAgentButton, useHostsSupported } from "@/components/domain/start-agent";
import { GroupLine, Secondary, StackedRow, agentName, groupByPerson, shortName, since, useLines, type Line } from "@/components/domain/fleet";
import { Glyph, State, useNeedsYou } from "@/components/domain/state";
import { AgentUsage } from "@/components/domain/usage";
import { InspectorFrame, SheetClose } from "@/components/shell/inspector";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { useCapabilities, useChannel, useIndex, useMe } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { CLI_LABEL, ago, elapsed, hostName } from "@/lib/format";
import { go, href } from "@/lib/router";
import { countStates, isNeedsYou } from "@/lib/state";
import { modelLabel } from "@shared/index";
import { cn } from "@/lib/utils";

type Filter = "all" | "needs" | "running" | "idle" | "gone" | "mine";

export function AgentsView() {
  const { agents, snapshot } = useChannel();
  const me = useMe();
  const can = useCapabilities();
  const hosts = useHostsSupported();
  const mobile = useIsMobile();
  const [filter, setFilter] = useState<Filter>("all");
  const [find, setFind] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // On a phone the picked Agent opens as a sheet over the list, and only when a row is tapped.
  const [sheet, setSheet] = useState<string | null>(null);

  const lines = useLines();
  const needYou = useNeedsYou();

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
  const persons = new Set(agents.map((a) => a.person)).size;
  const q = find.trim().toLowerCase();
  const shown = lines.filter((l) => {
    const keep =
      filter === "all" ||
      (filter === "needs" && isNeedsYou(l.state)) ||
      (filter === "mine" && l.agent.person === me) ||
      l.state === filter;
    if (!keep || !q) return keep;
    return [l.agent.id, l.agent.nickname, l.agent.host, ...l.claims.map((t) => `#${t.number} ${t.title}`)].some((s) => s?.toLowerCase().includes(q));
  });
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: lines.length },
    { id: "needs", label: "Needs you", n: lines.filter((l) => isNeedsYou(l.state)).length },
    { id: "running", label: "Live", n: n.running },
    { id: "idle", label: "Idle", n: n.idle },
    { id: "gone", label: "Gone", n: n.gone },
    { id: "mine", label: "Mine", n: lines.filter((l) => l.agent.person === me).length },
  ];
  const selected = shown.find((l) => l.agent.id === picked) ?? shown[0];
  const byPerson = groupByPerson(shown, me);
  const sheetLine = lines.find((l) => l.agent.id === sheet);
  const zones = new Map((snapshot?.persons ?? []).map((p: Person) => [p.name, p.timeZone]));

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Agents"
          facts={[
            `${lines.length} for ${persons} ${persons === 1 ? "Person" : "People"}`,
            `${n.running} live`,
            needYou > 0 && `${needYou} ${needYou === 1 ? "needs" : "need"} you`,
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <Chip key={c.id} on={filter === c.id} onClick={() => setFilter(c.id)} count={c.n}>
                {c.label}
              </Chip>
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
              className="h-[30px] w-56 min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:flex-1 max-sm:text-[16px]"
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
                    <StackedRow key={l.agent.id} line={l} onOpen={() => setSheet(l.agent.id)} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rule text-label font-medium text-ink-3">
                <th scope="col" className="w-[9.5rem] py-2 pr-3 pl-3 font-medium">State</th>
                <th scope="col" className="py-2 pr-3 font-medium">Agent</th>
                <th scope="col" className="py-2 pr-3 font-medium">Working on</th>
                <th scope="col" className="w-[7.5rem] py-2 pr-3 text-right font-medium">Context</th>
                <th scope="col" className="py-2 pr-3 font-medium max-[900px]:hidden">Host</th>
                <th scope="col" className="w-20 py-2 pr-3 text-right font-medium">Since</th>
              </tr>
            </thead>
            {byPerson.map(([person, group]) => (
              <tbody key={person}>
                <tr>
                  <th scope="rowgroup" colSpan={6} className="p-0 text-left font-normal">
                    <GroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                  </th>
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
      {mobile && sheetLine && <Inspector key={sheetLine.agent.id} line={sheetLine} onClose={() => setSheet(null)} />}
    </div>
  );
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
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") go({ view: "agent", id: a.id });
        if (e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "h-[var(--row)] cursor-pointer border-b border-rule align-top transition-colors duration-[var(--dur)] focus-visible:-outline-offset-2",
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
          {shortName(a)}
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

/** The selected Agent, read without leaving the list. */
function Inspector({ line, onClose }: { line: Line; onClose?: () => void }) {
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
    `Started ${ago(a.startedAt)}${led.length ? `, leads ${led.map(agentName).join(", ")}` : ""}${parent ? `, started by ${agentName(parent)}` : ""}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <InspectorFrame label={`${agentName(a)}, in the inspector`} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <h2 className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-title font-semibold [overflow-wrap:anywhere] text-ink">
            <Glyph state={state} />
            {agentName(a)}
            <State state={state} person={a.person} glyph={false} />
          </h2>
          <SheetClose onClose={onClose} />
        </div>
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
              <dd>{led.map(agentName).join(", ")}</dd>
            </>
          )}
        </dl>
      </Section>
    </InspectorFrame>
  );
}
