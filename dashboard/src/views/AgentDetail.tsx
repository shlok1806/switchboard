import { PendingApproval } from "@/components/domain/approval";
import { AgentBrief, ContextWindow } from "@/components/domain/context";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, ChannelEvent, ProxyMode } from "@shared/index";
import { MAX_NICKNAME_LENGTH } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
import { IssueLink } from "@/components/domain/pending";
import { SegmentedControl } from "@/components/atoms/SegmentedControl";
import { RelativeTime, RelativeTimeZone, RelativeTimeZoneDate, RelativeTimeZoneDisplay, RelativeTimeZoneLabel } from "@/components/kibo-ui/relative-time";
import { EventRow } from "@/components/domain/event";
import { OlderRow } from "@/components/domain/older";
import { useScopedHistory } from "@/data/history";
import { RawBadge, StalePill, TaskLink } from "@/components/domain/pills";
import { Composer } from "@/components/domain/composer";
import { CliSwatch, HostLabel, PresenceStatus, useClaimsOf } from "./AgentsView";
import { StopAgentButton } from "@/components/domain/start-agent";
import { LeadButton, LeadLabel } from "@/components/domain/agent-role";
import { CAPTURE_LABEL, CLI_LABEL, ago } from "@/lib/format";
import { go, href } from "@/lib/router";

const MODES = ["Digest", "Raw"] as const;
const CAPTURES = ["All", "Proxy", "Hook", "Tool"] as const;

import { Section } from "@/components/shell/section";
import NumberFlow from "@number-flow/react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountLabel, ActorAvatar, AgentLink, ModelLabel } from "@/components/domain/pills";
import { AgentUsage } from "@/components/domain/usage";

/** Newest first here, so a group is the same sender within two minutes going back. */
function sameSender(prev: ChannelEvent, e: ChannelEvent) {
  return prev.actor.kind === "agent" && e.actor.kind === "agent" && prev.actor.agentId === e.actor.agentId && e.type !== "directive" && prev.type !== "directive" && Math.abs(Date.parse(prev.at) - Date.parse(e.at)) < 120_000;
}

