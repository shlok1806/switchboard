import { useMemo } from "react";
import type { Agent, Presence, Task } from "@shared/index";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannel, useIndex } from "@/data/store";
import { Status, StatusIndicator, StatusLabel } from "@/components/kibo-ui/status";
import { AgentLink, RawBadge, StalePill, TaskLink } from "@/components/domain/pills";
import { CLI_LABEL, PRESENCE_LABEL, ago } from "@/lib/format";
import { go } from "@/lib/router";

const KIBO_STATUS: Record<Presence, "online" | "degraded" | "offline"> = {
  live: "online",
  idle: "degraded",
  gone: "offline",
};

const ORDER: Record<Presence, number> = { live: 0, idle: 1, gone: 2 };

export function PresenceStatus({ presence }: { presence: Presence }) {
  return (
    <Status status={KIBO_STATUS[presence]} className="h-5 gap-1.5 bg-inset px-2 text-[11.5px] font-medium text-ink-2 shadow-hairline">
      <StatusIndicator />
      <StatusLabel>{PRESENCE_LABEL[presence]}</StatusLabel>
    </Status>
  );
}

/** Every Claim each Agent holds, oldest first. One Agent may hold several. */
export function useClaimsOf() {
  const { tasks } = useChannel();
  return useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.claim?.holder.kind !== "agent") continue;
      const id = t.claim.holder.agentId;
      m.set(id, [...(m.get(id) ?? []), t]);
    }
    for (const list of m.values()) list.sort((a, b) => a.claim!.claimedAt.localeCompare(b.claim!.claimedAt));
    return m;
  }, [tasks]);
}

export function AgentsView() {
  const { agents, snapshot } = useChannel();
  const claimsOf = useClaimsOf();
  const { agentById } = useIndex();
  const sorted = [...agents].sort(
    (a, b) => ORDER[a.presence] - ORDER[b.presence] || a.person.localeCompare(b.person) || a.id.localeCompare(b.id),
  );
  const persons = snapshot?.persons ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-[12.5px] text-ink-3">
          {agents.filter((a) => a.presence === "live").length} Live, {agents.filter((a) => a.presence === "idle").length} Idle,{" "}
          {agents.filter((a) => a.presence === "gone").length} Gone across {persons.length} Persons. An Agent is Gone after about ten
          minutes of silence.
        </p>

        {/* desktop: a table */}
        <div className="hidden overflow-hidden rounded-card bg-surface shadow-card md:block">
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[9%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[11%]" />
              <col className="w-[28%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line">
                {["Agent", "Person", "CLI", "Presence", "Proxy mode", "Claims"].map((h) => (
                  <th key={h} className="px-3 py-2 text-[11.5px] font-medium text-ink-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => {
                const held = claimsOf.get(a.id) ?? [];
                return (
                  <tr
                    key={a.id}
                    onClick={() => go({ view: "agent", id: a.id })}
                    className="cursor-pointer border-b border-line-soft last:border-0 hover:bg-inset"
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex min-w-0 flex-col">
                        <AgentLink id={a.id} agent={agentById.get(a.id)} showNickname={false} />
                        <span className="truncate text-[12px] text-ink-3">{a.nickname ?? "No Nickname"}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-ink">{a.person}</td>
                    <td className="px-3 py-2.5 text-[13px] text-ink-2">{CLI_LABEL[a.cli]}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col items-start gap-0.5">
                        <PresenceStatus presence={a.presence} />
                        <span className="font-mono text-[10.5px] text-ink-3">{ago(a.lastSeenAt)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <ProxyMode agent={a} />
                    </td>
                    <td className="px-3 py-2.5">
                      <ClaimCell agent={a} tasks={held} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* phone: cards */}
        <ul className="flex flex-col gap-2 md:hidden">
          {sorted.map((a) => {
            const held = claimsOf.get(a.id) ?? [];
            return (
              <li key={a.id}>
                <div
                  role="link"
                  tabIndex={0}
                  onClick={() => go({ view: "agent", id: a.id })}
                  onKeyDown={(e) => e.key === "Enter" && go({ view: "agent", id: a.id })}
                  className="flex cursor-pointer flex-col gap-2 rounded-card bg-surface p-3 shadow-card active:bg-inset"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-[12.5px] text-ink">{a.id}</span>
                      <span className="text-[12px] text-ink-3">
                        {a.nickname ?? "No Nickname"} · {a.person} · {CLI_LABEL[a.cli]}
                      </span>
                    </div>
                    <PresenceStatus presence={a.presence} />
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-2">
                    <ClaimCell agent={a} tasks={held} />
                    <ProxyMode agent={a} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ProxyMode({ agent }: { agent: Agent }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
      {agent.proxyMode === "raw" ? <RawBadge /> : <span>Digest</span>}
    </span>
  );
}

function ClaimCell({ agent, tasks }: { agent: Agent; tasks: Task[] }) {
  if (!tasks.length) return <span className="text-[12.5px] text-ink-3">No Claim</span>;
  const [first, ...rest] = tasks;
  const stale = tasks.some((t) => t.claim?.stale) && agent.presence === "gone";
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TaskLink number={first.number} title={first.title} className="min-w-0 text-[12.5px] text-ink" />
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 rounded-[4px] bg-inset px-1.5 font-mono text-[11px] text-ink-2 shadow-hairline hover:bg-hover"
              aria-label={`${tasks.length} Claims: ${tasks.map((t) => `#${t.number}`).join(", ")}`}
            >
              +{rest.length}
            </button>
          </TooltipTrigger>
          <TooltipContent className="flex flex-col gap-0.5">
            <span className="font-medium">{tasks.length} Claims</span>
            {rest.map((t) => (
              <span key={t.number}>
                #{t.number} {t.title}
              </span>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
      {stale && <StalePill className="shrink-0" />}
    </span>
  );
}
