import { useMemo } from "react";
import type { Agent, Presence, Task } from "@shared/index";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCapabilities, useChannel } from "@/data/store";
import { IssueLink, Pending } from "@/components/domain/pending";
import { Status, StatusIndicator, StatusLabel } from "@/components/kibo-ui/status";
import { AccountLabel, PresenceDot, RawBadge, StalePill, TaskLink } from "@/components/domain/pills";
import { CLI_LABEL, PRESENCE_LABEL, ago } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";

const KIBO_STATUS: Record<Presence, "online" | "degraded" | "offline"> = {
  live: "online",
  idle: "degraded",
  gone: "offline",
};

const ORDER: Record<Presence, number> = { live: 0, idle: 1, gone: 2 };

export function PresenceStatus({ presence }: { presence: Presence }) {
  return (
    <Status status={KIBO_STATUS[presence]} className="h-6 gap-1.5 border-0 bg-transparent px-0 text-[13px] font-medium text-ink">
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
  const { agents } = useChannel();
  const claimsOf = useClaimsOf();
  const sorted = [...agents].sort(
    (a, b) => ORDER[a.presence] - ORDER[b.presence] || a.person.localeCompare(b.person) || a.id.localeCompare(b.id),
  );
  const can = useCapabilities();

  if (agents.length === 0) {
    return (
      <Pending title={can.agents ? "No Agents yet" : "Agents are not on this Channel yet"} className="h-full">
        {can.agents ? (
          <>
            Run <code className="font-mono text-ink-2">switchboard run claude</code> to add one.
          </>
        ) : (
          <>
            Agents appear once <IssueLink capability="agents" /> lands.
          </>
        )}
      </Pending>
    );
  }

  const n = (p: Presence) => agents.filter((a) => a.presence === p).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 sm:py-8">
        <div className="flex items-center gap-4 text-[13px] text-ink-2" aria-label="Presence counts">
          {(["live", "idle", "gone"] as const).map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5">
              <PresenceDot presence={p} />
              <span className="tabular-nums text-ink">{n(p)}</span> {PRESENCE_LABEL[p]}
            </span>
          ))}
        </div>

        {/* desktop: a table */}
        <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[30%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line text-[12.5px] text-ink-3">
                {["Agent", "Person", "CLI", "Proxy", "Claims"].map((h) => (
                  <th key={h} className="px-4 py-2.5 font-normal">
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
                    className={cn("cursor-pointer border-b border-line-soft transition-colors last:border-0 hover:bg-hover", a.presence === "gone" && "text-ink-3")}
                  >
                    <td className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PresenceDot presence={a.presence} />
                        <div className="flex min-w-0 flex-col">
                          <a
                            href={href({ view: "agent", id: a.id })}
                            onClick={(e) => e.stopPropagation()}
                            className="truncate font-mono text-[13px] text-ink hover:text-accent-ink"
                          >
                            {a.id}
                          </a>
                          <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3" title={`Last seen ${ago(a.lastSeenAt)}`}>
                            <span className="truncate">{a.nickname ?? ago(a.lastSeenAt)}</span>
                            {a.account && <AccountLabel account={a.account} className="flex min-w-0 shrink items-center gap-1" />}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[13.5px] text-ink-2">{a.person}</td>
                    <td className="px-4 py-3 text-[13.5px] text-ink-2">{CLI_LABEL[a.cli]}</td>
                    <td className="px-4 py-3">
                      <ProxyMode agent={a} />
                    </td>
                    <td className="px-4 py-3">
                      <ClaimCell agent={a} tasks={held} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* phone: a list */}
        <ul className="flex flex-col divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-surface md:hidden">
          {sorted.map((a) => {
            const held = claimsOf.get(a.id) ?? [];
            return (
              <li key={a.id}>
                <div
                  role="link"
                  tabIndex={0}
                  onClick={() => go({ view: "agent", id: a.id })}
                  onKeyDown={(e) => e.key === "Enter" && go({ view: "agent", id: a.id })}
                  className="flex cursor-pointer items-start gap-3 px-4 py-3 active:bg-hover"
                >
                  <PresenceDot presence={a.presence} className="mt-1" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate font-mono text-[13px] text-ink">{a.id}</span>
                      <ProxyMode agent={a} />
                    </div>
                    <span className="truncate text-[12.5px] text-ink-3">
                      {a.nickname ? `${a.nickname} · ` : ""}
                      {CLI_LABEL[a.cli]}
                      {a.account ? ` · ${a.account}` : ""}
                    </span>
                    {held.length > 0 && <ClaimCell agent={a} tasks={held} />}
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
  return agent.proxyMode === "raw" ? <RawBadge /> : <span className="text-[13px] text-ink-3">Digest</span>;
}

function ClaimCell({ agent, tasks }: { agent: Agent; tasks: Task[] }) {
  if (!tasks.length) return <span className="text-[13px] text-ink-3">None</span>;
  const [first, ...rest] = tasks;
  const stale = tasks.some((t) => t.claim?.stale) && agent.presence === "gone";
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TaskLink number={first.number} title={first.title} className="min-w-0 text-[13px] text-ink-2" />
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="h-5 shrink-0 rounded-full bg-hover px-1.5 font-mono text-[11.5px] text-ink-2"
              aria-label={`${tasks.length} Claims: ${tasks.map((t) => `#${t.number}`).join(", ")}`}
            >
              +{rest.length}
            </button>
          </TooltipTrigger>
          <TooltipContent className="flex flex-col gap-0.5">
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
