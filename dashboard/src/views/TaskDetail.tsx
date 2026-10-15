import { useCallback, useMemo, useState } from "react";
import { CircleCheck, Circle, ExternalLink, GitBranch, GitPullRequest } from "lucide-react";
import type { ChannelEvent, EventType } from "@shared/index";
import { useCapabilities, useChannel, useIndex } from "@/data/store";
import { IssueLink } from "@/components/domain/pending";
import { IssueBody } from "@/components/domain/issue-body";
import { SegmentedControl } from "@/components/atoms/SegmentedControl";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import {
  Snippet,
  SnippetCopyButton,
  SnippetHeader,
  SnippetTabsContent,
} from "@/components/kibo-ui/snippet";
import { AgentLink, CaptureIcon, PresencePill, TaskLink, VerdictTally } from "@/components/domain/pills";
import { COLUMN_LABEL, Progress, columnOf, stepProgress, subtaskProgress } from "@/components/domain/task";
import { ClaimAction } from "@/components/domain/claim";
import { TakeoverAction } from "@/components/domain/takeover";
import { EventBody } from "@/components/domain/event";
import { OlderRow } from "@/components/domain/older";
import { useScopedHistory } from "@/data/history";
import { VerdictTable } from "@/components/domain/verdict";
import { Composer } from "@/components/domain/composer";
import { EVENT_TYPE_LABEL, ago, clock, summarize } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Section } from "@/components/shell/section";
import { StatusPill } from "@/components/atoms/StatusPill";

const WORK: EventType[] = [
  "claim",
  "claim.refused",
  "claim.release",
  "takeover",
  "update",
  "directive",
  "push",
  "merge",
  "task.branch",
  "task.review",
  "step.complete",
  "task.done",
  "task.create",
  "task.change",
  "task.reopen",
  "task.remove",
  "mirror.failed",
];

const SCOPES = ["Work", "All"] as const;

const DOT: Partial<Record<EventType, string>> = {
  claim: "bg-accent",
  takeover: "bg-red",
  push: "bg-green",
  merge: "bg-green",
  "task.review": "bg-green",
  update: "bg-ink-2",
  "step.complete": "bg-accent",
  "claim.refused": "bg-orange",
};

const COLUMN_TONE = { stale: "red", open: "neutral", claimed: "accent", review: "orange", done: "green" } as const;

