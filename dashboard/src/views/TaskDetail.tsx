import { useMemo, useState } from "react";
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
  const { events, snapshot } = useChannel();
  const can = useCapabilities();
  const { agentById, taskByNumber } = useIndex();
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("Work");
  const task = taskByNumber.get(number);
  const threshold = snapshot?.relay.interruptThreshold ?? 0.6;

  const timeline = useMemo(
    () =>
      events
        .filter((e) => e.task === number && (scope === "All" || WORK.includes(e.type)))
        .slice()
        .reverse(),
    [events, number, scope],
  );

  if (!task) {
    return (
      <div className="p-6 text-[14px] text-ink-2">
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
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-5 sm:px-6 sm:py-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-6">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
              <StatusPill tone={COLUMN_TONE[col]} className="h-6 text-[12.5px]">
                {COLUMN_LABEL[col]}
              </StatusPill>
              <span className="font-mono">#{task.number}</span>
              {task.parent && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  in <TaskLink number={task.parent} title={taskByNumber.get(task.parent)?.title} className="min-w-0 text-ink-2" />
                </span>
              )}
              <a href={task.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-ink-3 hover:text-accent-ink">
                GitHub <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink [overflow-wrap:anywhere] sm:text-[26px]">{task.title}</h1>
            <IssueBody text={task.description} />
            {labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => (
                  <span key={l} className="rounded-full bg-hover px-2 py-0.5 text-[12px] text-ink-2">
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
                  <li key={s.index} className="flex items-start gap-2.5 text-[14px]">
                    {s.done ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-green" aria-label="Done" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-ink-4" aria-label="Not done" />
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
                        className="flex min-h-10 items-center gap-3 rounded-lg px-2.5 hover:bg-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                          <span className="font-mono text-[12.5px] text-ink-3">#{n}</span> {s.title}
                        </span>
                        {sp.total > 0 && <Progress done={sp.done} total={sp.total} noun="" />}
                        <StatusPill tone={COLUMN_TONE[columnOf(s)]} className="h-5 px-2 text-[11.5px]">
                          {COLUMN_LABEL[columnOf(s)]}
                        </StatusPill>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[15px] font-medium text-ink">Timeline</h2>
              <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
            </div>
            {timeline.length === 0 ? (
              <p className="text-[14px] text-ink-3">Nothing yet</p>
            ) : (
              <ol className="relative flex flex-col">
                <span aria-hidden className="absolute top-3 bottom-3 left-[4px] w-px bg-line" />
                {timeline.map((e) => (
                  <TimelineItem key={e.id} event={e} threshold={threshold} />
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* On a phone the Claim card leads only when a Stale Claim needs a Takeover. */}
        <aside
          className={cn(
            "flex min-w-0 flex-col gap-4 lg:sticky lg:top-8 lg:order-none lg:self-start",
            task.claim?.stale && "order-first",
          )}
        >
          <Section title={task.claim?.stale ? "Stale Claim" : "Claim"} tone={task.claim?.stale ? "alert" : undefined} bodyClassName="flex flex-col gap-3">
            {task.claim ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {task.claim.holder.kind === "agent" ? (
                    <AgentLink id={task.claim.holder.agentId} agent={holderAgent} />
                  ) : (
                    <span className="text-[13px] font-medium text-ink">{task.claim.holder.person}</span>
                  )}
                  {holderAgent && <PresencePill presence={holderAgent.presence} />}
                </div>
                <p className="text-[12.5px] text-ink-3">Claimed {ago(task.claim.claimedAt)}</p>
                <TakeoverAction task={task} />
              </>
            ) : (
              <>
                <p className="text-[13px] text-ink-3">
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
                <TaskLink key={b!.number} number={b!.number} title={b!.title} className="text-[13.5px] text-ink" />
              ))}
            </Section>
          )}

          {(task.branch || task.pr) && (
            <section className="flex flex-col gap-2">
              {task.branch && (
                <Snippet defaultValue="switch">
                  <SnippetHeader>
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
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
                <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <GitPullRequest className="size-3.5" aria-hidden /> PR <span className="font-mono">#{task.pr}</span>
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
          <span className="text-[13px] font-medium text-ink">{EVENT_TYPE_LABEL[e.type]}</span>
          {e.actor.kind === "agent" ? (
            <AgentLink id={e.actor.agentId} agent={agentById.get(e.actor.agentId)} />
          ) : (
            <span className="text-[13px] text-ink-2">{e.actor.kind === "person" ? e.actor.person : "GitHub"}</span>
          )}
          <CaptureIcon event={e} />
          <time className="ml-auto font-mono text-[11.5px] text-ink-3 tabular-nums" title={clock(e.at)}>
            {ago(e.at)}
          </time>
        </div>
        {e.type === "push" || e.type === "merge" || e.type === "takeover" ? (
          <>
            <p className="text-[13.5px] text-ink-2">{summarize(e)}</p>
            <Reasoning>
              <ReasoningTrigger className="text-[12.5px] text-ink-3">
                {e.type === "push" || e.type === "merge" ? `${e.payload.files.length} ${e.payload.files.length === 1 ? "file" : "files"}` : "Hand-off"}
              </ReasoningTrigger>
              <ReasoningContent contentClassName="mt-2 max-w-none">
                <EventBody event={e} />
              </ReasoningContent>
            </Reasoning>
          </>
        ) : (
          <p className={cn("text-[13.5px] leading-snug", e.type === "update" ? "text-ink" : "text-ink-2")}>{summarize(e)}</p>
        )}
        {asked.length > 0 && (
          <Reasoning>
            <ReasoningTrigger className="text-[12.5px] text-ink-3">
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
