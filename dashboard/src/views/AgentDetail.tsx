/*
 * An Agent's page (design.md's Agent board): its name, state and one line of facts with
 * the actions at the right; then the terminal, dark in both themes, under the Ask it is
 * waiting on, its Task's Steps and the Agents it started; and at the right the Directive,
 * the context window, the account, where it runs and what the Relay heard from it. History
 * is the other section. Below 640px the right column follows the left.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, ChannelEvent, Task } from "@shared/index";
import { MAX_NICKNAME_LENGTH, modelLabel } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { LeadDialog, useSetLead } from "@/components/domain/agent-role";
import { PendingApproval } from "@/components/domain/approval";
import { ContextWindow } from "@/components/domain/context";
import { EventRow } from "@/components/domain/event";
import { contextPercent, shortName, useClaimsOf } from "@/components/domain/fleet";
import { OlderRow } from "@/components/domain/older";
import { IssueLink } from "@/components/domain/pending";
import { StopAgentButton } from "@/components/domain/start-agent";
import { Glyph, State, useAgentState, useAgentStates } from "@/components/domain/state";
import { TerminalPanel } from "@/components/domain/terminal";
import { useNow } from "@/components/domain/usage";
import { Section } from "@/components/shell/section";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useScopedHistory } from "@/data/history";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
import { CAPTURE_LABEL, CLI_LABEL, ago, hostName } from "@/lib/format";
import { go, href } from "@/lib/router";
import { isStale, limitsFor, resetText } from "@/lib/usage";
import { cn } from "@/lib/utils";

const CAPTURES = ["All", "Proxy", "Hook", "Tool"] as const;
type Part = "terminal" | "history";

/** Newest first here, so a group is the same sender within two minutes going back. */
function sameSender(prev: ChannelEvent, e: ChannelEvent) {
  return prev.actor.kind === "agent" && e.actor.kind === "agent" && prev.actor.agentId === e.actor.agentId && e.type !== "directive" && prev.type !== "directive" && Math.abs(Date.parse(prev.at) - Date.parse(e.at)) < 120_000;
}

export function AgentDetail({ id }: { id: string }) {
  const { agentById } = useIndex();
  const agent = agentById.get(id as AgentId);
  if (!agent) {
    return (
      <div className="px-[var(--gutter)] py-6 text-row text-ink-2">
        No Agent {id}.{" "}
        <a href={href({ view: "agents" })} className="text-ink underline underline-offset-4">
          Back to Agents
        </a>
      </div>
    );
  }
  return <AgentPage key={agent.id} agent={agent} />;
}