export function AgentDetail({ id }: { id: string }) {
  const store = useStore();
  const me = useMe();
  const { verdictsByEvent, snapshot, fresh, olderBefore } = useChannel();
  // Verdicts come with the Events they judge, so they too are only the loaded ones'.
  const verdictsPartial = olderBefore !== undefined;
  const { agentById, taskByNumber } = useIndex();
  const claimsOf = useClaimsOf();
  const can = useCapabilities();
  const agent = agentById.get(id as AgentId);
  const [capture, setCapture] = useState<(typeof CAPTURES)[number]>("All");

  const aboutAgent = useCallback(
    (e: ChannelEvent) =>
      (e.actor.kind === "agent" && e.actor.agentId === id) ||
      (e.type === "directive" && e.payload.to === id) ||
      // Renamed by a Person, or its name taken while it was Gone (ADR 0009).
      (e.type === "agent.rename" && e.payload.agent === id) ||
      // Stopped by its Person, on the Host that runs it (ADR 0015).
      (e.type === "agent.stop" && e.payload.agent === id),
    [id],
  );
  const scoped = useScopedHistory({ agent: id as AgentId }, aboutAgent);
  const history = useMemo(
    () =>
      scoped.events
        .filter((e) => capture === "All" || (e.capture && CAPTURE_LABEL[e.capture] === capture))
        .slice()
        .reverse(),
    [scoped.events, capture],
  );
  const own = useMemo(
    () => scoped.events.filter((e) => e.actor.kind === "agent" && e.actor.agentId === id).length,
    [scoped.events, id],
  );
  const heard = useMemo(() => {
    let i = 0;
    let q = 0;
    for (const vs of verdictsByEvent.values())
      for (const v of vs)
        if (v.agent === id) {
          if (v.option === "interrupt") i++;
          else if (v.option === "queue") q++;
        }
    return { i, q };
  }, [verdictsByEvent, id]);

  if (!agent) {
    return (
      <div className="p-6 text-body text-ink-2">
        No Agent {id}. <a href={href({ view: "agents" })} className="text-accent-ink underline underline-offset-4">Back to Agents</a>
      </div>
    );
  }

  const held = claimsOf.get(agent.id) ?? [];
  const person = snapshot?.persons.find((p) => p.name === agent.person);
  const mine = agent.person === me;

  const setMode = async (m: (typeof MODES)[number]) => {
    const mode: ProxyMode = m === "Raw" ? "raw" : "digest";
    const r = await store.source.act({ type: "proxy-mode", agent: agent.id, mode });
    if (!r.ok) toast.error(r.reason);
    else toast.success(`Proxy mode is now ${m.toLowerCase()}`);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 px-[var(--gutter)] pt-4 pb-12 sm:pt-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="rise flex items-start gap-4">
            <ActorAvatar actor={{ kind: "agent", agentId: agent.id }} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h1 className="flex min-w-0 items-center gap-2.5 text-title font-semibold text-ink tabular-nums [overflow-wrap:anywhere]">
                <CliSwatch agent={agent} className="size-2.5" />
                {agent.id}
              </h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-ink-3">
                <span title={`Last seen ${ago(agent.lastSeenAt)}`}>
                  <PresenceStatus presence={agent.presence} />
                </span>
                {agent.nickname && <span className="text-ink-2">{agent.nickname}</span>}
                <span>{CLI_LABEL[agent.cli]}</span>
                <span>{agent.person}</span>
                {agent.host && <HostLabel host={agent.host} />}
                {agent.role === "lead" && <LeadLabel />}
                {agent.parent && (
                  <span className="inline-flex min-w-0 items-baseline gap-1">
                    started by <AgentLink id={agent.parent} showNickname={false} className="[&>span]:text-small [&>span]:font-normal [&>span]:text-ink-2" />
                  </span>
                )}
                {agent.account && !agent.usage?.email && <AccountLabel account={agent.account} />}
                {agent.model && <ModelLabel model={agent.model} effort={agent.effort} />}
                {agent.proxyMode === "raw" && <RawBadge />}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              <LeadButton agent={agent} />
              <StopAgentButton agent={agent} />
            </div>
          </header>
          <PendingApproval agent={agent} className="rise [--i:1]" />

          <div className="rise grid gap-6 rounded-md bg-inset p-4 [--i:1] sm:grid-cols-[minmax(0,1fr)_13rem] sm:gap-8">
            <AgentBrief agent={agent} />
            <ContextWindow agent={agent} />
          </div>

          {agent.usage && (
            <Section title="Usage">
              <AgentUsage agent={agent} />
            </Section>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {[
              {
                k: "Events",
                // Only the Events loaded so far: counting them all would read the whole history.
                v: <LoadedCount value={own} partial={scoped.more} />,
              },
              { k: "Interrupts", v: can.verdicts ? <LoadedCount value={heard.i} partial={verdictsPartial} /> : <span className="text-ink-3">-</span> },
              { k: "Queued", v: can.verdicts ? <LoadedCount value={heard.q} partial={verdictsPartial} /> : <span className="text-ink-3">-</span> },
              { k: "Started", v: ago(agent.startedAt) },
            ].map((s) => (
              <div key={s.k} className="flex flex-col-reverse gap-1">
                <dt className="text-small text-ink-3">{s.k}</dt>
                <dd className="flex h-8 items-center text-title leading-none font-medium text-ink tabular-nums">{s.v}</dd>
              </div>
            ))}
          </dl>

          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lead font-medium text-ink">History</h2>
              <SegmentedControl options={CAPTURES} value={capture} onChange={setCapture} />
            </div>
            <ul className="-mx-3 flex flex-col">
              {history.length === 0 ? (
                <li className="px-3 py-6 text-body text-ink-3">{scoped.loading ? "Loading" : "Nothing yet"}</li>
              ) : (
                history.map((e, i) => (
                  <EventRow
                    continued={i > 0 && sameSender(history[i - 1], e)}
                    key={e.id}
                    event={e}
                    verdicts={verdictsByEvent.get(e.id) ?? []}
                    agentById={agentById}
                    taskByNumber={taskByNumber}
                    selected={false}
                    fresh={fresh.has(e.id)}
                    onSelect={() => go({ view: "feed", event: e.id })}
                  />
                ))
              )}
              {scoped.more && <OlderRow loading={scoped.loading} onClick={scoped.loadOlder} className="px-3" />}
            </ul>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          {!can.directives ? (
            <p className="rounded-md bg-inset p-4 text-small text-ink-3">
              Directives arrive with <IssueLink capability="directives" />.
            </p>
          ) : agent.presence !== "gone" ? (
            <Composer key={agent.id} defaultAgent={agent.id} />
          ) : (
            <p className="rounded-md bg-inset p-4 text-small text-ink-3">Gone. A Directive waits until it resumes.</p>
          )}

          <RenameSection agent={agent} />

          <Section title={held.length > 1 ? `Claims · ${held.length}` : "Claim"} bodyClassName="flex flex-col gap-2">
            {held.length ? (
              <ul className="flex flex-col gap-2">
                {held.map((task) => (
                  <li key={task.number} className="flex flex-wrap items-center gap-1.5">
                    <TaskLink number={task.number} title={task.title} className="min-w-0 text-body text-ink" />
                    {task.claim?.stale && <StalePill />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-small text-ink-3">{can.claims ? "None" : <>Claims arrive with <IssueLink capability="claims" />.</>}</p>
            )}
          </Section>

          <Section
            title="Proxy mode"
            action={
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="About Proxy mode" className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors hover:text-ink">
                    <Info className="size-3.5" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {!can.proxyMode
                    ? "Arrives with Proxy Capture."
                    : "Raw shares full model turns, context included. Secrets are masked either way."}
                  {mine || !can.proxyMode ? "" : ` Only ${agent.person} can change it.`}
                </TooltipContent>
              </Tooltip>
            }
            bodyClassName="flex flex-col gap-2"
          >
            <SegmentedControl
              options={MODES}
              value={agent.proxyMode === "raw" ? "Raw" : "Digest"}
              onChange={(m) => void setMode(m)}
              className={mine && can.proxyMode ? "w-full" : "pointer-events-none w-full opacity-60"}
            />
            {!agent.secretMasking && <p className="text-small text-orange">Secret masking is off</p>}
            {!can.proxyMode && (
              <p className="text-small text-ink-3">
                Arrives with <IssueLink capability="proxyMode" />.
              </p>
            )}
          </Section>

          {person && (
            <Section title="Local time" bodyClassName="flex flex-col gap-2">
              <RelativeTime className="flex flex-col gap-1 text-small" dateFormatOptions={{ weekday: "short", day: "numeric", month: "short" }} timeFormatOptions={{ hour: "2-digit", minute: "2-digit", hour12: false }}>
                <RelativeTimeZone zone={person.timeZone} className="flex items-center justify-start gap-2 text-small">
                  <RelativeTimeZoneDisplay className="pl-0 text-lead font-medium text-ink tabular-nums" />
                  <span className="text-ink-3">
                    <RelativeTimeZoneDate />
                  </span>
                  <RelativeTimeZoneLabel className="ml-auto h-6 rounded-sm bg-hover px-2 text-small text-ink-3">
                    {person.timeZone.split("/").pop()?.replace("_", " ")}
                  </RelativeTimeZoneLabel>
                </RelativeTimeZone>
              </RelativeTime>
            </Section>
          )}

          {can.verdicts && !agent.canReceiveInterrupts && (
            <p className="flex items-start gap-2 text-small text-ink-3">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {CLI_LABEL[agent.cli]} gets Interrupts as Queue.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Renames the Agent while it runs (ADR 0009). Anyone on the Channel may; the Agent ID
 * never changes, and the rename shows in the history as old → new.
 */
function RenameSection({ agent }: { agent: Agent }) {
  const store = useStore();
  const [name, setName] = useState(agent.nickname ?? "");
  const [busy, setBusy] = useState(false);
  // Someone else renamed it meanwhile: show the Channel's name.
  useEffect(() => setName(agent.nickname ?? ""), [agent.nickname]);
  const changed = name.trim() !== (agent.nickname ?? "");

  const save = async (nickname: string | null) => {
    setBusy(true);
    const r = await store.source.act({ type: "rename", agent: agent.id, nickname });
    setBusy(false);
    if (!r.ok) toast.error(r.reason);
    else toast.success(nickname ? `${agent.id} is now ${nickname.trim()}` : `${agent.id} has no Nickname now`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed) void save(name.trim() || null);
  };

  return (
    <Section
      title="Nickname"
      action={
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="About Nicknames" className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors hover:text-ink">
              <Info className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>Anyone on the Channel can rename an Agent while it runs. Its Agent ID never changes, and Nicknames are unique.</TooltipContent>
        </Tooltip>
      }
      bodyClassName="flex flex-col gap-2"
    >
      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          aria-label="Nickname"
          placeholder="No Nickname"
          maxLength={MAX_NICKNAME_LENGTH}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-field px-3 text-body text-ink outline-none placeholder:text-ink-3 focus-visible:border-accent max-md:text-[16px]"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!changed || busy} className="h-9">
          Rename
        </Button>
      </form>
      {agent.nickname && (
        <button type="button" onClick={() => void save(null)} disabled={busy} className="self-start text-small text-ink-3 underline-offset-4 transition-colors hover:text-ink hover:underline">
          Clear Nickname
        </button>
      )}
    </Section>
  );
}

/**
 * A count over the Events loaded so far, with a "+" when the Channel has older ones:
 * counting them all would read the whole history.
 */
function LoadedCount({ value, partial }: { value: number; partial: boolean }) {
  return (
    <span title={partial ? "Counted over the latest Events; there are older ones" : undefined}>
      <NumberFlow value={value} />
      {partial && <span className="text-ink-3">+</span>}
    </span>
  );
}
