import { useMemo, useState } from "react";
import { CircleCheck, Circle, GitBranch, GitPullRequest } from "lucide-react";
import type { ChannelEvent, EventType } from "@shared/index";
import { useCapabilities, useChannel, useIndex } from "@/data/store";
import { IssueLink } from "@/components/domain/pending";
import { IssueBody } from "@/components/domain/issue-body";
import { SegmentedControl } from "@/components/atoms/SegmentedControl";
import { Steps, StepsContent, StepsItem, StepsTrigger } from "@/components/ui/steps";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import {
  Snippet,
  SnippetCopyButton,
  SnippetHeader,
  SnippetTabsContent,
  SnippetTabsList,
  SnippetTabsTrigger,
} from "@/components/kibo-ui/snippet";
import { AgentLink, CaptureChip, PresencePill, StalePill, TaskLink, VerdictTally } from "@/components/domain/pills";
import { COLUMN_LABEL, Progress, columnOf, stepProgress, subtaskProgress } from "@/components/domain/task";
import { TakeoverAction } from "@/components/domain/takeover";
import { EventBody } from "@/components/domain/event";
import { VerdictTable } from "@/components/domain/verdict";
import { Composer } from "@/components/domain/composer";
import { EVENT_TYPE_LABEL, ago, clock, summarize } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

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

const SCOPES = ["Work", "All Events"] as const;

