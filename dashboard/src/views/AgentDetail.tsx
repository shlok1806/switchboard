/*
 * An Agent's page (design.md's Agent board): its name, state and one line of facts with
 * the actions at the right; then the terminal, dark in both themes, under the Ask it is
 * waiting on, its Task's Steps and the Agents it started; and at the right the Directive,
 * the context window, the account, where it runs and what the Relay heard from it. History
 * is the other section. Below 640px the right column follows the left.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, ChannelEvent } from "@shared/index";
import { modelLabel } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { LeadDialog, useSetLead } from "@/components/domain/agent-role";
import { PendingApproval } from "@/components/domain/approval";
import { ContextWindow } from "@/components/domain/context";
import { EventRow } from "@/components/domain/log";
import { contextPercent, shortName, useClaimsOf } from "@/components/domain/fleet";
import { OlderRow } from "@/components/domain/older";
import { useIsMobile } from "@/hooks/use-mobile";
import { IssueLink } from "@/components/domain/pending";
import { RenameDialog } from "@/components/domain/rename";
import { HandOffButton, PauseResumeButton, StopAgentButton } from "@/components/domain/start-agent";
import { Facts, type Row, Steps } from "@/components/domain/agent-sections";
import { Glyph, State, useAgentState, useAgentStates } from "@/components/domain/state";
import { TerminalPanel } from "@/components/domain/terminal";
import { useNow } from "@/components/domain/usage";
import { Section } from "@/components/shell/section";
import { ErrorPage } from "@/components/shell/states";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useScopedHistory } from "@/data/history";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
import { CAPTURE_LABEL, CLI_LABEL, ago, hostName } from "@/lib/format";
import { scrollMotion } from "@/lib/motion";
import { go, href } from "@/lib/router";
import { isStale, limitsFor, resetText } from "@/lib/usage";
import { cn } from "@/lib/utils";

const CAPTURES = ["All", "Proxy", "Hook", "Tool"] as const;
type Part = "terminal" | "history";

export function AgentDetail({ id, focus }: { id: string; focus?: "directive" }) {
  const { agentById } = useIndex();
  const store = useStore();
  const [historical, setHistorical] = useState<Agent | null>();
  const current = agentById.get(id as AgentId);
  useEffect(() => {
    if (current) return;
    let active = true;
    if (typeof store.source.agent !== "function") return;
    store.source.agent(id as AgentId).then((agent) => { if (active) setHistorical(agent); });
    return () => { active = false; };
  }, [current, id, store]);
  const agent = current ?? historical;
  if (agent === undefined) return null;
  if (!agent) {
    return (
      <ErrorPage
        missing
        title="No such Agent"
        reason={id}
        actions={
          <a href={href({ view: "agents" })} className={buttonVariants({ variant: "primary" })}>
            Back to Agents
          </a>
        }
      >
        No Agent on this Channel has that ID.
      </ErrorPage>
    );
  }
  return <AgentPage key={agent.id} agent={agent} focus={focus} />;
}

function AgentPage({ agent, focus }: { agent: Agent; focus?: "directive" }) {
  const me = useMe();
  const can = useCapabilities();
  const { historicalAgents: agents } = useChannel();
  const claimsOf = useClaimsOf();
  const state = useAgentState(agent);
  const [part, setPart] = useState<Part>("terminal");
  const [renaming, setRenaming] = useState(false);
  // While Stop asks, its question is the header's only action: the others step aside until it
  // is answered or taken back, so it holds the one primary and fits a phone's row.
  const [stopAsking, setStopAsking] = useState(false);
  // Once Stop is asked for, focus lands on the Agent's name, which stays on the page.
  const heading = useRef<HTMLHeadingElement>(null);
  const directive = useRef<HTMLTextAreaElement>(null);
  // Opened to send a Directive (the Agents row menu): the field is ready to type in.
  useEffect(() => {
    if (focus !== "directive") return;
    directive.current?.focus();
    directive.current?.scrollIntoView({ block: "center" });
  }, [focus]);

  const aboutAgent = useCallback(
    (e: ChannelEvent) =>
      (e.actor.kind === "agent" && e.actor.agentId === agent.id) ||
      (e.type === "directive" && e.payload.to === agent.id) ||
      // Renamed by a Person, or its name taken while it was Gone (ADR 0009).
      (e.type === "agent.rename" && e.payload.agent === agent.id) ||
      // Stopped by its Person, on the Host that runs it (ADR 0015).
      (e.type === "agent.stop" && e.payload.agent === agent.id) ||
      // Continued by another Agent (ADR 0024).
      (e.type === "agent.handoff" && e.payload.from === agent.id),
    [agent.id],
  );
  const scoped = useScopedHistory({ agent: agent.id }, aboutAgent);

  const held = claimsOf.get(agent.id) ?? [];
  const children = agents.filter((a) => a.parent === agent.id);
  const parent = agent.parent ? agents.find((a) => a.id === agent.parent) : undefined;
  // A Hand off's two ends (ADR 0024): the Agent this one continues, and those that continue it.
  const predecessor = agent.continues ? (agents.find((a) => a.id === agent.continues) ?? agent.continues) : undefined;
  const successors = agents.filter((a) => a.continues === agent.id);
  const mine = agent.person === me;
  const canDirect = can.directives && agent.presence !== "gone";
  const asking = agent.approval !== undefined && agent.presence !== "gone";

  // Each fact keyed by what it says, so one coming or going leaves the others in place.
  const facts: [key: string, fact: ReactNode][] = [
    ["what", `${mine ? "Your" : `${agent.person}'s`} ${CLI_LABEL[agent.cli]} ${agent.host ? `on ${hostName(agent.host)}` : "in a terminal"}`],
    ["model", agent.model && `${modelLabel(agent.model)}${agent.effort ? `, ${agent.effort} effort` : ""}`],
    [
      "lead",
      agent.role === "lead" &&
        (children.length ? (
          <>
            lead of <AgentNames agents={children} />
          </>
        ) : (
          "lead"
        )),
    ],
    [
      "parent",
      parent && (
        <>
          started by <AgentName agent={parent} />
        </>
      ),
    ],
    [
      "continues",
      predecessor && (
        <>
          continued from <AgentLink agent={predecessor} />
        </>
      ),
    ],
    [
      "successors",
      successors.length > 0 && (
        <>
          handed off to <AgentNames agents={successors} link />
        </>
      ),
    ],
    ["started", `started ${ago(agent.startedAt)}`],
    ["raw", agent.proxyMode === "raw" && "shares raw turns"],
  ];
  const shown = facts.filter(([, fact]) => Boolean(fact));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-[var(--gutter)] pt-3 pb-10">
        <header className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
            <h1 ref={heading} tabIndex={-1} className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-head font-semibold [overflow-wrap:anywhere] text-ink outline-none">
              <Glyph state={state} />
              {agent.nickname ?? agent.id}
              <span title={`Last seen ${ago(agent.lastSeenAt)}`}>
                <State state={state} person={agent.person} glyph={false} className="text-row" />
              </span>
            </h1>
            <p className="text-small text-ink-3">
              {shown.map(([key, fact], i) => (
                <Fragment key={key}>
                  {i > 0 && " · "}
                  {fact}
                </Fragment>
              ))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canDirect && !stopAsking && (
              <Button
                variant="primary"
                onClick={() => {
                  directive.current?.focus({ preventScroll: true });
                  directive.current?.scrollIntoView({ block: "center", behavior: scrollMotion() });
                }}
              >
                Directive
              </Button>
            )}
            {!stopAsking && <Button onClick={() => setRenaming(true)}>Rename</Button>}
            {!stopAsking && <HandOffButton agent={agent} task={held[0]} />}
            {!stopAsking && <PauseResumeButton agent={agent} />}
            <StopAgentButton agent={agent} onAsking={setStopAsking} onStopped={() => heading.current?.focus()} />
            {!stopAsking && <MoreActions agent={agent} onRename={() => setRenaming(true)} />}
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
                    <PendingApproval
                      agent={agent}
                      heading="h2"
                      onOpenTerminal={() => {
                        const t = document.getElementById("terminal");
                        t?.scrollIntoView({ block: "start", behavior: scrollMotion() });
                        t?.focus({ preventScroll: true });
                      }}
                    />
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

/** An Agent's short name, in mono where it is an ID rather than a Nickname (design.md). */
function AgentName({ agent }: { agent: Agent | AgentId }) {
  if (typeof agent === "string") return <code>{agent}</code>;
  return agent.nickname === undefined ? <code>{shortName(agent)}</code> : <>{shortName(agent)}</>;
}