export function TaskDetail({ number }: { number: number }) {
  const { snapshot } = useChannel();
  const can = useCapabilities();
  const { agentById, taskByNumber } = useIndex();
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("Work");
  const task = taskByNumber.get(number);
  const threshold = snapshot?.relay.interruptThreshold ?? 0.6;

  const onTask = useCallback((e: ChannelEvent) => e.task === number, [number]);
  const scoped = useScopedHistory({ task: number }, onTask);
  const timeline = useMemo(
    () =>
      scoped.events
        .filter((e) => scope === "All" || WORK.includes(e.type))
        .slice()
        .reverse(),
    [scoped.events, scope],
  );

  if (!task) {
    return (
      <div className="p-6 text-body text-ink-2">
        No Task #{number}. <a href={href({ view: "tasks" })} className="text-accent-ink hover:underline">Back to the Board</a>
      </div>
    );
  }

  const steps = stepProgress(task);
  const subs = subtaskProgress(task);
  const col = columnOf(task);
  const holderAgent = task.claim?.holder.kind === "agent" ? agentById.get(task.claim.holder.agentId) : undefined;
  // `status:*` labels mirror the status pill above (ADR 0001), so they are left out, as on the board.
  const labels = task.labels.filter((l) => !l.startsWith("status:"));
  const blocked = task.blockedBy.map((n) => taskByNumber.get(n)).filter(Boolean);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 px-[var(--gutter)] pt-6 pb-12 sm:pt-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="rise flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-small text-ink-3">
              <StatusPill tone={COLUMN_TONE[col]} className="h-6 text-small">
                {COLUMN_LABEL[col]}
              </StatusPill>
              <span className="tabular-nums">#{task.number}</span>
              {task.parent && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  in <TaskLink number={task.parent} title={taskByNumber.get(task.parent)?.title} className="min-w-0 text-ink-2" />
                </span>
              )}
              <a href={task.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-ink-3 hover:text-accent-ink">
                GitHub <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
            <h1 className="max-w-[var(--column)] text-title font-semibold text-ink [overflow-wrap:anywhere] sm:text-display">{task.title}</h1>
            <IssueBody text={task.description} />
            {labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => (
                  <span key={l} className="rounded-sm bg-hover px-2 text-small leading-6 text-ink-2">
                    {l}
                  </span>
                ))}
              </div>
            )}
          </header>

          {task.steps.length > 0 && (
            <Section title="Steps" action={<Progress done={steps.done} total={steps.total} noun="" />}>
              <ul className="flex flex-col gap-2">
                {task.steps.map((s) => (
                  <li key={s.index} className="flex items-start gap-2.5 text-body">
                    {s.done ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-green" aria-label="Done" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-ink-3" aria-label="Not done" />
                    )}
                    <span className={s.done ? "text-ink-3 line-through" : "text-ink"}>{s.text}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.subtasks.length > 0 && (
            <Section title="Subtasks" action={<Progress done={subs.done} total={subs.total} noun="" />} bodyClassName="px-1.5 pb-1.5">
              <ul>
                {task.subtasks.map((n) => {
                  const s = taskByNumber.get(n);
                  if (!s) return null;
                  const sp = stepProgress(s);
                  return (
                    <li key={n}>
                      <a
                        href={href({ view: "task", number: n })}
                        className="flex min-h-10 items-center gap-3 rounded-md px-2.5 hover:bg-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-body text-ink">
                          <span className="text-small text-ink-3 tabular-nums">#{n}</span> {s.title}
                        </span>
                        {sp.total > 0 && <Progress done={sp.done} total={sp.total} noun="" />}
                        <StatusPill tone={COLUMN_TONE[columnOf(s)]} className="h-5 px-2 text-small">
                          {COLUMN_LABEL[columnOf(s)]}
                        </StatusPill>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <section className="rise flex flex-col gap-3 [--i:2]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lead font-semibold text-ink">Timeline</h2>
              <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
            </div>
            {timeline.length === 0 && !scoped.more ? (
              <p className="text-body text-ink-3">{scoped.loading ? "Loading" : "Nothing yet"}</p>
            ) : (
              <ol className="relative flex flex-col">
                <span aria-hidden className="absolute top-3 bottom-3 left-[3px] w-[3px] rounded-full bg-hover-2" />
                {timeline.map((e) => (
                  <TimelineItem key={e.id} event={e} threshold={threshold} />
                ))}
                {/* At the line's end, under the items' text (the dot's 9px and the gap's 12px). */}
                {scoped.more && <OlderRow loading={scoped.loading} onClick={scoped.loadOlder} className="pl-[21px]" />}
              </ol>
            )}
          </section>
        </div>

        {/* On a phone the aside's parts join the page's column, so the Claim card alone
            leads when a Stale Claim needs a Takeover; the rest stays after the Task. */}
        <aside className="rise flex min-w-0 flex-col gap-4 [--i:1] max-lg:contents lg:sticky lg:top-8 lg:self-start">
          <Section
            title={task.claim?.stale ? "Stale Claim" : "Claim"}
            tone={task.claim?.stale ? "alert" : undefined}
            className={cn(task.claim?.stale && "max-lg:order-first")}
            bodyClassName="flex flex-col gap-3"
          >
            {task.claim ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {task.claim.holder.kind === "agent" ? (
                    <AgentLink id={task.claim.holder.agentId} agent={holderAgent} />
                  ) : (
                    <span className="text-body font-medium text-ink">{task.claim.holder.person}</span>
                  )}
                  {holderAgent && <PresencePill presence={holderAgent.presence} />}
                </div>
                <p className="text-small text-ink-3">Claimed {ago(task.claim.claimedAt)}</p>
                <TakeoverAction task={task} />
              </>
            ) : (
              <>
                <p className="text-small text-ink-3">
                  {task.status === "done" ? (
                    "Done"
                  ) : can.claims ? (
                    "Unclaimed"
                  ) : (
                    <>Claims arrive with <IssueLink capability="claims" />.</>
                  )}
                </p>
                <ClaimAction task={task} />
              </>
            )}
          </Section>

          {blocked.length > 0 && (
            <Section title="Blocked by" tone="alert" bodyClassName="flex flex-col gap-2">
              {blocked.map((b) => (
                <TaskLink key={b!.number} number={b!.number} title={b!.title} className="text-body text-ink" />
              ))}
            </Section>
          )}

          {(task.branch || task.pr) && (
            <section className="flex flex-col gap-2">
              {task.branch && (
                <Snippet defaultValue="switch">
                  <SnippetHeader>
                    <span className="flex items-center gap-1.5 text-small font-medium">
                      <GitBranch className="size-3.5" aria-hidden /> Branch
                    </span>
                    <SnippetCopyButton value={`git fetch && git switch ${task.branch}`} aria-label="Copy command" />
                  </SnippetHeader>
                  <SnippetTabsContent value="switch">
                    git switch {task.branch}
                  </SnippetTabsContent>
                </Snippet>
              )}
              {task.pr && (
                <p className="flex items-center gap-1.5 text-small text-ink-2">
                  <GitPullRequest className="size-3.5" aria-hidden /> PR <span className="tabular-nums">#{task.pr}</span>
                </p>
              )}
            </section>
          )}

          {task.status !== "done" && <Composer task={task.number} />}
        </aside>
      </div>
    </div>
  );
}

function TimelineItem({ event: e, threshold }: { event: ChannelEvent; threshold: number }) {
  const { verdictsByEvent } = useChannel();
  const { agentById } = useIndex();
  const verdicts = verdictsByEvent.get(e.id) ?? [];
  const asked = verdicts.filter((v) => v.source === "jev");
  return (
    <li className="relative grid grid-cols-[9px_minmax(0,1fr)] gap-3 py-2">
      <span aria-hidden className={cn("relative z-10 mt-1.5 size-[9px] rounded-full ring-4 ring-page", DOT[e.type] ?? "bg-ink-4")} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body font-medium text-ink">{EVENT_TYPE_LABEL[e.type]}</span>
          {e.actor.kind === "agent" ? (
            <AgentLink id={e.actor.agentId} agent={agentById.get(e.actor.agentId)} />
          ) : (
            <span className="text-small text-ink-2">{e.actor.kind === "person" ? e.actor.person : "GitHub"}</span>
          )}
          <CaptureIcon event={e} />
          <time className="ml-auto text-small text-ink-3 tabular-nums" title={clock(e.at)}>
            {ago(e.at)}
          </time>
        </div>
        {e.type === "push" || e.type === "merge" || e.type === "takeover" ? (
          <>
            <p className="max-w-[68ch] text-body text-ink-2">{summarize(e)}</p>
            <Reasoning>
              <ReasoningTrigger className="text-small text-ink-3">
                {e.type === "push" || e.type === "merge" ? `${e.payload.files.length} ${e.payload.files.length === 1 ? "file" : "files"}` : "Hand-off"}
              </ReasoningTrigger>
              <ReasoningContent contentClassName="mt-2 max-w-none">
                <EventBody event={e} />
              </ReasoningContent>
            </Reasoning>
          </>
        ) : (
          <p className={cn("max-w-[68ch] text-body leading-snug", e.type === "update" ? "text-ink" : "text-ink-2")}>{summarize(e)}</p>
        )}
        {asked.length > 0 && (
          <Reasoning>
            <ReasoningTrigger className="text-small text-ink-3">
              <span className="flex items-center gap-2">
                Verdicts <VerdictTally verdicts={verdicts} />
              </span>
            </ReasoningTrigger>
            <ReasoningContent contentClassName="mt-2 max-w-none">
              <VerdictTable verdicts={verdicts} agentById={agentById} threshold={threshold} />
            </ReasoningContent>
          </Reasoning>
        )}
      </div>
    </li>
  );
}