const DOT: Partial<Record<EventType, string>> = {
  claim: "bg-accent",
  takeover: "bg-red",
  push: "bg-green",
  merge: "bg-green",
  "task.review": "bg-green",
  update: "bg-ink",
  "step.complete": "bg-accent",
  "claim.refused": "bg-orange",
};

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
        .filter((e) => e.task === number && (scope === "All Events" || WORK.includes(e.type)))
        .slice()
        .reverse(),
    [events, number, scope],
  );

  if (!task) {
    return (
      <div className="p-6 text-[13px] text-ink-2">
        No Task #{number} on this Channel. <a href={href({ view: "tasks" })} className="text-accent-ink hover:underline">Back to Tasks</a>
      </div>
    );
  }

  const steps = stepProgress(task);
  const subs = subtaskProgress(task);
  const col = columnOf(task);
  const holderAgent = task.claim?.holder.kind === "agent" ? agentById.get(task.claim.holder.agentId) : undefined;
  const blocked = task.blockedBy.map((n) => taskByNumber.get(n)).filter(Boolean);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
              <span className="font-mono">#{task.number}</span>
              <span aria-hidden>·</span>
              <span>{COLUMN_LABEL[col]}</span>
              <span aria-hidden>·</span>
              <a href={task.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                Issue on GitHub
              </a>
              {task.parent && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    Subtask of <TaskLink number={task.parent} title={taskByNumber.get(task.parent)?.title} />
                  </span>
                </>
              )}
            </div>
            <h1 className="font-display text-[22px] font-semibold leading-tight text-ink [overflow-wrap:anywhere] sm:text-[26px]">
              {task.title}
            </h1>
            <IssueBody text={task.description} />
            <div className="flex flex-wrap gap-1.5">
              {task.labels.map((l) => (
                <span key={l} className="rounded-[4px] bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink-2 shadow-hairline">
                  {l}
                </span>
              ))}
            </div>
          </header>

          {task.steps.length > 0 && (
            <section className="rounded-card bg-surface p-3 shadow-card">
              <Steps defaultOpen>
                <StepsTrigger className="text-[13px] font-semibold text-ink">
                  <span className="flex items-center gap-2">
                    Steps <Progress done={steps.done} total={steps.total} noun="done" />
                  </span>
                </StepsTrigger>
                <StepsContent bar={<div aria-hidden className="h-full w-[2px] rounded-full bg-line" />}>
                  {task.steps.map((s) => (
                    <StepsItem key={s.index} className="flex items-start gap-2 text-[13px]">
                      {s.done ? (
                        <CircleCheck className="mt-0.5 size-4 shrink-0 text-green" aria-label="Done" />
                      ) : (
                        <Circle className="mt-0.5 size-4 shrink-0 text-line-strong" aria-label="Not done" />
                      )}
                      <span className={s.done ? "text-ink-3" : "text-ink"}>{s.text}</span>
                    </StepsItem>
                  ))}
                </StepsContent>
              </Steps>
            </section>
          )}

          {task.subtasks.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                Subtasks <Progress done={subs.done} total={subs.total} noun="done" />
              </h2>
              <ul className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
                {task.subtasks.map((n) => {
                  const s = taskByNumber.get(n);
                  if (!s) return null;
                  const sp = stepProgress(s);
                  return (
                    <li key={n}>
                      <a href={href({ view: "task", number: n })} className="flex items-center gap-3 px-3 py-2.5 hover:bg-inset">
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                          <span className="font-mono text-[12px] text-ink-3">#{n}</span> {s.title}
                        </span>
                        {sp.total > 0 && <Progress done={sp.done} total={sp.total} noun="steps" />}
                        <span className="w-20 text-right text-[11.5px] text-ink-3">{COLUMN_LABEL[columnOf(s)]}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold text-ink">Timeline</h2>
              <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
            </div>
            {timeline.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">Nothing has happened on this Task yet.</p>
            ) : (
              <ol className="relative flex flex-col">
                <span aria-hidden className="absolute top-2 bottom-2 left-[5px] w-px bg-line" />
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
            "flex min-w-0 flex-col gap-4 lg:sticky lg:top-0 lg:order-none lg:self-start",
            task.claim?.stale && "order-first",
          )}
        >
          <section className="flex flex-col gap-2 rounded-card bg-surface p-3 shadow-card">
            <h2 className="label-mono">Claim</h2>
            {task.claim ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {task.claim.holder.kind === "agent" ? (
                    <AgentLink id={task.claim.holder.agentId} agent={holderAgent} />
                  ) : (
                    <span className="text-[13px] font-medium text-ink">{task.claim.holder.person}</span>
                  )}
                  {holderAgent && <PresencePill presence={holderAgent.presence} />}
                  {task.claim.stale && <StalePill />}
                </div>
                <p className="text-[12px] text-ink-3">
                  Claimed {ago(task.claim.claimedAt)}
                  {task.claim.stale && ". The holder is Gone, so this stays held until a Person takes it over."}
                </p>
                <TakeoverAction task={task} />
              </>
            ) : (
              <p className="text-[12.5px] text-ink-3">
                {task.status === "done" ? (
                  "Done. No Claim."
                ) : can.claims ? (
                  "Nobody holds this Task."
                ) : (
                  <>Nobody holds this Task. Claims arrive with <IssueLink capability="claims" />.</>
                )}
              </p>
            )}
          </section>

          {blocked.length > 0 && (
            <section className="flex flex-col gap-1.5 rounded-card bg-orange-tint p-3">
              <h2 className="label-mono !text-orange">Blocked by</h2>
              {blocked.map((b) => (
                <TaskLink key={b!.number} number={b!.number} title={b!.title} className="text-[12.5px] text-ink" />
              ))}
            </section>
          )}

          {(task.branch || task.pr) && (
            <section className="flex flex-col gap-2">
              {task.branch && (
                <Snippet defaultValue="switch" className="rounded-card border-0 bg-surface shadow-card">
                  <SnippetHeader className="border-line bg-inset">
                    <SnippetTabsList className="h-7 bg-transparent p-0">
                      <SnippetTabsTrigger value="switch" className="h-6 text-[12px]">
                        <GitBranch className="size-3.5" /> Branch
                      </SnippetTabsTrigger>
                    </SnippetTabsList>
                    <SnippetCopyButton value={`git fetch && git switch ${task.branch}`} className="size-7 opacity-100" aria-label="Copy command" />
                  </SnippetHeader>
                  <SnippetTabsContent value="switch" className="bg-surface px-3 py-2.5 font-mono text-[12px] text-ink">
                    git switch {task.branch}
                  </SnippetTabsContent>
                </Snippet>
              )}
              {task.pr && (
                <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                  <GitPullRequest className="size-3.5" /> PR <span className="font-mono">#{task.pr}</span>
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
    <li className="relative grid grid-cols-[11px_minmax(0,1fr)] gap-3 py-2">
      <span
        aria-hidden
        className={cn("relative z-10 mt-1.5 size-[11px] rounded-full border-2 border-page", DOT[e.type] ?? "bg-line-strong")}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[12.5px] font-semibold text-ink">{EVENT_TYPE_LABEL[e.type]}</span>
          {e.actor.kind === "agent" ? (
            <AgentLink id={e.actor.agentId} agent={agentById.get(e.actor.agentId)} />
          ) : (
            <span className="text-[12.5px] text-ink-2">{e.actor.kind === "person" ? e.actor.person : "GitHub"}</span>
          )}
          <CaptureChip event={e} />
          <time className="ml-auto font-mono text-[11px] text-ink-3 tabular-nums" title={clock(e.at)}>
            {ago(e.at)}
          </time>
        </div>
        {e.type === "push" || e.type === "merge" || e.type === "takeover" ? (
          <>
            <p className="text-[13px] text-ink-2">{summarize(e)}</p>
            <Reasoning>
              <ReasoningTrigger className="text-[12px] font-medium text-ink-2">
                {e.type === "push" || e.type === "merge" ? `Diff (${e.payload.files.length} ${e.payload.files.length === 1 ? "file" : "files"})` : "Hand-off"}
              </ReasoningTrigger>
              <ReasoningContent contentClassName="mt-2 max-w-none">
                <EventBody event={e} />
              </ReasoningContent>
            </Reasoning>
          </>
        ) : (
          <p className={cn("text-[13px] leading-snug", e.type === "update" ? "text-ink" : "text-ink-2")}>{summarize(e)}</p>
        )}
        {asked.length > 0 && (
          <Reasoning>
            <ReasoningTrigger className="text-[12px] text-ink-3">
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