function AgentPage({ agent }: { agent: Agent }) {
  const me = useMe();
  const can = useCapabilities();
  const { agents } = useChannel();
  const claimsOf = useClaimsOf();
  const state = useAgentState(agent);
  const [part, setPart] = useState<Part>("terminal");
  const [renaming, setRenaming] = useState(false);
  const directive = useRef<HTMLTextAreaElement>(null);

  const aboutAgent = useCallback(
    (e: ChannelEvent) =>
      (e.actor.kind === "agent" && e.actor.agentId === agent.id) ||
      (e.type === "directive" && e.payload.to === agent.id) ||
      // Renamed by a Person, or its name taken while it was Gone (ADR 0009).
      (e.type === "agent.rename" && e.payload.agent === agent.id) ||
      // Stopped by its Person, on the Host that runs it (ADR 0015).
      (e.type === "agent.stop" && e.payload.agent === agent.id),
    [agent.id],
  );
  const scoped = useScopedHistory({ agent: agent.id }, aboutAgent);

  const held = claimsOf.get(agent.id) ?? [];
  const children = agents.filter((a) => a.parent === agent.id);
  const parent = agent.parent ? agents.find((a) => a.id === agent.parent) : undefined;
  const mine = agent.person === me;
  const canDirect = can.directives && agent.presence !== "gone";
  const asking = agent.approval !== undefined && agent.presence !== "gone";

  const facts = [
    `${mine ? "Your" : `${agent.person}'s`} ${CLI_LABEL[agent.cli]} ${agent.host ? `on ${hostName(agent.host)}` : "in a terminal"}`,
    agent.model && `${modelLabel(agent.model)}${agent.effort ? `, ${agent.effort} effort` : ""}`,
    agent.role === "lead" && (children.length ? `lead of ${children.map(shortName).join(", ")}` : "lead"),
    parent && `started by ${shortName(parent)}`,
    `started ${ago(agent.startedAt)}`,
    agent.proxyMode === "raw" && "shares raw turns",
  ].filter(Boolean);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-[var(--gutter)] pt-3 pb-10">
        <header className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
            <h1 className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-head font-semibold [overflow-wrap:anywhere] text-ink">
              <Glyph state={state} />
              {agent.nickname ?? agent.id}
              <span title={`Last seen ${ago(agent.lastSeenAt)}`}>
                <State state={state} person={agent.person} glyph={false} className="text-row" />
              </span>
            </h1>
            <p className="text-small text-ink-3">{facts.join(" · ")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canDirect && (
              <Button
                variant="primary"
                onClick={() => {
                  directive.current?.focus();
                  directive.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                }}
              >
                Directive
              </Button>
            )}
            <Button onClick={() => setRenaming(true)}>Rename</Button>
            <StopAgentButton agent={agent} />
            <MoreActions agent={agent} onRename={() => setRenaming(true)} />
          </div>
        </header>

        <nav aria-label={`Sections of ${agent.nickname ?? agent.id}`} className="flex flex-wrap gap-1">
          <Chip on={part === "terminal"} onClick={() => setPart("terminal")}>
            Terminal
          </Chip>
          <Chip on={part === "history"} onClick={() => setPart("history")} count={scoped.events.length}>
            History
          </Chip>
        </nav>

        <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
          <div className="flex min-w-0 flex-[7_1_560px] flex-col gap-5">
            {part === "terminal" ? (
              <>
                {asking && (
                  <div className="border-b border-rule-2 pb-4">
                    <PendingApproval agent={agent} />
                  </div>
                )}
                <TerminalPanel agent={agent} />
                {held.map((task) => (
                  <Steps key={task.number} task={task} />
                ))}
                {children.length > 0 && <Children agents={children} />}
              </>
            ) : (
              <History scoped={scoped} />
            )}
          </div>

          <aside aria-label="Details" className="flex min-w-0 flex-[4_1_320px] flex-col gap-5">
            {!can.directives ? (
              <p className="text-small text-ink-3">
                Directives arrive with <IssueLink capability="directives" />.
              </p>
            ) : agent.presence === "gone" ? (
              <Section title="Directive">
                <p className="text-small text-ink-3">Gone. A Directive waits until it resumes.</p>
              </Section>
            ) : (
              <DirectiveForm agent={agent} events={scoped.events} inputRef={directive} />
            )}
            <Section title="Context window">
              <ContextWindow agent={agent} />
            </Section>
            {agent.usage && <Account agent={agent} />}
            <Section title="Where">
              <Facts
                rows={[
                  ["Host", agent.host ? hostName(agent.host) : "a terminal", !agent.host && "started by hand, not by a Host"],
                  agent.context?.cwd && ["Folder", <code key="cwd">{agent.context.cwd}</code>],
                  agent.context?.branch && ["Branch", <code key="branch">{agent.context.branch}</code>],
                  ["Started by", parent ? shortName(parent) : agent.person, parent && "a lead"],
                ]}
              />
            </Section>
            <Relay agent={agent} events={scoped.events} partial={scoped.more} />
          </aside>
        </div>
      </div>
      <RenameDialog agent={agent} open={renaming} onOpenChange={setRenaming} />
    </div>
  );
}

/** The rarer actions: the lead role and Proxy mode for its own Person, and clearing the name. */
function MoreActions({ agent, onRename }: { agent: Agent; onRename: () => void }) {
  const store = useStore();
  const me = useMe();
  const can = useCapabilities();
  const lead = useSetLead(agent);
  const [granting, setGranting] = useState(false);
  const mine = agent.person === me;
  const raw = agent.proxyMode === "raw";

  const setMode = async () => {
    const r = await store.source.act({ type: "proxy-mode", agent: agent.id, mode: raw ? "digest" : "raw" });
    if (!r.ok) toast.error(r.reason);
    else toast.success(raw ? "It shares digests again" : "It shares raw turns now");
  };
  if (!mine && !agent.nickname) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More actions" className={buttonVariants({ variant: "ghost" })}>
            ···
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-60">
          {mine &&
            (agent.role === "lead" ? (
              <DropdownMenuItem onSelect={() => void lead.set(false)}>Revoke the lead role</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => setGranting(true)}>Make it a lead</DropdownMenuItem>
            ))}
          {mine && can.proxyMode && (
            <DropdownMenuItem onSelect={() => void setMode()}>{raw ? "Share digests only" : "Share raw turns"}</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LeadDialog agent={agent} open={granting} onOpenChange={setGranting} />
    </>
  );
}