/** Agents' short names, comma separated, each a link to its page when `link` says so. */
function AgentNames({ agents, link = false }: { agents: Agent[]; link?: boolean }) {
  return (
    <>
      {agents.map((a, i) => (
        <Fragment key={a.id}>
          {i > 0 && ", "}
          {link ? <AgentLink agent={a} /> : <AgentName agent={a} />}
        </Fragment>
      ))}
    </>
  );
}

/** Another Agent's name, linking to its page; one the Channel no longer lists is its ID, as text. */
function AgentLink({ agent }: { agent: Agent | AgentId }) {
  if (typeof agent === "string") {
    return (
      <span className="text-ink-2">
        <AgentName agent={agent} />
      </span>
    );
  }
  return (
    <a href={href({ view: "agent", id: agent.id })} className="text-ink underline-offset-4 hover:underline">
      <AgentName agent={agent} />
    </a>
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
  // Another Person's Agent has nothing here the Rename button does not already offer.
  if (!mine) return null;
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
  const mobile = useIsMobile();
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
      {history.length === 0 ? (
        <p className="border-t border-rule py-6 text-row text-ink-3">{scoped.loading ? "Reading the History" : "Nothing yet."}</p>
      ) : (
        <ol className="border-t border-rule">
          {history.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              verdicts={verdictsByEvent.get(e.id) ?? []}
              selected={false}
              fresh={fresh.has(e.id)}
              onPick={() => go({ view: "feed", event: e.id })}
              mobile={mobile}
            />
          ))}
          {scoped.more && <OlderRow loading={scoped.loading} onClick={scoped.loadOlder} />}
        </ol>
      )}
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
          // Only the Events it sent itself; the History count also has Directives and renames about it.
          ["Sent", `${plus(own.length, partial)} Events`, last && (ago(last.at) === "now" ? "the last one just now" : `the last one ${ago(last.at)}`)],
          captures.length > 0 && ["Captures", captures.join(", ")],
          can.verdicts && ["Heard", `${plus(interrupts, olderBefore !== undefined)} Interrupts, ${plus(queued, olderBefore !== undefined)} Queued`, !agent.canReceiveInterrupts && `${CLI_LABEL[agent.cli]} gets Interrupts as Queue`],
          ["Proxy mode", agent.proxyMode === "raw" ? "Raw, full turns" : "Digest", !agent.secretMasking && "Secret masking is off"],
        ]}
      />
    </Section>
  );
}

