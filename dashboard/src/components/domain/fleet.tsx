/*
 * The fleet's lines, shared by the Agents view and the Now view's Fleet: each Agent with its
 * one state and its Claims, grouped by Person, you first. A group line says who, where and
 * what time it is for them; on a phone a line stacks into three.
 */
import { useMemo } from "react";
import type { Agent, Task } from "@shared/index";
import { State, useAgentStates } from "@/components/domain/state";
import { useChannel } from "@/data/store";
import { claimsByAgent } from "@/lib/canvas-layout";
import { CLI_LABEL, elapsed, hostName, localTime, zoneCity } from "@/lib/format";
import { href } from "@/lib/router";
import { byState, type AgentState } from "@/lib/state";
import { modelLabel } from "@shared/index";

export interface Line {
  agent: Agent;
  state: AgentState;
  claims: Task[];
}

/** Every Claim each Agent holds, oldest first. One Agent may hold several. */
export function useClaimsOf() {
  const { tasks } = useChannel();
  return useMemo(() => claimsByAgent(tasks), [tasks]);
}

/** Every Agent as a line, in state order. */
export function useLines(): Line[] {
  const { agents } = useChannel();
  const states = useAgentStates();
  const claimsOf = useClaimsOf();
  return useMemo(
    () =>
      agents
        .map((a) => ({ agent: a, state: states.get(a.id) ?? "gone", claims: claimsOf.get(a.id) ?? [] }))
        .sort((x, y) => byState(x.state, y.state) || x.agent.id.localeCompare(y.agent.id)),
    [agents, states, claimsOf],
  );
}

/** A Host an Agent was started on, by name. */
export function HostLabel({ host }: { host: string }) {
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]" title={`Started by a Host, with no terminal: ${host}`}>
      on {hostName(host)}
    </span>
  );
}

export const agentName = (a: Agent) => a.nickname ?? a.id;
/** Inside a Person's group the Person is already named: `codex/c91e`, not `shlok/codex/c91e`. */
export const shortName = (a: Agent) => a.nickname ?? a.id.split("/").slice(1).join("/");
/** The CLI's short name, as the Agent ID spells it. */
const cliShort = (a: Agent) => a.id.split("/")[1] ?? CLI_LABEL[a.cli];

/** How long the Agent has run; a waiting prompt's own age is on its Ask. */
export const since = (a: Agent) => a.startedAt;

export function groupByPerson(lines: Line[], me: string): [string, Line[]][] {
  const m = new Map<string, Line[]>();
  for (const l of lines) m.set(l.agent.person, [...(m.get(l.agent.person) ?? []), l]);
  return [...m.entries()].sort(([a], [b]) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
}

/** A Person's group line: who, where and what time it is for them. */
export function GroupLine({ person, me, zone, count }: { person: string; me: string; zone?: string; count: number }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 border-b border-rule-2 px-3 pt-4 pb-2 text-small text-ink-3">
      <span className="font-semibold text-ink">{person}</span>
      {[person === me && "you", zone && `${zoneCity(zone)} ${localTime(Date.now(), zone)}`, `${count} ${count === 1 ? "Agent" : "Agents"}`]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/** The Agent's second line: its CLI, model and its place among leads. */
export function Secondary({ agent, model = true }: { agent: Agent; model?: boolean }) {
  const { agents } = useChannel();
  const led = agent.role === "lead" ? agents.filter((a) => a.parent === agent.id).length : 0;
  const parent = agent.parent ? agents.find((a) => a.id === agent.parent) : undefined;
  const parts = [
    cliShort(agent),
    model && agent.model && modelLabel(agent.model),
    agent.role === "lead" && `lead of ${led}`,
    parent && `started by ${agentName(parent)}`,
  ].filter(Boolean);
  return <span className="block text-small text-ink-3">{parts.join(" · ")}</span>;
}

/** How full the Agent's context window is, as a whole percent. */
export function contextPercent(a: Agent): number | undefined {
  const c = a.context;
  return c?.tokens !== undefined && c.window ? Math.round((c.tokens / c.window) * 100) : undefined;
}

/** A line on a phone: state and age; the name and its context; the Task. It opens the Agent. */
export function StackedRow({ line, model = true }: { line: Line; /** False where the row has no room for the model. */ model?: boolean }) {
  const { agent: a, state } = line;
  const percent = contextPercent(a);
  return (
    <li>
      <a href={href({ view: "agent", id: a.id })} className="flex flex-col gap-1 border-b border-rule px-3 py-3 hover:bg-paper-2 hover:no-underline">
        <span className="flex items-center justify-between gap-3 text-row">
          <State state={state} person={a.person} />
          <span className="text-ink-3 tabular-nums">{elapsed(since(a))}</span>
        </span>
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-row font-semibold [overflow-wrap:anywhere] text-ink">{shortName(a)}</span>
            <Secondary agent={a} model={model} />
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
