/*
 * The Dashboard's shell (ADR 0049, design.md "The shell"). The Dashboard has five sections,
 * one per job a Person opens it for, in the order of how often: Now (what needs you), Agents
 * (see and steer them), Tasks, Activity (catch up) and Knowledge (the Brief, the Memory Notes
 * and the shared Skills). A section with more than one view (Agents: the table, the canvas and
 * the Hosts; Knowledge: Brief, Memory, Skills) shows its views as tabs under the top bar. On a
 * desk the sections are the top bar's tabs; below 640px the same five are the tab bar at the
 * bottom, so a phone reaches every view in at most two taps and has no More menu. The only
 * coloured count is the number of lines that need you.
 */

import {
  BookOpen,
  Bot,
  Check,
  FileText,
  Inbox,
  LogOut,
  type LucideIcon,
  MessagesSquare,
  Monitor,
  Moon,
  Puzzle,
  Search,
  Server,
  Settings,
  SquareKanban,
  Sun,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Glyph, useNeedsYou } from "@/components/domain/state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUnseenInterrupts } from "@/data/interrupts";
import { useChannel, useMe, useStore } from "@/data/store";
import { localTime } from "@/lib/format";
import { href, type Route } from "@/lib/router";
import { signOut } from "@/lib/session";
import { type ThemeChoice, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type ViewId = "now" | "feed" | "tasks" | "agents" | "canvas" | "brief" | "memory" | "skills" | "hosts";
export type SectionId = "now" | "agents" | "tasks" | "feed" | "knowledge";

/** Every view, with the section it lives in. The icon is for the command palette only. */
export const VIEWS: { id: ViewId; title: string; section: SectionId; icon: LucideIcon }[] = [
  { id: "now", title: "Now", section: "now", icon: Inbox },
  { id: "agents", title: "Agents", section: "agents", icon: Bot },
  { id: "canvas", title: "Canvas", section: "agents", icon: Workflow },
  { id: "hosts", title: "Hosts", section: "agents", icon: Server },
  { id: "tasks", title: "Tasks", section: "tasks", icon: SquareKanban },
  { id: "feed", title: "Activity", section: "feed", icon: MessagesSquare },
  { id: "brief", title: "Brief", section: "knowledge", icon: FileText },
  { id: "memory", title: "Memory", section: "knowledge", icon: BookOpen },
  { id: "skills", title: "Skills", section: "knowledge", icon: Puzzle },
];

/** The five sections, in the order the bars show them; each opens at its first view. */
export const SECTIONS: { id: SectionId; title: string; home: ViewId }[] = [
  { id: "now", title: "Now", home: "now" },
  { id: "agents", title: "Agents", home: "agents" },
  { id: "tasks", title: "Tasks", home: "tasks" },
  { id: "feed", title: "Activity", home: "feed" },
  { id: "knowledge", title: "Knowledge", home: "brief" },
];

/** The view a route sits under; an address that is no page, and the settings, sit under none. */
export function viewOf(route: Route): ViewId | undefined {
  if (route.view === "task") return "tasks";
  if (route.view === "agent") return "agents";
  if (route.view === "missing" || route.view === "settings") return undefined;
  return route.view;
}

export function sectionOf(route: Route): SectionId | undefined {
  const v = viewOf(route);
  return v && VIEWS.find((x) => x.id === v)?.section;
}

/** What each section counts: every Agent, every open Task, Interrupts not yet read, and the lines that need you. */
export function useCounts() {
  const { agents, tasks } = useChannel();
  const needYou = useNeedsYou();
  const interrupts = useUnseenInterrupts();
  return useMemo(() => {
    const open = tasks.filter((t) => t.status !== "done").length;
    const stale = tasks.filter((t) => t.claim?.stale).length;
    return { agents: agents.length, needYou, tasks: open, stale, interrupts };
  }, [agents, tasks, needYou, interrupts]);
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

/** The wordmark: the jack and the name, set in the display face. */
function Wordmark({ short }: { short?: boolean }) {
  return (
    <a href={href({ view: "now" })} className="flex shrink-0 items-center gap-2 hover:no-underline" aria-label="Switchboard">
      <Mark className="size-[18px]" />
      <span className={cn("font-display text-section leading-none font-semibold text-ink", short && "max-[1000px]:hidden")}>Switchboard</span>
    </a>
  );
}

/** The count that means you are needed: the one coloured count on the Dashboard. */
function SignalCount({ n }: { n: number }) {
  return (
    <span className="inline-grid min-w-[18px] place-items-center rounded-[3px] bg-signal px-1 text-label leading-[18px] font-semibold text-signal-fg tabular-nums">
      {n}
      <span className="sr-only">{n === 1 ? " needs you" : " need you"}</span>
    </span>
  );
}

/** A quiet count beside a section's name, with what it counts for a screen reader. */
function Count({ n, label }: { n: number; label?: string }) {
  return (
    <span className="text-small font-normal text-ink-3 tabular-nums">
      {n}
      {label && <span className="sr-only"> {label}</span>}
    </span>
  );
}

/** The marks a section carries: the signal count on Now, Stale Claims on Tasks, counts elsewhere. */
function SectionMarks({ id, ready, desk }: { id: SectionId; ready: boolean; desk: boolean }) {
  const c = useCounts();
  if (!ready) return null;
  if (id === "now") return c.needYou > 0 ? <SignalCount n={c.needYou} /> : null;
  if (id === "tasks")
    return (
      <>
        {desk && <Count n={c.tasks} label="not done" />}
        {c.stale > 0 && (
          <span className="inline-flex items-center gap-0.5 text-label font-semibold text-signal tabular-nums">
            <Glyph state="stale" className="size-2.5" />
            {c.stale}
            <span className="sr-only"> stale</span>
          </span>
        )}
      </>
    );
  if (id === "agents") return desk ? <Count n={c.agents} /> : null;
  if (id === "feed") return c.interrupts > 0 ? <Count n={c.interrupts} label={c.interrupts === 1 ? "new Interrupt" : "new Interrupts"} /> : null;
  return null;
}

/** The top bar, on a desk: the wordmark, the Channel, the five sections, the People and Search. */
export function TopBar({ route, repo, onSearch }: { route: Route; repo: string; onSearch: () => void }) {
  const current = sectionOf(route);
  const { status } = useChannel();
  const ready = status === "ready";
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-stretch gap-6 border-b border-rule bg-paper px-[var(--gutter)]">
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <Wordmark short />
        <span className="max-w-[16rem] truncate text-small text-ink-3 max-[900px]:hidden" title={repo}>
          {repo}
        </span>
      </div>
      {/* The tabs scroll sideways on a window too narrow for all of them. */}
      <nav aria-label="Views" className="flex min-w-0 items-stretch gap-5 overflow-x-auto [scrollbar-width:none]">
        {SECTIONS.map((s) => {
          const on = s.id === current;
          return (
            <a
              key={s.id}
              href={href({ view: s.home })}
              aria-current={on ? "page" : undefined}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 text-row font-medium whitespace-nowrap transition-colors duration-[var(--dur)] ease-[var(--ease-out)] hover:no-underline",
                "after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5",
                on ? "text-ink after:bg-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {s.title}
              <SectionMarks id={s.id} ready={ready} desk />
            </a>
          );
        })}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <Connection />
        <People />
        <button
          type="button"
          onClick={onSearch}
          className="inline-flex h-8 items-center gap-2 rounded-[var(--r)] border border-rule-2 px-3 text-small font-medium text-ink transition-colors duration-[var(--dur)] hover:border-ink-3 hover:bg-paper-2 active:translate-y-px"
        >
          <Search className="size-3.5 text-ink-3" aria-hidden strokeWidth={2} />
          Search
          <kbd className="text-label text-ink-3 max-[800px]:hidden">⌘K</kbd>
        </button>
        <AccountMenu>
          <AccountButton />
        </AccountMenu>
      </div>
    </header>
  );
}

/** Your login, which opens your menu: the Channel's settings, the theme and signing out. */
function AccountButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const me = useMe();
  return (
    <button
      type="button"
      {...props}
      aria-label={`${me}: settings, theme and sign out`}
      className="inline-flex h-8 max-w-[10rem] items-center rounded-[var(--r)] px-2 text-small font-semibold text-ink transition-colors duration-[var(--dur)] hover:bg-paper-2 max-sm:h-11"
    >
      <span className="truncate">{me}</span>
    </button>
  );
}

