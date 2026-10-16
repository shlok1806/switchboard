/*
 * The command palette (plan, Palette): ⌘K everywhere, and `/` on a list. One search over
 * Commands, Agents, Tasks, Views and Theme. A command that needs an argument takes it in a
 * second step: Directive to, then an Agent, then the text; Stop, then one of your Agents, then
 * a confirmation; Take over, then a Stale Task; Watch, then an Agent. The steps so far sit as
 * a trail over the input. Backspace in an empty input, or Escape, goes back one step. Agents
 * this viewer picked lately come first.
 */
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, ChevronRight, Eye, Monitor, Moon, Plus, Rows2, Rows3, Send, Square, Sun, UserRoundCheck } from "lucide-react";
import type { Agent, Task } from "@shared/index";
import { VIEWS } from "@/components/shell/nav";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { canStop, openStartAgent } from "@/components/domain/start-agent";
import { ownedName } from "@/components/domain/fleet";
import { useHostsSupported } from "@/data/hosts";
import { useCapabilities, useChannel, useMe, useStore } from "@/data/store";
import { channelBase, channelRepo, wantsMock } from "@/lib/session";
import { go, type Route } from "@/lib/router";
import { setDensity, useDensity } from "@/lib/density";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { PRESENCE_LABEL } from "@/lib/format";
import { pickedAgent, recentAgents } from "@/lib/recent";

const THEMES: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System theme", icon: Monitor },
  { id: "light", label: "Light theme", icon: Sun },
  { id: "dark", label: "Dark theme", icon: Moon },
];

/** The commands that act on an Agent picked in the next step. */
type AgentCommand = "directive" | "stop" | "watch";

type Step =
  | { kind: "root" }
  | { kind: "agent"; command: AgentCommand }
  | { kind: "directive"; agent: Agent }
  | { kind: "stop"; agent: Agent }
  | { kind: "takeover" };

const COMMAND_LABEL: Record<AgentCommand | "takeover", string> = {
  directive: "Directive to",
  stop: "Stop",
  watch: "Watch",
  takeover: "Take over",
};

const PLACEHOLDER: Record<Step["kind"], string> = {
  root: "Search commands, Agents, Tasks and views",
  agent: "Pick an Agent",
  directive: "Type the Directive",
  stop: "Enter stops it; Escape keeps it running",
  takeover: "Pick a Stale Task",
};

/** The views whose page is a list: there `/` opens the palette, or the page's own Find. */
const LISTS = new Set<Route["view"]>(["now", "agents", "tasks", "canvas", "feed", "memory", "hosts"]);

/** Whether a key press is typing into a field, where `/` is a character and not a shortcut. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest("[role=dialog]") !== null;
}

// The deployment's Channels, read once a session: they change only with a deploy.
let channelsRead: Promise<string[]> | undefined;

function readChannels(): Promise<string[]> {
  channelsRead ??= fetch(`${channelBase()}/auth/config`, { credentials: "include" })
    .then((r) => (r.ok ? (r.json() as Promise<{ repos?: string[] }>) : null))
    .then((c) => c?.repos ?? [])
    .catch(() => {
      // Read again on the next opening.
      channelsRead = undefined;
      return [];
    });
  return channelsRead;
}

/** The other Channels this deployment serves, to switch to; none for the simulated one. */
function useOtherChannels(open: boolean): string[] {
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    if (!open || wantsMock()) return;
    let live = true;
    void readChannels().then((all) => {
      const here = channelRepo();
      if (live) setRepos(all.filter((r) => r !== here));
    });
    return () => {
      live = false;
    };
  }, [open]);
  return repos;
}

