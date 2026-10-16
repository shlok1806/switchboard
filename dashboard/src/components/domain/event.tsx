/*
 * One Event read in full: in Activity's inspector, and inline on a Task's Timeline. The head
 * says what it was, who and when, where it came from and which Task it is on; the body is
 * the Event by type; then what the Relay did with it for each Agent.
 */
import { useMemo } from "react";
import type { AgentId, ChannelEvent, Task, ToolCall, Verdict } from "@shared/index";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import { useEventsById } from "@/data/history";
import { EVENT_TYPE_LABEL, TASK_FIELD_LABEL, ago, captureOrOrigin, clock, compact, holderName, summarize, unrelayedReason } from "@/lib/format";
import { href } from "@/lib/router";
import { FileDiff } from "./diff";
import { Who } from "./log";
import { IssueLink } from "./pending";
import { HolderLabel } from "./task";
import { VerdictTable } from "./verdict";
import { SheetClose } from "@/components/shell/inspector";
import { Section } from "@/components/shell/section";

/** Code set as design.md's command block: mono 13 on paper-2, 6x10, wraps anywhere. */
const BLOCK = "rounded-[var(--r)] bg-paper-2 px-2.5 py-1.5 text-small [overflow-wrap:anywhere] whitespace-pre-wrap text-ink";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="min-w-0 text-row [overflow-wrap:anywhere] text-ink">{children}</dd>
    </div>
  );
}

