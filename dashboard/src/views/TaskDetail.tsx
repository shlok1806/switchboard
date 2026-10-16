/*
 * A Task's page (design.md): where it stands and who holds it, then what it asks, its Steps
 * and its Timeline at reading width. The aside is what a Person does about it: claim it or
 * take a Stale Claim over, switch to its branch, post an Update on it, or send its Agent a
 * Directive. Below 640px the aside follows the Task, except a Stale Claim, which leads.
 */
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Agent, ChannelEvent, EventType, Task } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { ClaimAction } from "@/components/domain/claim";
import { EventBody } from "@/components/domain/event";
import { IssueBody } from "@/components/domain/issue-body";
import { taskGlyph } from "@/components/domain/moves";
import { OlderRow } from "@/components/domain/older";
import { IssueLink } from "@/components/domain/pending";
import { Glyph, State } from "@/components/domain/state";
import { TakeoverAction } from "@/components/domain/takeover";
import { COLUMN_LABEL, HolderLabel, columnOf, openBlockers, shownLabels } from "@/components/domain/task";
import { VerdictTable } from "@/components/domain/verdict";
import { Section } from "@/components/shell/section";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import { useScopedHistory } from "@/data/history";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
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
  "memory.note",
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

type Scope = "work" | "all";

export function TaskDetail({ number }: { number: number }) {
  const { snapshot } = useChannel();
  const can = useCapabilities();
  const { agentById, taskByNumber } = useIndex();
  const me = useMe();
  const [scope, setScope] = useState<Scope>("work");
  const task = taskByNumber.get(number);
  const threshold = snapshot?.relay.interruptThreshold ?? 0.6;

  const onTask = useCallback((e: ChannelEvent) => e.task === number, [number]);
  const scoped = useScopedHistory({ task: number }, onTask);
  const work = useMemo(() => scoped.events.filter((e) => WORK.includes(e.type)).length, [scoped.events]);
  const timeline = useMemo(
    () =>
      scoped.events
        .filter((e) => scope === "all" || WORK.includes(e.type))
        .slice()
        .reverse(),
    [scoped.events, scope],
  );

  if (!task) {
    return (
      <div className="px-[var(--gutter)] pt-5 text-row text-ink-2">
        No Task #{number}.{" "}
        <a href={href({ view: "tasks" })} className="text-ink underline">
          Back to the Tasks
        </a>
      </div>
    );
  }

  const col = columnOf(task);
  const claim = task.claim;
  const holder = claim?.holder.kind === "agent" ? agentById.get(claim.holder.agentId) : undefined;
  const labels = shownLabels(task);
  const blockers = openBlockers(task, taskByNumber);
  const parent = task.parent !== undefined ? taskByNumber.get(task.parent) : undefined;
  const facts = [
    `#${task.number}`,
    task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length} Steps done`,
    task.subtasks.length > 0 && `${task.subtasksDone} of ${task.subtasks.length} Subtasks`,
    task.pr !== undefined && `PR #${task.pr}`,
    `updated ${ago(task.updatedAt)}`,
  ].filter(Boolean);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-[var(--gutter)] pt-3 pb-10">
        <header className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
            <h1 className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-head font-semibold [overflow-wrap:anywhere] text-ink">
              <Glyph state={taskGlyph(task, me, agentById)} />
              {task.title}
              <State state={taskGlyph(task, me, agentById)} word={COLUMN_LABEL[col]} glyph={false} className="text-row" />
            </h1>
            <p className="text-small text-ink-3">
              {facts.join(" · ")}
              {parent && (
                <>
                  {" · in "}
                  <a href={href({ view: "task", number: parent.number })} className="text-ink hover:underline">
                    #{parent.number} {parent.title}
                  </a>
                </>
              )}
              {" · "}
              <a href={task.url} target="_blank" rel="noreferrer" className="text-ink hover:underline">
                Open on GitHub
              </a>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {claim?.stale ? <TakeoverAction task={task} size="md" compact /> : <span className="w-28 empty:hidden"><ClaimAction task={task} /></span>}
          </div>
        </header>

        <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
          <div className="flex min-w-0 flex-[7_1_560px] flex-col gap-6">
            {task.description.trim() ? (
              <div className="max-w-[72ch]">
                <IssueBody text={task.description} />
              </div>
            ) : (
              <p className="text-row text-ink-3">No description on the Issue.</p>
            )}
            {labels.length > 0 && (
              <p className="text-small text-ink-3">
                Labelled <span className="text-ink-2">{labels.join(", ")}</span>
              </p>
            )}

            {task.steps.length > 0 && <StepList task={task} holder={claim ? <HolderLabel holder={claim.holder} /> : null} />}

            {task.subtasks.length > 0 && (
              <Section title="Subtasks" meta={`${task.subtasksDone} of ${task.subtasks.length} done`} bodyClassName="pt-0">
                <ul>
                  {task.subtasks.map((n) => {
                    const s = taskByNumber.get(n);
                    if (!s) return null;
                    return (
                      <li key={n} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule py-2.5">
                        <a href={href({ view: "task", number: n })} className="min-w-0 flex-1 text-row [overflow-wrap:anywhere] text-ink hover:underline">
                          <span className="text-ink-3 tabular-nums">#{n}</span> {s.title}
                        </a>
                        {s.steps.length > 0 && (
                          <span className="text-small text-ink-3 tabular-nums">
                            {s.stepsDone}/{s.steps.length} Steps
                          </span>
                        )}
                        <State state={taskGlyph(s, me, agentById)} word={COLUMN_LABEL[columnOf(s)]} className="text-small" />
                      </li>
                    );
                  })}
                </ul>
              </Section>
            )}

            <section className="flex min-w-0 flex-col" aria-labelledby="timeline">
              <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule-2 pb-2">
                <h2 id="timeline" className="flex-1 text-title font-semibold text-ink">
                  Timeline
                </h2>
                <div role="group" aria-label="Show" className="flex gap-1.5">
                  <Chip on={scope === "work"} onClick={() => setScope("work")} count={work}>
                    Work
                  </Chip>
                  <Chip on={scope === "all"} onClick={() => setScope("all")} count={scoped.events.length}>
                    All
                  </Chip>
                </div>
              </header>
              {timeline.length === 0 && !scoped.more ? (
                <p className="py-4 text-row text-ink-3">{scoped.loading ? "Reading the Timeline" : "Nothing on the Channel about it yet."}</p>
              ) : (
                <ol>
                  {timeline.map((e) => (
                    <TimelineItem key={e.id} event={e} threshold={threshold} />
                  ))}
                  {scoped.more && <OlderRow loading={scoped.loading} onClick={scoped.loadOlder} what="events" />}
                </ol>
              )}
            </section>
          </div>

          <aside aria-label="Work on it" className="flex min-w-0 flex-[4_1_320px] flex-col gap-6 max-sm:contents">
            <Section title={claim?.stale ? "Stale Claim" : "Claim"} className={cn(claim?.stale && "max-sm:order-first")} bodyClassName="flex flex-col gap-2">
              {claim ? (
                <>
                  <p className="text-row text-ink">
                    <HolderLabel holder={claim.holder} />
                  </p>
                  <p className="text-small text-ink-3">
                    {claim.stale ? "Its holder is Gone, so anyone may take it over. " : ""}Claimed {ago(claim.claimedAt)}.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-small text-ink-3">
                    {task.status === "done" ? (
                      "Done, so nobody holds it."
                    ) : can.claims ? (
                      "Nobody holds it."
                    ) : (
                      <>
                        Claims arrive with <IssueLink capability="claims" />.
                      </>
                    )}
                  </p>
                  <span className="w-28 empty:hidden">
                    <ClaimAction task={task} />
                  </span>
                </>
              )}
            </Section>

            {blockers.length > 0 && (
              <Section title="Blocked by" bodyClassName="pt-0">
                <ul>
                  {blockers.map((n) => (
                    <li key={n} className="border-b border-rule py-2 text-row">
                      <a href={href({ view: "task", number: n })} className="text-ink hover:underline">
                        <span className="tabular-nums">#{n}</span> {taskByNumber.get(n)?.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {task.branch && <Branch branch={task.branch} />}

            {task.pr !== undefined && (
              <Section title="Pull request">
                <p className="text-row text-ink">
                  <span className="tabular-nums">PR #{task.pr}</span>
                  <span className="text-ink-3">{task.status === "review" ? ", in review" : task.status === "done" ? ", merged" : ""}</span>
                </p>
              </Section>
            )}

            {task.status !== "done" && <UpdateForm task={task} />}
            {task.status !== "done" && holder && <DirectiveForm agent={holder} />}
          </aside>
        </div>
      </div>
    </div>
  );
}

/** The Steps as a checklist: done, the one its holder is on, and the rest. */
function StepList({ task, holder }: { task: Task; holder: React.ReactNode }) {
  const halted = task.claim?.stale === true || (task.claim?.blockedBy?.length ?? 0) > 0;
  const firstOpen = task.steps.findIndex((s) => !s.done);
  return (
    <Section title="Steps" meta={`${task.stepsDone} of ${task.steps.length} done`} bodyClassName="pt-0">
      <ol>
        {task.steps.map((s, i) => {
          const next = task.claim !== undefined && !halted && i === firstOpen;
          return (
            <li key={s.index} className={cn("flex flex-wrap items-baseline gap-x-2.5 border-b border-rule py-2.5 text-row", s.done || next ? "text-ink" : "text-ink-3")}>
              <Glyph state={s.done ? "done" : next ? "running" : "idle"} className="relative top-px" />
              <span className="sr-only">{s.done ? "Done:" : next ? "In progress:" : "To do:"}</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.text}</span>
              {next && holder && <span className="text-small text-ink-2">{holder}</span>}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/** The command that puts a checkout on the Task's branch, with a Copy. */
function Branch({ branch }: { branch: string }) {
  const command = `git fetch && git switch ${branch}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy the command");
    }
  };
  return (
    <Section
      title="Branch"
      action={
        <button type="button" onClick={() => void copy()} className="text-ink hover:underline">
          {copied ? "Copied" : "Copy"}
        </button>
      }
    >
      <code className="block rounded-[var(--r)] bg-paper-2 px-2.5 py-2 text-small [overflow-wrap:anywhere] text-ink">{command}</code>
    </Section>
  );
}

const FIELD =
  "min-h-[76px] resize-y rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 py-2 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:text-[16px]";

/** Post an Update on the Task: everyone on the Channel reads it, nobody has to act on it. */
function UpdateForm({ task }: { task: Task }) {
  const store = useStore();
  return (
    <Said
      title="Update"
      meta="everyone reads it"
      id="update"
      label={`Update on #${task.number}`}
      placeholder="The login test passes on Safari now."
      send={(text) => store.source.act({ type: "update", text, task: task.number })}
      done="Update posted"
    />
  );
}

/** Tell the Agent holding the Task what to do: a Directive is read at the start of its next turn. */
function DirectiveForm({ agent }: { agent: Agent }) {
  const store = useStore();
  const can = useCapabilities();
  const name = agent.nickname ?? agent.id;
  if (!can.directives) {
    return (
      <Section title="Directive">
        <p className="text-small text-ink-3">
          Directives arrive with <IssueLink capability="directives" />.
        </p>
      </Section>
    );
  }
  if (agent.presence === "gone") {
    return (
      <Section title="Directive">
        <p className="text-small text-ink-3">{name} is Gone. A Directive waits until it resumes.</p>
      </Section>
    );
  }
  return (
    <Said
      title="Directive"
      meta={`to ${name}`}
      id="directive"
      label={`Directive to ${name}`}
      placeholder="Run the tests before touching web/src/pages."
      send={(text) => store.source.act({ type: "directive", to: agent.id, text })}
      done={`Directive sent to ${name}`}
    />
  );
}

function Said({
  title,
  meta,
  id,
  label,
  placeholder,
  send,
  done,
}: {
  title: string;
  meta: string;
  id: string;
  label: string;
  placeholder: string;
  send: (text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  done: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setBusy(true);
    const r = await send(said);
    setBusy(false);
    if (!r.ok) return void toast.error(r.reason);
    setText("");
    toast.success(done);
  };
  return (
    <Section title={title} meta={meta}>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <textarea
          id={id}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
          placeholder={placeholder}
          className={FIELD}
        />
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={busy || !text.trim()}>
            {busy ? "Sending" : "Send"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function TimelineItem({ event: e, threshold }: { event: ChannelEvent; threshold: number }) {
  const { verdictsByEvent } = useChannel();
  const { agentById } = useIndex();
  const verdicts = verdictsByEvent.get(e.id) ?? [];
  const asked = verdicts.filter((v) => v.source === "jev");
  const files = e.type === "push" || e.type === "merge" ? e.payload.files.length : 0;
  return (
    <li className="flex flex-col gap-1 border-b border-rule py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-small">
        <span className="font-semibold text-ink">{EVENT_TYPE_LABEL[e.type]}</span>
        <span className="text-ink-3">·</span>
        <span className="min-w-0 text-ink-2">
          {e.actor.kind === "agent" ? <HolderLabel holder={{ kind: "agent", agentId: e.actor.agentId }} /> : e.actor.kind === "person" ? e.actor.person : "GitHub"}
        </span>
        <time dateTime={e.at} className="ml-auto text-ink-3 tabular-nums" title={clock(e.at)}>
          {ago(e.at)}
        </time>
      </div>
      <p className={cn("max-w-[72ch] text-row [overflow-wrap:anywhere]", e.type === "update" || e.type === "directive" ? "text-ink" : "text-ink-2")}>{summarize(e)}</p>
      {(e.type === "push" || e.type === "merge" || e.type === "takeover") && (
        <Reasoning>
          <ReasoningTrigger className="text-small text-ink-3">{files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : "The hand-off"}</ReasoningTrigger>
          <ReasoningContent contentClassName="mt-2 max-w-none">
            <EventBody event={e} />
          </ReasoningContent>
        </Reasoning>
      )}
      {asked.length > 0 && (
        <Reasoning>
          <ReasoningTrigger className="text-small text-ink-3">
            {asked.length} {asked.length === 1 ? "Verdict" : "Verdicts"}
          </ReasoningTrigger>
          <ReasoningContent contentClassName="mt-2 max-w-none">
            <VerdictTable verdicts={verdicts} agentById={agentById} threshold={threshold} />
          </ReasoningContent>
        </Reasoning>
      )}
    </li>
  );
}
