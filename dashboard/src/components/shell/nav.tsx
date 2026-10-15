/*
 * The Dashboard's top bar and phone tab bar (ADR 0023, design.md). On a desk the views are
 * keys in a 44px top bar, the current one pressed, with the channel path and every Person's
 * local time; at or below 640px they move to a 56px tab bar at the bottom, where a thumb
 * reaches them. The only coloured count is the number of lines that need you.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, BookOpen, Check, Columns3, Inbox, LogOut, MessagesSquare, Monitor, Moon, Search, Server, SquareKanban, Sun, Workflow, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNeedsYou } from "@/components/domain/state";
import { useChannel, useMe, useStore } from "@/data/store";
import { localTime } from "@/lib/format";
import { href, type Route } from "@/lib/router";
import { signOut } from "@/lib/session";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type ViewId = "now" | "feed" | "tasks" | "agents" | "canvas" | "compare" | "memory" | "hosts";

/** The views, in the order the keys show them. The icon is for the command palette only. */
export const VIEWS: { id: ViewId; title: string; icon: LucideIcon }[] = [
  { id: "now", title: "Now", icon: Inbox },
  { id: "agents", title: "Agents", icon: Bot },
  { id: "tasks", title: "Tasks", icon: SquareKanban },
  { id: "canvas", title: "Canvas", icon: Workflow },
  { id: "feed", title: "Activity", icon: MessagesSquare },
  { id: "memory", title: "Memory", icon: BookOpen },
  { id: "hosts", title: "Hosts", icon: Server },
  { id: "compare", title: "Compare", icon: Columns3 },
];

export function viewOf(route: Route): ViewId {
  if (route.view === "task") return "tasks";
  if (route.view === "agent") return "agents";
  return route.view;
}

/** What each key counts: every Agent and every open Task, and the lines that need you. */
export function useCounts() {
  const { agents, tasks } = useChannel();
  const needYou = useNeedsYou();
  return useMemo(() => {
    const open = tasks.filter((t) => t.status !== "done").length;
    return { agents: agents.length, needYou, tasks: open };
  }, [agents, tasks, needYou]);
}

/** The mark: a jack, a square socket with its plug seated. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4 shrink-0 text-ink", className)}>
      <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" />
    </svg>
  );
}

/** The count that means you are needed: the one coloured count on the Dashboard. */
function SignalCount({ n }: { n: number }) {
  return (
    <span className="rounded-[2px] bg-signal px-[5px] py-px text-label leading-[1.35] font-semibold text-signal-fg tabular-nums">
      {n}
      <span className="sr-only">{n === 1 ? " needs you" : " need you"}</span>
    </span>
  );
}

/** A view as a key: pressed (solid ink) when current. */
function Key({ view, current, count, needYou }: { view: (typeof VIEWS)[number]; current: boolean; count?: number; needYou?: number }) {
  return (
    <a
      href={href({ view: view.id })}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[var(--r)] px-2 text-small font-medium whitespace-nowrap transition-colors duration-[var(--dur)] ease-[var(--ease-out)] hover:no-underline",
        current ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2 hover:text-ink",
      )}
    >
      {view.title}
      {needYou ? (
        <SignalCount n={needYou} />
      ) : (
        count !== undefined && <span className={cn("text-[12px] tabular-nums", current ? "text-paper/70" : "text-ink-3")}>{count}</span>
      )}
    </a>
  );
}

/** The top bar, on a desk. */
export function TopBar({ route, repo, onSearch }: { route: Route; repo: string; onSearch: () => void }) {
  const current = viewOf(route);
  const c = useCounts();
  const counts: Partial<Record<ViewId, number>> = { agents: c.agents, tasks: c.tasks };
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-4 border-b border-rule bg-paper px-[var(--gutter)]">
      <a href={href({ view: "now" })} className="flex shrink-0 items-center gap-2 hover:no-underline" aria-label="Switchboard">
        <Mark />
        <span className="text-title font-semibold text-ink">Switchboard</span>
      </a>
      <code className="min-w-0 truncate text-small text-ink-3 max-[900px]:hidden" title={repo}>
        {repo}
      </code>
      <nav aria-label="Views" className="flex items-center gap-1">
        {VIEWS.map((v) => (
          <Key key={v.id} view={v} current={v.id === current} count={counts[v.id]} needYou={v.id === "now" ? c.needYou : undefined} />
        ))}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <Connection />
        <People />
        <button
          type="button"
          onClick={onSearch}
          className="inline-flex h-[30px] items-center gap-2 rounded-[var(--r)] border border-rule-2 px-2.5 text-small font-medium text-ink transition-colors duration-[var(--dur)] hover:border-ink-3 hover:bg-paper-2 active:translate-y-px"
        >
          Search
          <kbd className="rounded-[2px] border border-current px-1 pt-0.5 pb-px text-[11.5px] leading-none opacity-55">⌘K</kbd>
        </button>
      </div>
    </header>
  );
}

