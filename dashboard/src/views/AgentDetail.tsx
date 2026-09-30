import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { AgentId, ProxyMode } from "@shared/index";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
import { IssueLink } from "@/components/domain/pending";
import { SegmentedControl } from "@/components/atoms/SegmentedControl";
import { RelativeTime, RelativeTimeZone, RelativeTimeZoneDate, RelativeTimeZoneDisplay, RelativeTimeZoneLabel } from "@/components/kibo-ui/relative-time";
import { EventRow } from "@/components/domain/event";
import { RawBadge, StalePill, TaskLink } from "@/components/domain/pills";
import { Composer } from "@/components/domain/composer";
import { PresenceStatus, useClaimsOf } from "./AgentsView";
import { CAPTURE_LABEL, CLI_LABEL, ago } from "@/lib/format";
import { go, href } from "@/lib/router";

const MODES = ["Digest", "Raw"] as const;
const CAPTURES = ["All", "Proxy", "Hook", "Tool"] as const;

import { GroupBox } from "@/components/shell/groupbox";

export function AgentDetail({ id }: { id: string }) {
  const store = useStore();
  const me = useMe();
  const { events, verdictsByEvent, snapshot, fresh } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const claimsOf = useClaimsOf();
  const can = useCapabilities();
  const agent = agentById.get(id as AgentId);
  const [capture, setCapture] = useState<(typeof CAPTURES)[number]>("All");

  const history = useMemo(
    () =>
      events
        .filter(
          (e) =>
            ((e.actor.kind === "agent" && e.actor.agentId === id) || (e.type === "directive" && e.payload.to === id)) &&
            (capture === "All" || (e.capture && CAPTURE_LABEL[e.capture] === capture)),
        )
        .slice()
        .reverse(),
    [events, id, capture],
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
      <div className="p-6 text-[13px] text-ink-2">
        No Agent {id} on this Channel. <a href={href({ view: "agents" })} className="text-accent-ink hover:underline">Back to Agents</a>
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
      <div className="mx-auto grid max-w-6xl gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <PresenceStatus presence={agent.presence} />
              {agent.proxyMode === "raw" && <RawBadge />}
              <span className="text-[12px] text-ink-3">Last seen {ago(agent.lastSeenAt)}</span>
            </div>
            <h1 className="glow font-mono text-[18px] font-bold text-accent-ink [overflow-wrap:anywhere] sm:text-[22px]">{agent.id}</h1>
            <p className="text-[13px] text-ink-2">
              {agent.nickname ? <span className="font-medium text-ink">{agent.nickname}</span> : "No Nickname"} · {CLI_LABEL[agent.cli]} ·
              run by {agent.person}
            </p>
          </header>

          <dl className="bevel-in grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            {[
              { k: "Events", v: <span className="tabular-nums">{events.filter((e) => e.actor.kind === "agent" && e.actor.agentId === agent.id).length}</span> },
              { k: "Interrupts heard", v: can.verdicts ? <span className="tabular-nums">{heard.i}</span> : <span className="text-[13px] text-ink-3">Relay pending</span> },
              { k: "Queued to it", v: can.verdicts ? <span className="tabular-nums">{heard.q}</span> : <span className="text-[13px] text-ink-3">Relay pending</span> },
              { k: "Session started", v: <span className="text-[13px]">{ago(agent.startedAt)}</span> },
            ].map((s) => (
              <div key={s.k} className="flex flex-col gap-0.5 bg-card px-3 py-2">
                <dt className="label-mono">{s.k}</dt>
                <dd className="font-mono text-[20px] leading-tight text-ink tabular-nums">{s.v}</dd>
              </div>
            ))}
          </dl>

          <section className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-1.5">
              <h2 className="type-label !text-ink">History</h2>
              <SegmentedControl options={CAPTURES} value={capture} onChange={setCapture} />
            </div>
            <ul className="bevel-in overflow-hidden bg-card">
              {history.length === 0 ? (
                <li className="px-4 py-6 text-center text-[12.5px] text-ink-3">No {capture === "All" ? "" : `${capture} `}Events yet.</li>
              ) : (
                history.map((e) => (
                  <EventRow
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
            </ul>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-0 lg:self-start">
          <GroupBox title={held.length > 1 ? `${held.length} Claims` : "Claim"} bodyClassName="flex flex-col gap-2">
            {held.length ? (
              <ul className="flex flex-col gap-1.5">
                {held.map((task) => (
                  <li key={task.number} className="flex flex-wrap items-center gap-1.5">
                    <TaskLink number={task.number} title={task.title} className="min-w-0 text-[13px] text-ink" />
                    {task.claim?.stale && <StalePill />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ink-3">
                {can.claims ? "No Claim" : <>Claims arrive with <IssueLink capability="claims" />.</>}
              </p>
            )}
          </GroupBox>

          <GroupBox title="Proxy mode" bodyClassName="flex flex-col gap-2">
            <SegmentedControl
              options={MODES}
              value={agent.proxyMode === "raw" ? "Raw" : "Digest"}
              onChange={(m) => void setMode(m)}
              className={mine && can.proxyMode ? "" : "pointer-events-none opacity-60"}
            />
            <p className="text-[12px] text-ink-3">
              {!can.proxyMode ? (
                <>Proxy Capture arrives with <IssueLink capability="proxyMode" />.</>
              ) : mine ? (
                "Raw shares full model turns, context included. Secrets are masked either way."
              ) : (
                `Only ${agent.person} can change this.`
              )}
              {agent.secretMasking ? "" : " Secret masking is off."}
            </p>
          </GroupBox>

          {person && (
            <GroupBox title={`${agent.person}'s local time`} bodyClassName="flex flex-col gap-2">
              <RelativeTime className="flex flex-col gap-1 text-[12.5px]" dateFormatOptions={{ weekday: "short", day: "numeric", month: "short" }} timeFormatOptions={{ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }}>
                <RelativeTimeZone zone={person.timeZone} className="flex items-center justify-start gap-2 text-[12.5px]">
                  <RelativeTimeZoneLabel className="bevel-thin-in h-5 bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
                    {person.timeZone.split("/").pop()?.replace("_", " ")}
                  </RelativeTimeZoneLabel>
                  <RelativeTimeZoneDisplay className="pl-0 font-mono tabular-nums text-ink" />
                  <span className="text-ink-3"><RelativeTimeZoneDate /></span>
                </RelativeTimeZone>
              </RelativeTime>
            </GroupBox>
          )}

          {!can.directives ? (
            <p className="bevel-in bg-card p-3 text-[12.5px] text-ink-3">
              Directives to this Agent arrive with <IssueLink capability="directives" />.
            </p>
          ) : agent.presence !== "gone" ? (
            <Composer defaultAgent={agent.id} className="bevel-out" />
          ) : (
            <p className="bevel-in bg-card p-3 text-[12.5px] text-ink-3">
              This Agent is Gone, so a Directive would wait until it resumes.
            </p>
          )}
          {can.verdicts && !agent.canReceiveInterrupts && (
            <p className="text-[12px] text-ink-3">
              {CLI_LABEL[agent.cli]} cannot receive Interrupts. They arrive as Queue, labelled as downgraded.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