export function CommandPalette({ open, onOpenChange, route }: { open: boolean; onOpenChange: (o: boolean) => void; route: Route }) {
  const { tasks, agents } = useChannel();
  const store = useStore();
  const me = useMe();
  const can = useCapabilities();
  const { choice, set } = useTheme();
  const hosts = useHostsSupported();
  const density = useDensity();
  const channels = useOtherChannels(open);
  const [step, setStep] = useState<Step>({ kind: "root" });
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !open && LISTS.has(route.view) && !typing(e.target)) {
        e.preventDefault();
        // A list with its own Find (Memory) searches there; the rest open the palette.
        const find = document.querySelector<HTMLElement>("[data-slash-find]");
        if (find) find.focus();
        else onOpenChange(true);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange, route.view]);

  // Each opening starts at the top.
  useEffect(() => {
    if (open) {
      setStep({ kind: "root" });
      setSearch("");
    }
  }, [open]);

  const to = (next: Step) => {
    setStep(next);
    setSearch("");
  };
  const back = () => {
    if (step.kind === "directive" || step.kind === "stop") to({ kind: "agent", command: step.kind });
    else to({ kind: "root" });
  };
  const close = () => onOpenChange(false);
  const run = (r: Route) => {
    close();
    go(r);
  };

  const recent = recentAgents();
  const byRecent = (list: Agent[]) => {
    const rank = (a: Agent) => {
      const i = recent.indexOf(a.id);
      return i === -1 ? recent.length : i;
    };
    return [...list].sort((a, b) => rank(a) - rank(b));
  };
  const reachable = agents.filter((a) => a.presence !== "gone");
  const stoppable = agents.filter((a) => canStop(a, me));
  const stale = tasks.filter((t) => t.claim?.stale).sort((a, b) => a.number - b.number);
  const forCommand: Record<AgentCommand, Agent[]> = { directive: reachable, stop: stoppable, watch: agents };

  const pickAgent = (command: AgentCommand, a: Agent) => {
    pickedAgent(a.id);
    if (command === "watch") return run({ view: "agent", id: a.id });
    to({ kind: command, agent: a });
  };

  const sendDirective = async (a: Agent) => {
    const text = search.trim();
    if (!text || busy) return;
    setBusy(true);
    const r = await store.source.act({ type: "directive", to: a.id, text });
    setBusy(false);
    if (!r.ok) return void toast.error(`Could not send the Directive to ${ownedName(a)}`, { description: r.reason });
    toast.success(`Directive sent to ${ownedName(a)}`, { description: text });
    close();
  };

  const stop = async (a: Agent) => {
    if (busy) return;
    setBusy(true);
    const r = await store.source.stopAgent(a.id);
    setBusy(false);
    if (!r.ok) return void toast.error(`Could not stop ${ownedName(a)}`, { description: r.reason });
    toast.success(`Asked ${ownedName(a)} to stop`, { description: "It goes Gone when its Host ends the session." });
    close();
  };

  const takeOver = async (t: Task) => {
    if (busy) return;
    setBusy(true);
    const r = await store.source.act({ type: "takeover", task: t.number, to: { kind: "person", person: me } });
    setBusy(false);
    if (!r.ok) return void toast.error(`Could not take over #${t.number}`, { description: r.reason });
    toast.success(`You hold #${t.number} now`, { description: t.title });
    close();
  };

  // The trail of the steps so far, over the input.
  const trail: string[] =
    step.kind === "agent"
      ? [COMMAND_LABEL[step.command]]
      : step.kind === "directive" || step.kind === "stop"
        ? [COMMAND_LABEL[step.kind], ownedName(step.agent)]
        : step.kind === "takeover"
          ? [COMMAND_LABEL.takeover]
          : [];

  const agentRow = (a: Agent, onSelect: () => void, value: string) => (
    <CommandItem key={a.id} value={value} onSelect={onSelect}>
      <span className="truncate font-medium">{a.id}</span>
      {a.nickname && <span className="truncate text-ink-3">{a.nickname}</span>}
      <CommandShortcut>{PRESENCE_LABEL[a.presence]}</CommandShortcut>
    </CommandItem>
  );
  const agentGroups = (list: Agent[], onPick: (a: Agent) => void, prefix: string) => {
    const sorted = byRecent(list);
    const lately = sorted.filter((a) => recent.includes(a.id));
    const rest = sorted.filter((a) => !recent.includes(a.id));
    return (
      <>
        {lately.length > 0 && (
          <CommandGroup heading="Recent">{lately.map((a) => agentRow(a, () => onPick(a), `${prefix} ${a.id} ${a.nickname ?? ""}`))}</CommandGroup>
        )}
        {rest.length > 0 && (
          <CommandGroup heading={lately.length > 0 ? "Everyone else" : "Agents"}>
            {rest.map((a) => agentRow(a, () => onPick(a), `${prefix} ${a.id} ${a.nickname ?? ""}`))}
          </CommandGroup>
        )}
      </>
    );
  };

  let body: ReactNode;
  if (step.kind === "agent") {
    const list = forCommand[step.command];
    body = (
      <>
        <CommandEmpty>{list.length === 0 ? (step.command === "stop" ? "None of your Agents runs on a Host." : "No Agent is on the Channel.") : "No Agent matches."}</CommandEmpty>
        {agentGroups(list, (a) => pickAgent(step.command, a), "")}
      </>
    );
  } else if (step.kind === "directive") {
    const text = search.trim();
    body = (
      <CommandGroup heading={`Read by ${ownedName(step.agent)} at the start of its next turn`}>
        <CommandItem value="send" disabled={!text || busy} onSelect={() => void sendDirective(step.agent)}>
          <Send aria-hidden />
          {text ? (
            <span className="min-w-0 truncate">
              Send <span className="text-ink">“{text}”</span>
            </span>
          ) : (
            <span className="text-ink-3">Type the Directive, then press Enter to send it</span>
          )}
          {busy && <CommandShortcut>Sending</CommandShortcut>}
        </CommandItem>
      </CommandGroup>
    );
  } else if (step.kind === "stop") {
    body = (
      <CommandGroup heading={`Its session on ${step.agent.host ?? "its Host"} ends and it goes Gone`}>
        <CommandItem value="stop" disabled={busy} onSelect={() => void stop(step.agent)} className="font-medium">
          <Square aria-hidden /> Stop {ownedName(step.agent)}
          {busy && <CommandShortcut>Stopping</CommandShortcut>}
        </CommandItem>
        <CommandItem value="keep" disabled={busy} onSelect={back}>
          Keep it running
        </CommandItem>
      </CommandGroup>
    );
  } else if (step.kind === "takeover") {
    body = (
      <>
        <CommandEmpty>{stale.length === 0 ? "No Task is Stale." : "No Stale Task matches."}</CommandEmpty>
        <CommandGroup heading="Stale Tasks: you hold the one you pick">
          {stale.map((t) => (
            <CommandItem key={t.number} value={`#${t.number} ${t.title}`} disabled={busy} onSelect={() => void takeOver(t)}>
              <span className="text-small text-ink-3 tabular-nums">#{t.number}</span>
              <span className="truncate">{t.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </>
    );
  } else {
    const command = (id: string, label: string, icon: typeof Sun, onSelect: () => void, next: boolean) => {
      const Icon = icon;
      return (
        <CommandItem key={id} value={label} onSelect={onSelect}>
          <Icon aria-hidden /> {label}
          {next && <ChevronRight aria-hidden className="ml-auto text-ink-3" />}
        </CommandItem>
      );
    };
    body = (
      <>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Commands">
          {can.directives && reachable.length > 0 && command("directive", "Directive to", Send, () => to({ kind: "agent", command: "directive" }), true)}
          {stoppable.length > 0 && command("stop", "Stop", Square, () => to({ kind: "agent", command: "stop" }), true)}
          {can.takeover && stale.length > 0 && command("takeover", "Take over", UserRoundCheck, () => to({ kind: "takeover" }), true)}
          {agents.length > 0 && command("watch", "Watch", Eye, () => to({ kind: "agent", command: "watch" }), true)}
          {hosts &&
            command(
              "start",
              "Start an Agent",
              Plus,
              () => {
                close();
                openStartAgent();
              },
              false,
            )}
          {channels.map((repo) => command(`channel ${repo}`, `Switch to ${repo}`, ArrowLeftRight, () => window.location.assign(`/${repo}`), false))}
        </CommandGroup>
        {agents.length > 0 && agentGroups(agents, (a) => {
          pickedAgent(a.id);
          run({ view: "agent", id: a.id });
        }, "Agent")}
        {tasks.length > 0 && (
          <CommandGroup heading="Tasks">
            {[...tasks]
              .sort((a, b) => a.number - b.number)
              .map((t) => (
                <CommandItem key={t.number} value={`#${t.number} ${t.title}`} onSelect={() => run({ view: "task", number: t.number })}>
                  <span className="text-small text-ink-3 tabular-nums">#{t.number}</span>
                  <span className="truncate">{t.title}</span>
                  {t.claim?.stale && <CommandShortcut className="text-ink">Stale</CommandShortcut>}
                </CommandItem>
              ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Views">
          {VIEWS.map((v) => (
            <CommandItem key={v.id} value={`View ${v.title}`} onSelect={() => run({ view: v.id })}>
              <v.icon aria-hidden /> {v.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Theme">
          {THEMES.map((t) => (
            <CommandItem
              key={t.id}
              value={`Theme ${t.label}`}
              onSelect={() => {
                set(t.id);
                close();
              }}
            >
              <t.icon aria-hidden /> {t.label}
              {choice === t.id && <CommandShortcut>Current</CommandShortcut>}
            </CommandItem>
          ))}
          {(
            [
              { id: "comfortable", label: "Comfortable rows", icon: Rows2 },
              { id: "compact", label: "Compact rows", icon: Rows3 },
            ] as const
          ).map((d) => (
            <CommandItem
              key={d.id}
              value={`Density ${d.label}`}
              onSelect={() => {
                setDensity(d.id);
                close();
              }}
            >
              <d.icon aria-hidden /> {d.label}
              {density === d.id && <CommandShortcut>Current</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
      </>
    );
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Search commands, Agents, Tasks and views"
      // Pinned near the top, so the input stays put as a step's list grows or shrinks.
      className="top-[12vh] translate-y-0"
      // The Directive's text and the Stop question are not searches.
      shouldFilter={step.kind !== "directive" && step.kind !== "stop"}
      onEscapeKeyDown={(e) => {
        if (step.kind !== "root") {
          e.preventDefault();
          back();
        }
      }}
    >
      {trail.length > 0 && (
        <ol aria-label="Steps" className="flex min-w-0 items-center gap-1 pt-2.5 pr-12 pb-1 pl-3 text-small">
          {trail.map((t, i) => (
            <li key={t} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-ink-3" />}
              <span className="truncate rounded-[var(--r)] bg-paper-2 px-1.5 py-0.5 font-medium text-ink">{t}</span>
            </li>
          ))}
          <li className="ml-auto shrink-0 text-ink-3">
            <kbd className="font-mono">⌫</kbd> back
          </li>
        </ol>
      )}
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={PLACEHOLDER[step.kind]}
        aria-label={PLACEHOLDER[step.kind]}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && search === "" && step.kind !== "root") {
            e.preventDefault();
            back();
          }
        }}
      />
      <CommandList>{body}</CommandList>
    </CommandDialog>
  );
}

export function usePaletteState() {
  return useState(false);
}
