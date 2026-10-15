/*
 * The Hosts view: every machine that starts Agents with no terminal (ADR 0015), grouped by
 * Person, you first. A row says whether the Host is Live, what runs on it, where Agents may
 * start and how loose they may run. The inspector at the right reads the selected Host;
 * below 640px the rows stack and carry all of it themselves.
 */
import { useEffect, useMemo, useState } from "react";
import type { Agent, Host, HostsResponse, Person } from "@shared/index";
import { Chip } from "@/components/atoms/Chip";
import { GroupLine, shortName } from "@/components/domain/fleet";
import { Pending } from "@/components/domain/pending";
import { StartAgentButton } from "@/components/domain/start-agent";
import { Glyph, State, useAgentStates } from "@/components/domain/state";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { useChannel, useMe, useStore } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { ago } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";

type Filter = "all" | "live" | "offline" | "mine";

/** How loose each permission mode lets an Agent on the Host run, as a phrase. */
const MODE_LABEL: Record<Host["maxPermissionMode"], string> = {
  plan: "Plan only",
  dontAsk: "Allowed tools only",
  default: "Asks before edits",
  acceptEdits: "Edits without asking",
  auto: "Auto-approved",
  bypassPermissions: "No permission checks",
};

/**
 * The Channel's Hosts, read again whenever one comes online or goes offline, or an Agent starts
 * or stops on one. `undefined` while loading, `null` when the Channel's Worker has no Hosts.
 */
export function useHosts(): { hosts?: HostsResponse | null; problem?: string } {
  const store = useStore();
  const { events, agents } = useChannel();
  const lastHostEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === "host.online" || events[i]!.type === "host.offline") return events[i]!.id;
    return undefined;
  }, [events]);
  const onHosts = agents
    .filter((a) => a.host)
    .map((a) => `${a.id}:${a.presence}`)
    .join(" ");
  const [state, setState] = useState<{ hosts?: HostsResponse | null; problem?: string }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Host event and the Agents on Hosts are what make a read stale.
  useEffect(() => {
    let live = true;
    store.source.hosts().then(
      (hosts) => live && setState({ hosts }),
      (e: Error) => live && setState((s) => ({ hosts: s.hosts, problem: e.message })),
    );
    return () => {
      live = false;
    };
  }, [store, lastHostEvent, onHosts]);
  return state;
}