/** A Task the Agent holds, with its Steps: done, the one it is on, and the rest. */
function Steps({ task }: { task: Task }) {
  const next = task.steps.findIndex((s) => !s.done);
  return (
    <Section
      title={
        <a href={href({ view: "task", number: task.number })} className="hover:underline">
          #{task.number} {task.title}
        </a>
      }
      meta={
        <>
          {task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length} Steps`}
          {task.claim?.stale && <State state="stale" word="Stale Claim" className="ml-3 text-small" />}
        </>
      }
      action={
        <a href={href({ view: "task", number: task.number })} className="text-ink-2 hover:text-ink">
          Open the Task
        </a>
      }
      bodyClassName="pt-0"
    >
      {task.steps.length > 0 ? (
        <ol>
          {task.steps.map((s, i) => (
            <li key={s.index} className={cn("flex items-baseline gap-2.5 border-b border-rule py-2 text-row", s.done || i === next ? "text-ink" : "text-ink-3")}>
              <Glyph state={s.done ? "done" : i === next ? "running" : "idle"} className="relative top-px" />
              <span className="sr-only">{s.done ? "Done:" : i === next ? "In progress:" : "To do:"}</span>
              <span className="min-w-0 max-w-[72ch] [overflow-wrap:anywhere]">{s.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pt-3 text-small text-ink-3">No Steps on this Task.</p>
      )}
    </Section>
  );
}

/** The Agents this one started, as a lead (ADR 0018). */
function Children({ agents }: { agents: Agent[] }) {
  const states = useAgentStates();
  const claimsOf = useClaimsOf();
  return (
    <Section title="Children" meta={`${agents.length} ${agents.length === 1 ? "Agent" : "Agents"} this one started`} bodyClassName="pt-0">
      <ul>
        {agents.map((a) => {
          const task = claimsOf.get(a.id)?.[0];
          const percent = contextPercent(a);
          const about = [
            task && `#${task.number} ${task.title}`,
            task?.status === "review" && task.pr !== undefined && `PR #${task.pr} open`,
            percent !== undefined && `${percent}% context`,
          ].filter(Boolean);
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-2 text-row">
              <State state={states.get(a.id) ?? "gone"} person={a.person} />
              <a href={href({ view: "agent", id: a.id })} className="font-semibold text-ink hover:underline">
                {shortName(a)}
              </a>
              {about.length > 0 && <span className="min-w-0 text-small text-ink-3">{about.join(" · ")}</span>}
              <a href={href({ view: "agent", id: a.id })} className={cn(buttonVariants({ variant: "ghost", size: "xs" }), "ml-auto")}>
                Open
              </a>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

type Scoped = ReturnType<typeof useScopedHistory>;

/** Everything the Channel heard from or about this Agent, newest first, by Capture. */
function History({ scoped }: { scoped: Scoped }) {
  const { verdictsByEvent, fresh } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const [capture, setCapture] = useState<(typeof CAPTURES)[number]>("All");
  const history = useMemo(
    () =>
      scoped.events
        .filter((e) => capture === "All" || (e.capture && CAPTURE_LABEL[e.capture] === capture))
        .slice()
        .reverse(),
    [scoped.events, capture],
  );
  return (
    <section aria-label="History" className="flex min-w-0 flex-col gap-3">
      <div role="group" aria-label="Captured by" className="flex flex-wrap gap-1">
        {CAPTURES.map((c) => (
          <Chip key={c} on={capture === c} onClick={() => setCapture(c)}>
            {c}
          </Chip>
        ))}
      </div>
      <ul className="-mx-3 flex flex-col">
        {history.length === 0 ? (
          <li className="px-3 py-6 text-row text-ink-3">{scoped.loading ? "Loading" : "Nothing yet"}</li>
        ) : (
          history.map((e, i) => (
            <EventRow
              continued={i > 0 && sameSender(history[i - 1]!, e)}
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
        {scoped.more && <OlderRow loading={scoped.loading} onClick={scoped.loadOlder} className="px-3" />}
      </ul>
    </section>
  );
}

/** A Directive to this Agent: labelled as from you, the one message it treats as instruction. */
function DirectiveForm({ agent, events, inputRef }: { agent: Agent; events: ChannelEvent[]; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const store = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const today = new Date().toDateString();
  const sent = events.filter((e) => e.type === "directive" && e.payload.to === agent.id && new Date(e.at).toDateString() === today).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setBusy(true);
    const r = await store.source.act({ type: "directive", to: agent.id, text: said });
    setBusy(false);
    if (!r.ok) return toast.error(r.reason);
    setText("");
    toast.success(`Directive sent to ${agent.nickname ?? agent.id}`);
  };
  return (
    <Section title="Directive" meta="read at the start of its next turn">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="directive" className="sr-only">
          Directive to {agent.nickname ?? agent.id}
        </label>
        <textarea
          id="directive"
          ref={inputRef}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
          placeholder="Run the tests before touching web/src/pages."
          className="min-h-[76px] resize-y rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 py-2 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:text-[16px]"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={busy || !text.trim()}>
            {busy ? "Sending" : "Send"}
          </Button>
          {sent > 0 && <span className="text-small text-ink-3">{sent} sent today</span>}
        </div>
      </form>
    </Section>
  );
}

type Row = [label: string, value: React.ReactNode, note?: React.ReactNode] | false | undefined | "";

/** Label and value pairs, a small note under a value (design.md's facts list). */
function Facts({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-row">
      {rows.filter((r): r is Exclude<Row, false | undefined | ""> => Boolean(r)).map(([label, value, note]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere] text-ink">
            {value}
            {note && <span className="block text-small text-ink-3">{note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The account it runs under (ADR 0011): who, its limits and what this session used. */
function Account({ agent }: { agent: Agent }) {
  const { accounts, snapshot } = useChannel();
  const now = useNow();
  const usage = agent.usage!;
  const limits = limitsFor(agent, accounts);
  const zone = snapshot?.persons.find((p) => p.name === agent.person)?.timeZone;
  const stale = limits !== undefined && isStale(limits.readAt, now);
  const limit = (name: string, l?: { percent: number; resetsAt?: string; resets?: string }) =>
    l && ([name, `${Math.round(l.percent)}%`, resetText(l, now, zone)] as Row);
  return (
    <Section title="Account" meta={stale && limits && `stale, read ${ago(limits.readAt, now)}`}>
      <Facts
        rows={[
          (usage.email ?? usage.accountId) && ["Signed in", usage.email ?? usage.accountId, usage.plan && `${usage.plan[0]!.toUpperCase()}${usage.plan.slice(1)} plan`],
          limit("5-hour", limits?.session),
          limit("Week", limits?.week),
          usage.session && ["Requests", usage.session.requests, "this session"],
        ]}
      />
    </Section>
  );
}

/** What the Relay heard from this Agent, over the Events loaded so far. */
function Relay({ agent, events, partial }: { agent: Agent; events: ChannelEvent[]; partial: boolean }) {
  const can = useCapabilities();
  const { verdictsByEvent, olderBefore } = useChannel();
  const own = events.filter((e) => e.actor.kind === "agent" && e.actor.agentId === agent.id);
  const last = own[own.length - 1];
  const captures = [...new Set(own.map((e) => e.capture).filter((c) => c != null))].map((c) => CAPTURE_LABEL[c]);
  let interrupts = 0;
  let queued = 0;
  for (const vs of verdictsByEvent.values())
    for (const v of vs)
      if (v.agent === agent.id) {
        if (v.option === "interrupt") interrupts++;
        else if (v.option === "queue") queued++;
      }
  // Counted over the latest Events; a "+" says the Channel has older ones.
  const plus = (n: number, more: boolean) => `${n}${more ? "+" : ""}`;
  return (
    <Section title="Relay">
      <Facts
        rows={[
          ["Events", plus(own.length, partial), last && (ago(last.at) === "now" ? "the last one just now" : `the last one ${ago(last.at)}`)],
          captures.length > 0 && ["Captures", captures.join(", ")],
          can.verdicts && ["Heard", `${plus(interrupts, olderBefore !== undefined)} Interrupts, ${plus(queued, olderBefore !== undefined)} Queued`, !agent.canReceiveInterrupts && `${CLI_LABEL[agent.cli]} gets Interrupts as Queue`],
          ["Proxy mode", agent.proxyMode === "raw" ? "Raw, full turns" : "Digest", !agent.secretMasking && "Secret masking is off"],
        ]}
      />
    </Section>
  );
}

/**
 * Renames the Agent while it runs (ADR 0009). Anyone on the Channel may; the Agent ID
 * never changes, and the rename shows in the history as old → new.
 */
function RenameDialog({ agent, open, onOpenChange }: { agent: Agent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const store = useStore();
  const [name, setName] = useState(agent.nickname ?? "");
  const [busy, setBusy] = useState(false);
  // Opened again, or someone else renamed it meanwhile: start from the Channel's name.
  useEffect(() => setName(agent.nickname ?? ""), [agent.nickname, open]);
  const changed = name.trim() !== (agent.nickname ?? "");

  const save = async (nickname: string | null) => {
    setBusy(true);
    const r = await store.source.act({ type: "rename", agent: agent.id, nickname });
    setBusy(false);
    if (!r.ok) return toast.error(r.reason);
    onOpenChange(false);
    toast.success(nickname ? `${agent.id} is now ${nickname.trim()}` : `${agent.id} has no Nickname now`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void save(name.trim() || null);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Rename {agent.nickname ?? agent.id}</DialogTitle>
            <DialogDescription>Anyone on the Channel can rename an Agent while it runs. Its Agent ID never changes, and Nicknames are unique.</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5">
            <span className="text-small text-ink-3">Nickname</span>
            <input
              autoFocus
              placeholder="api-client"
              maxLength={MAX_NICKNAME_LENGTH}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-[30px] rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:text-[16px]"
            />
          </label>
          <DialogFooter>
            {agent.nickname && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)} className="sm:mr-auto">
                Clear the Nickname
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!changed || busy}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