/** A model reply's tool calls, one command line each. */
function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-small text-ink-3">
        {calls.length} tool {calls.length === 1 ? "call" : "calls"}
      </h4>
      <ul className="flex flex-col gap-1">
        {calls.map((c, i) => (
          <li key={`${c.name}-${i}`}>
            <code className={`block ${BLOCK}`}>
              {c.name} {c.arg}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A Wake: why the Agent started a turn, and the Events and Directives it was woken with, each a link. */
function WakeBody({ event }: { event: Extract<ChannelEvent, { type: "wake" }> }) {
  const delivered = useMemo(() => [...event.payload.events, ...event.payload.directives], [event.payload.events, event.payload.directives]);
  // They can be older than the Events the Dashboard has loaded.
  const byId = useEventsById(delivered);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-row text-ink">
        The Agent was idle, so its wrapper typed what was waiting for its next turn as one prompt, which started a turn. Its Person did not write
        that prompt.
      </p>
      {delivered.length > 0 && (
        <ul>
          {delivered.map((id) => {
            const woken = byId.get(id);
            return (
              <li key={id} className="border-b border-rule py-2">
                <a href={href({ view: "feed", event: id })} className="flex min-w-0 flex-col gap-0.5 hover:no-underline">
                  <span className="text-small text-ink-3">{woken ? EVENT_TYPE_LABEL[woken.type] : "Event"}</span>
                  <span className="min-w-0 text-row [overflow-wrap:anywhere] text-ink hover:underline">{woken ? summarize(woken) : id}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The body of one Event, by type. */
export function EventBody({ event }: { event: ChannelEvent }) {
  switch (event.type) {
    case "push":
    case "merge":
      return (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <code className="text-small">{event.payload.branch}</code>
            </Field>
            <Field label="Commit">
              <code className="text-small">{event.payload.commit.slice(0, 7)}</code>
            </Field>
          </dl>
          {event.type === "push" && event.payload.commits.length > 1 && (
            <ul className="flex flex-col gap-1">
              {event.payload.commits.map((c) => (
                <li key={c.sha} className="flex min-w-0 gap-2 text-small text-ink-2">
                  <code className="shrink-0 text-small text-ink-3">{c.sha.slice(0, 7)}</code>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{c.message}</span>
                </li>
              ))}
            </ul>
          )}
          {event.payload.files.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
          {event.payload.truncationNote && <p className="text-small text-ink-3">{event.payload.truncationNote}</p>}
        </div>
      );
    case "proxy.digest":
    case "proxy.raw": {
      const p = event.payload;
      return (
        <div className="flex flex-col gap-3">
          <p className="text-small text-ink-3 tabular-nums">
            {p.model} · {compact(p.inputTokens)} in · {compact(p.outputTokens)} out
            {p.maskedSecrets > 0 && ` · ${p.maskedSecrets} ${p.maskedSecrets === 1 ? "secret" : "secrets"} masked`}
          </p>
          <p className="text-row whitespace-pre-line text-ink">{p.reply}</p>
          {p.toolCalls.length > 0 && <ToolCalls calls={p.toolCalls} />}
          {event.type === "proxy.raw" && (
            <Reasoning>
              <ReasoningTrigger className="text-small font-medium">The model's context, raw</ReasoningTrigger>
              <ReasoningContent contentClassName="mt-2">
                <pre className={`max-h-64 overflow-auto ${BLOCK} text-ink-2`}>{event.payload.context}</pre>
              </ReasoningContent>
            </Reasoning>
          )}
        </div>
      );
    }
    case "tool.call": {
      const p = event.payload;
      return (
        <div className="flex flex-col gap-2">
          <code className={`block ${BLOCK}`}>
            {p.tool} {p.arg}
          </code>
          {/* A hook-captured call has no duration or output; only the Tool Capture's do. */}
          <p className="text-small text-ink-3 tabular-nums">
            {p.ok ? "Succeeded" : "Failed"}
            {p.durationMs !== undefined && ` in ${p.durationMs} ms`}
          </p>
          {p.output && <pre className={`max-h-64 overflow-auto ${BLOCK} text-ink-2`}>{p.output}</pre>}
        </div>
      );
    }
    case "command": {
      const { command, exitCode } = event.payload;
      return (
        <div className="flex flex-col gap-2">
          <code className={`block ${BLOCK}`}>$ {command}</code>
          {/* Claude Code does not report a shell command's exit code; Codex does. */}
          {exitCode !== undefined && <p className="text-small text-ink-3 tabular-nums">Exited {exitCode}</p>}
        </div>
      );
    }
    case "file.edit":
      return (
        <p className="text-row text-ink">
          <code className="text-small [overflow-wrap:anywhere]">{event.payload.path}</code>{" "}
          <span className="text-small text-ink-3 tabular-nums">
            +{event.payload.additions} -{event.payload.deletions}
          </span>
        </p>
      );
    case "wake":
      return <WakeBody event={event} />;
    case "update":
      if (!event.payload.to) return <p className="text-row [overflow-wrap:anywhere] text-ink">{summarize(event)}</p>;
      return (
        <div className="flex flex-col gap-3">
          <dl>
            <Field label="To">
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {event.payload.to.map((id) => (
                  <HolderLabel key={id} holder={{ kind: "agent", agentId: id }} />
                ))}
              </span>
            </Field>
          </dl>
          <p className="text-row whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">{event.payload.text}</p>
        </div>
      );
    case "directive":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-small text-ink-3">
            From {event.actor.kind === "person" ? event.actor.person : "its sender"} to <HolderLabel holder={{ kind: "agent", agentId: event.payload.to }} />
          </p>
          <p className="text-row font-medium whitespace-pre-wrap text-ink">{event.payload.text}</p>
        </div>
      );
    case "takeover":
      return (
        <dl className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">{holderName(event.payload.from)}</Field>
            <Field label="To">{holderName(event.payload.to)}</Field>
          </div>
          <Field label="Steps done">
            {event.payload.stepsCompleted.length ? (
              <ul className="flex flex-col gap-0.5 text-ink-2">
                {event.payload.stepsCompleted.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : (
              <span className="text-ink-3">None</span>
            )}
          </Field>
          <Field label="Last Update">
            <span className="text-ink-2">{event.payload.lastUpdate ?? "None"}</span>
          </Field>
        </dl>
      );
    case "task.create":
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-row text-ink">{event.payload.title}</p>
          <a href={event.payload.url} target="_blank" rel="noreferrer" className="self-start text-small text-ink hover:underline">
            Open the Issue on GitHub
          </a>
        </div>
      );
    case "task.change":
      return <p className="text-row text-ink">Changed on GitHub: {event.payload.fields.map((f) => TASK_FIELD_LABEL[f]).join(", ")}.</p>;
    default:
      return <p className="text-row [overflow-wrap:anywhere] text-ink">{summarize(event)}</p>;
  }
}

export function EventDetail({
  event,
  verdicts,
  taskByNumber,
  threshold,
  verdictsLive = true,
  verdictsLoaded = true,
  woken,
  onClose,
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  taskByNumber: Map<number, Task>;
  threshold: number;
  verdictsLive?: boolean;
  /** False for an Event older than those loaded: its Verdicts are not loaded with it. */
  verdictsLoaded?: boolean;
  /** The Agents whose Queue Verdict on this Event a Wake delivered. */
  woken?: ReadonlySet<AgentId>;
  /** Closes the inspector. */
  onClose?: () => void;
}) {
  const task = event.task !== undefined ? taskByNumber.get(event.task) : undefined;
  const unrelayed = event.type !== "directive" ? unrelayedReason(event.type) : null;
  const relayed = event.type !== "directive" && unrelayed === null && verdictsLive;
  const origin = captureOrOrigin(event);
  return (
    <>
      <header className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-title font-semibold text-ink">{EVENT_TYPE_LABEL[event.type]}</h2>
          <SheetClose onClose={onClose} />
        </div>
        <p className="text-small text-ink-3">
          <Who event={event} /> ·{" "}
          <time dateTime={event.at} className="tabular-nums">
            {clock(event.at)}, {ago(event.at)}
          </time>{" "}
          · {event.capture ? `${origin} Capture` : origin}
        </p>
        {task && (
          <p className="text-small">
            <a href={href({ view: "task", number: task.number })} className="text-ink hover:underline">
              #{task.number} {task.title}
            </a>
          </p>
        )}
      </header>
      <EventBody event={event} />
      <Section title="Verdicts" meta={relayed && `an Interrupt needs ${threshold.toFixed(2)}`} as="h3">
        {event.type === "directive" ? (
          <p className="text-small text-ink-3">
            None: a Directive always reaches its Agent, labelled as from {event.actor.kind === "person" ? event.actor.person : "its sender"}.
          </p>
        ) : unrelayed !== null ? (
          <p className="text-small text-ink-3">{unrelayed}</p>
        ) : verdictsLive && !verdictsLoaded ? (
          <p className="text-small text-ink-3">This Event is older than the ones loaded, so its Verdicts are not shown.</p>
        ) : verdictsLive ? (
          <VerdictTable verdicts={verdicts} threshold={threshold} woken={woken} />
        ) : (
          <p className="text-small text-ink-3">
            Arrives with the Relay (<IssueLink capability="verdicts" />).
          </p>
        )}
      </Section>
    </>
  );
}