/** The top bar on a phone: the wordmark, the channel, and Search. */
export function PhoneBar({ repo, onSearch }: { repo: string; onSearch: () => void }) {
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-rule bg-paper px-[var(--gutter)]">
      <a href={href({ view: "now" })} className="flex shrink-0 items-center gap-2 hover:no-underline" aria-label="Switchboard">
        <Mark />
        <span className="text-title font-semibold text-ink">Switchboard</span>
      </a>
      <code className="min-w-0 truncate text-small text-ink-3" title={repo}>
        {repo}
      </code>
      <Connection />
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className="-mr-2 ml-auto grid size-11 shrink-0 place-items-center rounded-[var(--r)] text-ink transition-colors hover:bg-paper-2"
      >
        <Search className="size-5" aria-hidden strokeWidth={1.75} />
      </button>
    </header>
  );
}

/** The views the phone's tab bar shows; the rest are under More. */
const TABS: ViewId[] = ["now", "agents", "tasks", "feed"];

/** The phone's tab bar: four views and More. */
export function TabBar({ route }: { route: Route }) {
  const current = viewOf(route);
  const c = useCounts();
  const tabs = VIEWS.filter((v) => TABS.includes(v.id));
  const tab = (on: boolean) =>
    cn(
      "relative flex min-h-11 flex-col items-center justify-center text-small font-medium hover:no-underline",
      on ? "text-ink before:absolute before:top-0 before:left-1/2 before:h-0.5 before:w-7 before:-translate-x-1/2 before:bg-ink" : "text-ink-3",
    );
  return (
    <nav
      aria-label="Views"
      className="fixed inset-x-0 bottom-0 z-40 grid h-[var(--tabbar-h)] grid-cols-5 border-t border-rule bg-paper pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((v) => (
        <a key={v.id} href={href({ view: v.id })} aria-current={v.id === current ? "page" : undefined} className={tab(v.id === current)}>
          <span className="inline-flex items-center gap-1.5">
            {v.title}
            {v.id === "now" && c.needYou > 0 && <SignalCount n={c.needYou} />}
          </span>
        </a>
      ))}
      <MoreMenu className={tab(!TABS.includes(current))} current={!TABS.includes(current)} />
    </nav>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const clock = (at: Date, timeZone: string) => localTime(at, timeZone) || localTime(at, Intl.DateTimeFormat().resolvedOptions().timeZone);

/** Shown only while the Channel's live stream is down. */
function Connection() {
  const { connection } = useChannel();
  if (connection === "live") return null;
  return (
    <span role="status" className="shrink-0 text-small text-ink-3">
      Reconnecting
    </span>
  );
}

/** Every Person and their local time, you first and in bold; yours opens your menu. */
function People() {
  const { snapshot } = useChannel();
  const me = useMe();
  const now = useClock();
  const persons = [...(snapshot?.persons ?? [])].sort((a, b) => (a.name === me ? -1 : b.name === me ? 1 : 0));
  const mine = persons.find((p) => p.name === me);
  return (
    <div className="flex items-center gap-3 text-small text-ink-3 tabular-nums max-[1180px]:hidden">
      <AccountMenu>
        <button type="button" className="rounded-[var(--r)] text-ink-3 hover:text-ink" aria-label={`${me}: theme and sign out`}>
          <span className="font-semibold text-ink">{me}</span> {mine && clock(now, mine.timeZone)}
        </button>
      </AccountMenu>
      {persons
        .filter((p) => p.name !== me)
        .map((p) => (
          <span key={p.name} title={p.timeZone}>
            <span className="text-ink-2">{p.name}</span> {clock(now, p.timeZone)}
          </span>
        ))}
      {!mine && (
        <AccountMenu>
          <button type="button" className="font-semibold text-ink">
            {me}
          </button>
        </AccountMenu>
      )}
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export function initials(name: string) {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function MenuItems({ withViews }: { withViews?: boolean }) {
  const me = useMe();
  const isMock = useStore().source.isMock;
  const { choice, set } = useTheme();
  return (
    <>
      <DropdownMenuLabel className="font-normal">
        <span className="font-semibold text-ink">{me}</span>
        {isMock && <span className="text-ink-3"> · demo data</span>}
      </DropdownMenuLabel>
      {withViews && (
        <>
          <DropdownMenuSeparator />
          {VIEWS.filter((v) => !TABS.includes(v.id)).map((v) => (
            <DropdownMenuItem key={v.id} asChild>
              <a href={href({ view: v.id })}>{v.title}</a>
            </DropdownMenuItem>
          ))}
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="py-1 text-small font-normal text-ink-3">Theme</DropdownMenuLabel>
      {THEMES.map((t) => (
        <DropdownMenuItem key={t.id} onSelect={() => set(t.id)}>
          <span className="flex-1">{t.label}</span>
          {choice === t.id && <Check className="size-4 text-ink" aria-label="Current" />}
        </DropdownMenuItem>
      ))}
      {!isMock && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut className="size-4 text-ink-3" aria-hidden />
            Sign out
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

/** Your menu: the theme, and signing out. */
export function AccountMenu({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-52">
        <MenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The phone's More tab: the views the tab bar leaves out, the theme, and signing out. */
function MoreMenu({ className, current }: { className: string; current: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={className} aria-current={current ? "page" : undefined}>
          More
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-52">
        <MenuItems withViews />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