export function HostsView({ selected: selectedId }: { selected?: string }) {
  const { agents, snapshot } = useChannel();
  const me = useMe();
  const mobile = useIsMobile();
  const { hosts: response, problem } = useHosts();
  const [filter, setFilter] = useState<Filter>("all");

  if (response === undefined) {
    return problem ? (
      <Pending title="Could not read the Hosts" className="h-full">
        {problem}
      </Pending>
    ) : null;
  }
  if (response === null) {
    return (
      <Pending title="Hosts are not on this Channel yet" className="h-full">
        This Channel's Worker predates Hosts. Agents still join from a terminal with <code className="text-ink-2">switchboard run claude</code>.
      </Pending>
    );
  }
  const all = response.hosts;
  if (all.length === 0) {
    return (
      <Pending title="No Hosts yet" className="h-full">
        Run <code className="text-ink-2">switchboard host install --root ~/code/your-repo</code> on a machine to let it start Agents for you.
      </Pending>
    );
  }

  const onHost = (h: Host) => agents.filter((a) => a.host === h.id);
  const live = all.filter((h) => h.live).length;
  const persons = new Set(all.map((h) => h.person)).size;
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: all.length },
    { id: "live", label: "Live", n: live },
    { id: "offline", label: "Offline", n: all.length - live },
    { id: "mine", label: "Mine", n: all.filter((h) => h.person === me).length },
  ];
  const shown = all.filter((h) => filter === "all" || (filter === "live" && h.live) || (filter === "offline" && !h.live) || (filter === "mine" && h.person === me));
  const byPerson = groupHosts(shown, me);
  const selected = shown.find((h) => h.id === selectedId) ?? shown[0];
  const zones = new Map((snapshot?.persons ?? []).map((p: Person) => [p.name, p.timeZone]));

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Hosts"
          facts={[
            `${all.length} for ${persons} ${persons === 1 ? "Person" : "People"}`,
            `${live} live`,
            `${response.running} of ${response.cap} Agents running on Hosts`,
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
          <span className="ml-auto max-sm:ml-0">
            <StartAgentButton />
          </span>
        </div>

        {shown.length === 0 ? (
          <p className="border-t border-rule py-6 text-row text-ink-3">No Host matches.</p>
        ) : mobile ? (
          <ul className="flex flex-col">
            {byPerson.map(([person, group]) => (
              <li key={person}>
                <HostGroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                <ul>
                  {group.map((h) => (
                    <StackedHost key={h.id} host={h} agents={onHost(h)} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rule text-label font-medium text-ink-3">
                <th scope="col" className="w-[7.5rem] py-2 pr-3 pl-3 font-medium">State</th>
                <th scope="col" className="py-2 pr-3 font-medium">Host</th>
                <th scope="col" className="py-2 pr-3 font-medium">Agents</th>
                <th scope="col" className="py-2 pr-3 font-medium max-[1100px]:hidden">Folders</th>
                <th scope="col" className="w-28 py-2 pr-3 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            {byPerson.map(([person, group]) => (
              <tbody key={person}>
                <tr>
                  <th scope="rowgroup" colSpan={5} className="p-0 text-left font-normal">
                    <HostGroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                  </th>
                </tr>
                {group.map((h) => (
                  <Row key={h.id} host={h} agents={onHost(h)} selected={h === selected} />
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
      {!mobile && selected && <Inspector host={selected} agents={onHost(selected)} />}
    </div>
  );
}

/** Hosts by Person, you first, then by name; Live before Offline inside a group. */
export function groupHosts(hosts: Host[], me: string): [string, Host[]][] {
  const m = new Map<string, Host[]>();
  for (const h of hosts) m.set(h.person, [...(m.get(h.person) ?? []), h]);
  for (const group of m.values()) group.sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
  return [...m.entries()].sort(([a], [b]) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
}

function HostGroupLine({ person, me, zone, count }: { person: string; me: string; zone?: string; count: number }) {
  return <GroupLine person={person} me={me} zone={zone} count={count} noun={["Host", "Hosts"]} />;
}

function HostState({ host }: { host: Host }) {
  return <State state={host.live ? "running" : "gone"} word={host.live ? "Live" : "Offline"} />;
}

/** The Agents a Host runs, by name, each a link. */
function AgentsOn({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) return <span className="text-row text-ink-3">No Agents</span>;
  return (
    <span className="text-row">
      {agents.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ", "}
          <a href={href({ view: "agent", id: a.id })} onClick={(e) => e.stopPropagation()} className={cn("hover:underline", a.presence === "gone" ? "text-ink-3" : "text-ink")}>
            {shortName(a)}
          </a>
        </span>
      ))}
    </span>
  );
}

function Folders({ roots }: { roots: string[] }) {
  return (
    <span className="flex flex-col gap-0.5">
      {roots.map((r) => (
        <code key={r} className="text-small [overflow-wrap:anywhere] text-ink-2">
          {r}
        </code>
      ))}
    </span>
  );
}

function Row({ host: h, agents, selected }: { host: Host; agents: Agent[]; selected: boolean }) {
  const pick = () => go({ view: "hosts", host: h.id });
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      }}
      className={cn(
        "h-[var(--row)] cursor-pointer border-b border-rule align-top transition-colors duration-[var(--dur)] focus-visible:-outline-offset-2",
        selected ? "bg-paper-3" : "hover:bg-paper-2",
      )}
    >
      <td className="py-2 pr-3 pl-3 text-row">
        <HostState host={h} />
      </td>
      <td className="py-2 pr-3">
        <span className={cn("block text-row font-semibold [overflow-wrap:anywhere]", h.live ? "text-ink" : "text-ink-2")}>{h.name}</span>
        <span className="block text-small text-ink-3">{MODE_LABEL[h.maxPermissionMode]}</span>
      </td>
      <td className="py-2 pr-3">
        <AgentsOn agents={agents} />
      </td>
      <td className="py-2 pr-3 max-[1100px]:hidden">
        <Folders roots={h.roots} />
      </td>
      <td className="py-2 pr-3 text-right text-row text-ink-3 tabular-nums">{h.live ? "now" : ago(h.lastSeenAt)}</td>
    </tr>
  );
}

/** A Host on a phone: state and last seen; the name and its mode; what runs on it and where. */
function StackedHost({ host: h, agents }: { host: Host; agents: Agent[] }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-rule px-3 py-3">
      <span className="flex items-center justify-between gap-3 text-row">
        <HostState host={h} />
        <span className="text-ink-3 tabular-nums">{h.live ? "now" : ago(h.lastSeenAt)}</span>
      </span>
      <span>
        <span className={cn("block text-row font-semibold [overflow-wrap:anywhere]", h.live ? "text-ink" : "text-ink-2")}>{h.name}</span>
        <span className="block text-small text-ink-3">{MODE_LABEL[h.maxPermissionMode]}</span>
      </span>
      <AgentsOn agents={agents} />
      <Folders roots={h.roots} />
    </li>
  );
}

/** The selected Host, read without leaving the list. */
function Inspector({ host: h, agents }: { host: Host; agents: Agent[] }) {
  const me = useMe();
  const states = useAgentStates();
  const mine = h.person === me;
  const fact = [
    `${mine ? "Your" : `${h.person}'s`} Host, registered ${ago(h.registeredAt)}.`,
    h.live ? "Live now: it can start and stop Agents." : `Offline, last seen ${ago(h.lastSeenAt)}. It starts nothing until it comes back.`,
  ].join(" ");
  return (
    <aside aria-label={`${h.name}, in the inspector`} className="flex w-[var(--inspector-w)] shrink-0 flex-col gap-6 overflow-y-auto border-l border-rule px-5 pt-5 pb-12">
      <div className="flex flex-col gap-2">
        <h2 className="flex flex-wrap items-center gap-x-2 text-title font-semibold [overflow-wrap:anywhere] text-ink">
          <Glyph state={h.live ? "running" : "gone"} />
          {h.name}
          <State state={h.live ? "running" : "gone"} word={h.live ? "Live" : "Offline"} glyph={false} />
        </h2>
        <p className="text-row text-ink-2">{fact}</p>
        {!h.live && mine && (
          <p className="text-small text-ink-3">
            Start <code className="text-ink-2">switchboard host run</code> there, or wait for launchd to bring it back.
          </p>
        )}
      </div>
      <Section title="Agents on it" meta={agents.length > 0 && agents.length} as="h3">
        {agents.length === 0 ? (
          <p className="text-small text-ink-3">Nothing runs here.</p>
        ) : (
          <ul className="-mt-3">
            {agents.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-row">
                <a href={href({ view: "agent", id: a.id })} className="min-w-0 font-semibold [overflow-wrap:anywhere] text-ink hover:underline">
                  {shortName(a)}
                </a>
                <State state={states.get(a.id) ?? "gone"} person={a.person} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Limits" as="h3">
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-row">
          <dt className="text-ink-3">Folders</dt>
          <dd>
            <Folders roots={h.roots} />
          </dd>
          <dt className="text-ink-3">At most</dt>
          <dd>
            {MODE_LABEL[h.maxPermissionMode]} <code className="text-small text-ink-3">{h.maxPermissionMode}</code>
          </dd>
          <dt className="text-ink-3">Host ID</dt>
          <dd>
            <code className="text-small [overflow-wrap:anywhere]">{h.id}</code>
          </dd>
        </dl>
      </Section>
    </aside>
  );
}
