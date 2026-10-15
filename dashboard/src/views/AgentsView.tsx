import { PendingApproval } from "@/components/domain/approval";
import { AgentBrief, ContextWindow } from "@/components/domain/context";
import { useMemo } from "react";
import { Server } from "lucide-react";
import type { Agent, Cli, Presence, Task } from "@shared/index";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCapabilities, useChannel } from "@/data/store";
import { IssueLink, Pending } from "@/components/domain/pending";
import { AccountLabel, ModelLabel, PresenceDot, RawBadge, StalePill, TaskLink } from "@/components/domain/pills";
import { AgentUsage, AccountsPanel } from "@/components/domain/usage";
import { PageHead } from "@/components/shell/page-head";
import { StartAgentButton, useHostsSupported } from "@/components/domain/start-agent";
import { LeadLabel } from "@/components/domain/agent-role";
import { CLI_LABEL, PRESENCE_LABEL, ago } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";

const ORDER: Record<Presence, number> = { live: 0, idle: 1, gone: 2 };

/** Presence as its dot and its name. */
export function PresenceStatus({ presence }: { presence: Presence }) {
  return (
    <span className="inline-flex h-6 items-center gap-2 text-body font-medium text-ink">
      <PresenceDot presence={presence} />
      {PRESENCE_LABEL[presence]}
    </span>
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

/** Where a Host runs the Agent (ADR 0015): no terminal, so this is where to look for it. */
export function HostLabel({ host }: { host: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={`Started by a Host, with no terminal: ${host}`}>
      <Server className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{host.slice(host.indexOf("/") + 1)}</span>
    </span>
  );
}

const CLI_TONE: Record<Cli, string> = { "claude-code": "bg-cli-claude", codex: "bg-cli-codex", gemini: "bg-cli-gemini" };

/** The colour of an Agent's CLI (the canvas spec's colour per CLI), as a small square beside its name. */
export function CliSwatch({ agent, className }: { agent: Agent; className?: string }) {
  return <span aria-hidden title={CLI_LABEL[agent.cli]} className={cn("inline-block size-2 shrink-0 rounded-[2px]", CLI_TONE[agent.cli], className)} />;
}

export function AgentsView() {
  const { agents } = useChannel();
  const claimsOf = useClaimsOf();
  const sorted = [...agents].sort(
    (a, b) => ORDER[a.presence] - ORDER[b.presence] || a.person.localeCompare(b.person) || a.id.localeCompare(b.id),
  );
  const can = useCapabilities();
  const hosts = useHostsSupported();

  if (agents.length === 0) {
    return (
      <Pending title={can.agents ? "No Agents yet" : "Agents are not on this Channel yet"} className="h-full">
        {can.agents ? (
          // Shown once the Channel says whether it has Hosts, so the text never changes under the reader.
          hosts !== null && (
            <>
              Run <code className="font-mono text-ink-2">switchboard run claude</code> to add one
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

  const n = (p: Presence) => agents.filter((a) => a.presence === p).length;
  const groups = (["live", "idle", "gone"] as const).filter((p) => n(p) > 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-[var(--gutter)] pt-6 pb-12 sm:pt-8">
        <PageHead
          title="Agents"
          actions={<StartAgentButton />}
          summary={
            <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums" aria-label="Presence counts">
              {(["live", "idle", "gone"] as const).map((p) => (
                <span key={p} className="inline-flex items-center gap-2">
                  <PresenceDot presence={p} />
                  <span>
                    <span className="text-ink">{n(p)}</span> {PRESENCE_LABEL[p]}
                  </span>
                </span>
              ))}
            </span>
          }
        />
        <div className="rise [--i:1]">
          <AccountsPanel />
        </div>

        {groups.map((p, gi) => (
          <section key={p} aria-label={PRESENCE_LABEL[p]} className="rise flex flex-col gap-1" style={{ ["--i" as string]: gi + 2 }}>
            <h2 className="flex items-baseline gap-2 pb-1 text-body text-ink-3">
              {PRESENCE_LABEL[p]} <span className="tabular-nums">{n(p)}</span>
            </h2>
            {/* desk: the column headings, once per group */}
            <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_12rem_16rem] gap-6 pb-1 text-small text-ink-3 lg:grid">
              <span>Agent</span>
              <span>Context window</span>
              <span>Claims</span>
            </div>
            {/* rows reach past the column by their own padding, so their text sits on it */}
            <ul className="-mx-3 flex flex-col">
              {sorted
                .filter((a) => a.presence === p)
                .map((a) => (
                  <AgentRow key={a.id} agent={a} held={claimsOf.get(a.id) ?? []} />
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function AgentRow({ agent: a, held }: { agent: Agent; held: Task[] }) {
  return (
    <li>
      <div
        role="link"
        tabIndex={0}
        onClick={() => go({ view: "agent", id: a.id })}
        onKeyDown={(e) => e.key === "Enter" && go({ view: "agent", id: a.id })}
        className={cn(
          "grid cursor-pointer gap-x-6 gap-y-4 rounded-md px-3 py-4 transition-colors duration-150 hover:bg-inset focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent lg:grid-cols-[minmax(0,1fr)_12rem_16rem]",
          a.presence === "gone" && "opacity-75",
        )}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <a
              href={href({ view: "agent", id: a.id })}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex min-w-0 items-center gap-2 text-lead font-medium text-ink tabular-nums underline-offset-4 hover:underline"
            >
              <CliSwatch agent={a} />
              <span className="truncate">{a.id}</span>
            </a>
            {a.nickname && <span className="text-body text-ink-2">{a.nickname}</span>}
            {a.proxyMode === "raw" && <RawBadge />}
          </div>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3" title={`Last seen ${ago(a.lastSeenAt)}`}>
            <span>{CLI_LABEL[a.cli]}</span>
            <span>{a.person}</span>
            {a.host && <HostLabel host={a.host} />}
            {a.role === "lead" && <LeadLabel />}
            {a.account && !a.usage?.email && <AccountLabel account={a.account} className="flex min-w-0 shrink items-center gap-1" />}
            {a.model && <ModelLabel model={a.model} effort={a.effort} className="flex min-w-0 shrink items-center gap-1" />}
          </span>
          <PendingApproval agent={a} />
          <AgentBrief agent={a} compact />
          {a.usage && <AgentUsage agent={a} compact />}
        </div>
        <ContextWindow agent={a} compact />
        <ClaimCell agent={a} tasks={held} />
      </div>
    </li>
  );
}

function ClaimCell({ agent, tasks }: { agent: Agent; tasks: Task[] }) {
  if (!tasks.length) return <span className="text-small text-ink-3 max-lg:hidden">No Claim</span>;
  const [first, ...rest] = tasks;
  const stale = tasks.some((t) => t.claim?.stale) && agent.presence === "gone";
  return (
    <span className="flex min-w-0 items-start gap-2">
      <TaskLink number={first.number} title={first.title} className="min-w-0 text-body text-ink-2" />
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="h-6 shrink-0 rounded-sm bg-hover px-1.5 text-small font-medium text-ink-2 tabular-nums"
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
