/*
 * The Dashboard's navigation: four views, always in the same place. On a desk
 * they are tabs in the top bar; on a phone they move to a tab bar at the
 * bottom, where a thumb reaches them. The account menu (theme, sign out) sits at
 * the right end of the top bar on both.
 */
import { useEffect, useState } from "react";
import { Bot, Check, Columns3, LogOut, MessagesSquare, Monitor, Moon, Search, SquareKanban, Sun, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannel, useMe, useStore } from "@/data/store";
import { href, type Route } from "@/lib/router";
import { signOut } from "@/lib/session";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type ViewId = "feed" | "tasks" | "agents" | "compare";

export const VIEWS: { id: ViewId; title: string; icon: LucideIcon }[] = [
  { id: "feed", title: "Activity", icon: MessagesSquare },
  { id: "tasks", title: "Board", icon: SquareKanban },
  { id: "agents", title: "Agents", icon: Bot },
  { id: "compare", title: "Compare", icon: Columns3 },
];

export function viewOf(route: Route): ViewId {
  if (route.view === "task") return "tasks";
  if (route.view === "agent") return "agents";
  return route.view;
}

/** A small count beside a tab: red when something needs a Person. */
function useBadges(): Partial<Record<ViewId, { n: number; label: string; alert?: boolean }>> {
  const { tasks, agents } = useChannel();
  const stale = tasks.filter((t) => t.claim?.stale).length;
  const live = agents.filter((a) => a.presence === "live").length;
  return {
    tasks: stale
      ? { n: stale, label: `${stale} Stale ${stale === 1 ? "Claim" : "Claims"}`, alert: true }
      : { n: tasks.length, label: `${tasks.length} Tasks` },
    agents: { n: live, label: `${live} Live` },
  };
}

function Badge({ n, label, alert }: { n: number; label: string; alert?: boolean }) {
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "min-w-[18px] rounded-full px-1.5 text-center font-mono text-[11px] leading-[18px] tabular-nums",
        alert ? "bg-red text-on-accent" : "bg-hover-2 text-ink-3",
      )}
    >
      {n}
    </span>
  );
}

/** Top-bar tabs, for a desk. */
export function ViewTabs({ route }: { route: Route }) {
  const current = viewOf(route);
  const badges = useBadges();
  return (
    <nav aria-label="Views" className="flex h-full items-stretch gap-1">
      {VIEWS.map((v) => {
        const on = v.id === current;
        const b = badges[v.id];
        return (
          <a
            key={v.id}
            href={href({ view: v.id })}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-2 rounded-md px-3 text-[14px] transition-colors",
              on ? "font-medium text-ink" : "text-ink-3 hover:text-ink",
            )}
          >
            <v.icon className="size-4" aria-hidden strokeWidth={1.75} />
            {v.title}
            {b && <Badge {...b} />}
            {on && <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </a>
        );
      })}
    </nav>
  );
}

/** Bottom tab bar, for a phone. */
export function TabBar({ route }: { route: Route }) {
  const current = viewOf(route);
  const badges = useBadges();
  return (
    <nav
      aria-label="Views"
      className="fixed inset-x-0 bottom-0 z-40 grid h-[var(--tabbar-h)] grid-cols-4 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      {VIEWS.map((v) => {
        const on = v.id === current;
        const b = badges[v.id];
        return (
          <a
            key={v.id}
            href={href({ view: v.id })}
            aria-current={on ? "page" : undefined}
            className={cn("flex flex-col items-center justify-center gap-1 text-[11.5px]", on ? "font-medium text-accent-ink" : "text-ink-3")}
          >
            <span className="relative">
              <v.icon className="size-5" aria-hidden strokeWidth={on ? 2 : 1.75} />
              {b?.alert && (
                <span aria-label={b.label} className="absolute -top-1 -right-2 min-w-4 rounded-full bg-red px-1 text-center font-mono text-[10px] leading-4 text-on-accent">
                  {b.n}
                </span>
              )}
            </span>
            {v.title}
          </a>
        );
      })}
    </nav>
  );
}

export function SearchButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  const icon = (className = "") => (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search"
      className={cn("grid size-9 place-items-center rounded-md text-ink-2 hover:bg-hover", className)}
    >
      <Search className="size-[18px]" aria-hidden />
    </button>
  );
  if (compact) return icon();
  // The full field only where the top bar has room for it beside the tabs.
  return (
    <>
      {icon("lg:hidden")}
      <button
        type="button"
        onClick={onClick}
        className="hidden h-8 w-56 items-center gap-2 rounded-md border border-line bg-inset px-2.5 text-[13px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2 lg:flex"
      >
        <Search className="size-3.5" aria-hidden />
        Search
        <kbd className="ml-auto rounded border border-line bg-surface px-1 font-mono text-[11px] leading-4">⌘K</kbd>
      </button>
    </>
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

/** One dot: green when the Channel's live stream is up, amber while it reconnects. */
export function ConnectionDot() {
  const { connection } = useChannel();
  const now = useClock();
  const live = connection === "live";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="grid size-8 place-items-center rounded-md outline-none">
          <span aria-hidden className={cn("size-2 rounded-full", live ? "bg-green" : "bg-orange")} />
          <span className="sr-only">{live ? "Connected" : "Reconnecting"}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {live ? "Connected" : "Reconnecting"} · {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </TooltipContent>
    </Tooltip>
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

/** The Person's GitHub avatar, or their initials while it loads or when it cannot. */
function Avatar({ login, demo }: { login: string; demo: boolean }) {
  const [failed, setFailed] = useState(false);
  const initialsTile = (
    <span className="grid size-8 place-items-center rounded-full bg-accent-tint text-[12px] font-semibold text-accent-ink">
      {initials(login)}
    </span>
  );
  // The demo's Persons are made up: no GitHub account to show.
  if (demo || failed) return initialsTile;
  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=64`}
      alt=""
      width={32}
      height={32}
      onError={() => setFailed(true)}
      className="size-8 rounded-full bg-accent-tint object-cover"
    />
  );
}

/** The Person's menu: who they are (their GitHub login), the theme, and signing out. */
export function AccountMenu() {
  const me = useMe();
  const { agents } = useChannel();
  const isMock = useStore().source.isMock;
  const { choice, set } = useTheme();
  const mine = agents.filter((a) => a.person === me && a.presence !== "gone").length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Account: ${me}`} className="rounded-full outline-offset-2">
          <Avatar login={me} demo={isMock} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="text-[14px] font-medium text-ink">{me}</span>
          <span className="text-[12px] text-ink-3">
            {mine} {mine === 1 ? "Agent" : "Agents"} running{isMock ? " · demo data" : ""}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="py-1 text-[11.5px] font-normal text-ink-3">Theme</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => set(t.id)}>
            <t.icon className="size-4 text-ink-3" aria-hidden />
            <span className="flex-1">{t.label}</span>
            {choice === t.id && <Check className="size-4 text-accent-ink" aria-label="Current" />}
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