/** The top bar on a phone: the wordmark, the Channel, Search and your menu. */
export function PhoneBar({ repo, onSearch }: { repo: string; onSearch: () => void }) {
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-rule bg-paper px-[var(--gutter)]">
      <Wordmark />
      <span className="min-w-0 truncate text-small text-ink-3" title={repo}>
        {repo}
      </span>
      <Connection />
      <div className="-mr-2 ml-auto flex shrink-0 items-center">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search"
          className="grid size-11 shrink-0 place-items-center rounded-[var(--r)] text-ink transition-colors hover:bg-paper-2"
        >
          <Search className="size-5" aria-hidden strokeWidth={1.75} />
        </button>
        <AccountMenu>
          <AccountButton />
        </AccountMenu>
      </div>
    </header>
  );
}

/** The phone's tab bar: the same five sections as the desk's top bar. */
export function TabBar({ route }: { route: Route }) {
  const current = sectionOf(route);
  const { status } = useChannel();
  const ready = status === "ready";
  return (
    <nav aria-label="Views" className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--tabbar-h)] border-t border-rule bg-paper pb-[env(safe-area-inset-bottom)]">
      {SECTIONS.map((s) => {
        const on = s.id === current;
        return (
          <a
            key={s.id}
            href={href({ view: s.home })}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative flex min-h-11 flex-auto flex-col items-center justify-center gap-1 px-1 text-label font-medium hover:no-underline",
              on ? "text-ink before:absolute before:top-[-1px] before:inset-x-3 before:h-0.5 before:bg-ink" : "text-ink-3",
            )}
          >
            <span className="inline-flex items-center gap-1">
              {s.title}
              <SectionMarks id={s.id} ready={ready} desk={false} />
            </span>
          </a>
        );
      })}
    </nav>
  );
}

