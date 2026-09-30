import { useMemo, useState } from "react";
import { CircleCheck, Circle, GitBranch, GitPullRequest } from "@/components/pixel-icon";
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
import { AgentLink, CaptureChip, PresencePill, StalePill, TaskLink, VerdictTally } from "@/components/domain/pills";
import { COLUMN_LABEL, Progress, columnOf, stepProgress, subtaskProgress } from "@/components/domain/task";
import { TakeoverAction } from "@/components/domain/takeover";
import { EventBody } from "@/components/domain/event";
import { VerdictTable } from "@/components/domain/verdict";
import { Composer } from "@/components/domain/composer";
import { EVENT_TYPE_LABEL, ago, clock, summarize } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";
import { GroupBox } from "@/components/shell/groupbox";

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
  claim: "bg-accent-ink",
  takeover: "bg-red",
  push: "bg-green",
  merge: "bg-green",
  "task.review": "bg-green",
  update: "bg-foreground",
  "step.complete": "bg-accent-ink",
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
      <div className="mx-auto grid max-w-6xl gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-ink-3">
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
            <h1 className="glow text-[22px] leading-tight font-bold tracking-tight text-accent-ink [overflow-wrap:anywhere] sm:text-[26px]">
              {task.title}
            </h1>
            <IssueBody text={task.description} />
            <div className="flex flex-wrap gap-1.5">
              {task.labels.map((l) => (
                <span key={l} className="bevel-thin-in bg-muted px-1.5 py-[1px] font-mono text-[11px] text-muted-foreground">
                  {l}
                </span>
              ))}
            </div>
          </header>

          {task.steps.length > 0 && (
            <GroupBox title={<span className="flex items-center gap-2">Steps <Progress done={steps.done} total={steps.total} noun="done" /></span>}>
              <ul className="flex flex-col gap-1.5">
                  {task.steps.map((s) => (
                    <li key={s.index} className="flex items-start gap-2 text-[13px]">
                      {s.done ? (
                        <CircleCheck className="mt-px text-green" aria-label="Done" />
                      ) : (
                        <Circle className="mt-px text-faint" aria-label="Not done" />
                      )}
                      <span className={s.done ? "text-ink-3 line-through" : "text-ink"}>{s.text}</span>
                    </li>
                  ))}
              </ul>
            </GroupBox>
          )}

          {task.subtasks.length > 0 && (
            <GroupBox
              title={<span className="flex items-center gap-2">Subtasks <Progress done={subs.done} total={subs.total} noun="done" /></span>}
              bodyClassName="px-1 pb-1"
            >
              <ul>
                {task.subtasks.map((n) => {
                  const s = taskByNumber.get(n);
                  if (!s) return null;
                  const sp = stepProgress(s);
                  return (
                    <li key={n}>
                      <a
                        href={href({ view: "task", number: n })}
                        className="flex items-center gap-3 px-2 py-[3px] hover:bg-primary hover:text-primary-foreground hover:[&_*]:text-primary-foreground coarse:py-2.5"
                      >
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
            </GroupBox>
          )}

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-1.5">
              <h2 className="type-label !text-ink">Timeline</h2>
              <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
            </div>
            {timeline.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">Nothing has happened on this Task yet.</p>
            ) : (
              <ol className="relative flex flex-col">
                <span aria-hidden className="absolute top-2 bottom-2 left-[4px] w-px bg-border" />
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
          <GroupBox title="Claim" tone={task.claim?.stale ? "alert" : undefined} bodyClassName="flex flex-col gap-2">
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
          </GroupBox>

          {blocked.length > 0 && (
            <GroupBox title="Blocked by" tone="alert" bodyClassName="flex flex-col gap-1.5">
              {blocked.map((b) => (
                <TaskLink key={b!.number} number={b!.number} title={b!.title} className="text-[12.5px] text-ink" />
              ))}
            </GroupBox>
          )}

          {(task.branch || task.pr) && (
            <section className="flex flex-col gap-2">
              {task.branch && (
                <Snippet defaultValue="switch">
                  <SnippetHeader>
                    <span className="flex items-center gap-1.5 text-[12px] font-bold">
                      <GitBranch /> Branch
                    </span>
                    <SnippetCopyButton value={`git fetch && git switch ${task.branch}`} aria-label="Copy command" />
                  </SnippetHeader>
                  <SnippetTabsContent value="switch">
                    git switch {task.branch}
                  </SnippetTabsContent>
                </Snippet>
              )}
              {task.pr && (
                <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                  <GitPullRequest /> PR <span className="font-mono">#{task.pr}</span>
                </p>
              )}
            </section>
          )}

          {task.status !== "done" && <Composer task={task.number} className="bevel-out" />}
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
    <li className="relative grid grid-cols-[9px_minmax(0,1fr)] gap-3 py-1.5">
      <span
        aria-hidden
        className={cn("relative z-10 mt-1 size-[9px] border border-card", DOT[e.type] ?? "bg-faint")}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="type-label !text-ink">{EVENT_TYPE_LABEL[e.type]}</span>
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