/**
 * The views of the section a page is in, as tabs under the top bar, and inside an Agent or a
 * Task the way back. A section with one view and no trail draws nothing.
 */
export function SectionBar({ route, taskTitle }: { route: Route; taskTitle?: string }) {
  const section = sectionOf(route);
  const view = viewOf(route);
  const views = VIEWS.filter((v) => v.section === section);
  const trail =
    route.view === "task" ? (
      <span className="min-w-0 [overflow-wrap:anywhere] text-ink-2">
        #{route.number} {taskTitle}
      </span>
    ) : route.view === "agent" ? (
      <code className="min-w-0 [overflow-wrap:anywhere] text-ink-2">{route.id}</code>
    ) : null;
  if (views.length < 2 && !trail) return null;
  const sectionTitle = SECTIONS.find((s) => s.id === section)?.title ?? "";
  return (
    <div className="flex min-h-11 w-full shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-[var(--gutter)] py-1.5">
      {views.length > 1 && (
        <nav aria-label={`${sectionTitle} views`} className="-ml-2 flex min-w-0 items-center gap-1">
          {views.map((v) => {
            // On an Agent's page the Agents tab is where you are, and the way back to the table.
            const on = v.id === view;
            return (
              <a
                key={v.id}
                href={href({ view: v.id })}
                aria-current={on ? (trail === null ? "page" : "location") : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-[var(--r)] px-2 text-small font-medium whitespace-nowrap transition-colors duration-[var(--dur)] hover:no-underline max-sm:h-11 max-sm:px-3",
                  on ? "bg-paper-3 text-ink" : "text-ink-3 hover:bg-paper-2 hover:text-ink",
                )}
              >
                {v.title}
              </a>
            );
          })}
        </nav>
      )}
      {trail && (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
          {views.length < 2 && (
            <a href={href({ view: route.view === "task" ? "tasks" : "agents" })} className="hover:text-ink">
              {route.view === "task" ? "Tasks" : "Agents"}
            </a>
          )}
          <span aria-hidden>/</span>
          {trail}
        </nav>
      )}
    </div>
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

/** The stream's state, while it is not live. A Channel that failed says so on its page instead. */
function Connection() {
  const { connection, status } = useChannel();
  if (connection === "live" || status === "error") return null;
  return (
    <span role="status" className="shrink-0 text-small text-ink-3">
      {status === "loading" ? "Joining the Channel" : "Reconnecting"}
    </span>
  );
}

/** Every other Person and their local time, so a teammate's evening is visible before you ask. */
function People() {
  const { snapshot } = useChannel();
  const me = useMe();
  const now = useClock();
  const persons = (snapshot?.persons ?? []).filter((p) => p.name !== me);
  if (persons.length === 0) return null;
  return (
    <ul aria-label="People and their local time" className="flex items-center gap-3 text-small text-ink-3 max-[1180px]:hidden">
      {persons.map((p) => (
        <li key={p.name} title={p.timeZone}>
          <span className="text-ink-2">{p.name}</span> {clock(now, p.timeZone)}
        </li>
      ))}
    </ul>
  );
}

const THEMES: { id: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

/** Your menu: who you are and your time, the Channel's settings, the theme, and signing out. */
export function AccountMenu({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const { snapshot } = useChannel();
  const isMock = useStore().source.isMock;
  const { choice, set } = useTheme();
  const now = useClock();
  const mine = snapshot?.persons.find((p) => p.name === me);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="font-semibold text-ink">{me}</span>
          {mine && <span className="text-ink-3"> · {clock(now, mine.timeZone)}</span>}
          {isMock && <span className="text-ink-3"> · demo data</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={href({ view: "settings" })}>
            <Settings className="size-4 text-ink-3" aria-hidden />
            Channel settings
          </a>
        </DropdownMenuItem>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
