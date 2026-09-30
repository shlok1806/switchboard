/*
 * The taskbar from shlokthakkar.com (components/os/Panel.tsx): a raised bar
 * along the bottom of the screen with an Applications menu, one button per
 * window, and applets on the right. Here the "windows" are the Dashboard's
 * views, so the bar is also its navigation, on a phone as on a desk. The
 * Applications menu carries what the old sidebar did: every Agent by
 * Presence, the Person, and the desktop presets.
 */
import { useEffect, useState } from "react";
import { PixelIcon, type IconName } from "@/components/pixel-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChannel, useMe, useStore } from "@/data/store";
import { PRESENCE_LABEL } from "@/lib/format";
import { go, href, type Route } from "@/lib/router";
import { leaveChannel } from "@/lib/session";
import { PRESETS, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type View = { id: "feed" | "tasks" | "agents" | "compare"; title: string; short: string; icon: IconName };

const VIEWS: View[] = [
  { id: "feed", title: "Feed", short: "Feed", icon: "log" },
  { id: "tasks", title: "Tasks", short: "Tasks", icon: "kanban" },
  { id: "agents", title: "Agents", short: "Agents", icon: "terminal" },
  { id: "compare", title: "Compare Captures", short: "Compare", icon: "compare" },
];

function viewOf(route: Route): View["id"] {
  if (route.view === "task") return "tasks";
  if (route.view === "agent") return "agents";
  return route.view;
}

/** A 10px square swatch, the way the site marks a preset in its tube menu. */
function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={cn("size-2.5 shrink-0 border border-current", className)} />;
}

const SWATCH: Record<string, string> = {
  motif: "bg-[#000080]",
  cde: "bg-[#46698c]",
  tango: "bg-[#4e9a06]",
  twm: "bg-[#000000]",
};

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Panel({ route }: { route: Route }) {
  const { snapshot, tasks, agents, connection } = useChannel();
  const me = useMe();
  const isMock = useStore().source.isMock;
  const { choice, resolved, set } = useTheme();
  const now = useClock();
  const current = viewOf(route);
  const stale = tasks.filter((t) => t.claim?.stale).length;
  const live = agents.filter((a) => a.presence === "live").length;
  const mine = agents.filter((a) => a.person === me && a.presence !== "gone").length;
  const byPresence = [...agents].sort((a, b) => "lig".indexOf(a.presence[0]) - "lig".indexOf(b.presence[0]));
  const preset = PRESETS.find((p) => p.id === resolved)!;
  const connected = connection === "live";

  const count: Partial<Record<View["id"], { text: string; label: string; alert?: boolean }>> = {
    tasks: stale ? { text: String(stale), label: `${stale} Stale Claim`, alert: true } : undefined,
    agents: { text: String(live), label: `${live} Live` },
  };

  return (
    <nav
      aria-label="Views"
      className="bevel-out fixed inset-x-0 bottom-0 z-40 flex h-[var(--panel-h)] items-stretch border-x-0 border-b-0 bg-secondary pb-[env(safe-area-inset-bottom)] text-[13px] text-secondary-foreground select-none"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Applications"
            className="flex h-full shrink-0 items-center gap-2 border-r-2 border-border px-3 leading-none text-accent-ink data-[state=open]:bg-primary data-[state=open]:text-primary-foreground coarse:w-11 coarse:justify-center coarse:px-0"
          >
            <span aria-hidden>≡</span>
            <span className="hidden md:inline coarse:hidden">Applications</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={2} className="max-h-[min(70dvh,var(--radix-dropdown-menu-content-available-height))] min-w-[240px]">
          <DropdownMenuLabel>{snapshot?.channel.repo ?? "Channel"}</DropdownMenuLabel>
          {VIEWS.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => go({ view: v.id })} className="gap-3">
              <PixelIcon name={v.icon} />
              {v.title}
            </DropdownMenuItem>
          ))}
          {byPresence.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Agents</DropdownMenuLabel>
              {byPresence.map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => go({ view: "agent", id: a.id })}
                  className={cn("gap-3", a.presence === "gone" && "text-faint")}
                >
                  <PresenceMark presence={a.presence} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{a.id}</span>
                  {a.proxyMode === "raw" && <span className="font-mono text-[10px] tracking-[0.1em] text-orange">RAW</span>}
                  <span className="sr-only">{PRESENCE_LABEL[a.presence]}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Desktop</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => set("system")} className="gap-3">
            <span className="w-2.5 text-center" aria-hidden>{choice === "system" ? "•" : ""}</span>
            <span className="flex-1">Follow the system</span>
            <span className="text-[11px] opacity-70">Motif / Console</span>
          </DropdownMenuItem>
          {PRESETS.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => set(p.id)} className="gap-3">
              <Swatch className={SWATCH[p.id]} />
              <span className="flex-1">{p.name}</span>
              <span className="text-[11px] opacity-70">{p.code}</span>
              {choice === p.id && <span aria-hidden>•</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {me}
            {isMock ? " · demo data" : ""} · {mine} {mine === 1 ? "Agent" : "Agents"} running
          </DropdownMenuLabel>
          {!isMock && (
            <DropdownMenuItem onSelect={leaveChannel} className="gap-3">
              <PixelIcon name="leave" />
              Leave the Channel
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* One button per view: pressed in when it is the one on screen */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-[2px] overflow-x-auto px-1">
        {VIEWS.map((v) => {
          const on = v.id === current;
          const c = count[v.id];
          return (
            <a
              key={v.id}
              href={href({ view: v.id })}
              aria-current={on ? "page" : undefined}
              className={cn(
                "my-[3px] flex h-[calc(100%-6px)] min-w-0 shrink-0 items-center gap-1.5 px-2 leading-none text-secondary-foreground coarse:flex-1 coarse:flex-col coarse:justify-center coarse:gap-1 coarse:px-1 coarse:text-[11px]",
                on ? "bevel-in bg-muted font-bold" : "bevel-thin bg-secondary",
              )}
            >
              <PixelIcon name={v.icon} />
              <span className="flex items-center gap-1">
                <span className="hidden sm:inline coarse:inline">{v.short === v.title ? v.title : <><span className="hidden lg:inline">{v.title}</span><span className="lg:hidden">{v.short}</span></>}</span>
                {c && (
                  <span
                    aria-label={c.label}
                    className={cn(
                      "px-1 font-mono text-[10.5px] leading-[14px] font-normal",
                      c.alert ? "bg-destructive text-destructive-foreground" : "text-faint",
                    )}
                  >
                    {c.text}
                  </span>
                )}
              </span>
            </a>
          );
        })}
      </div>

      <span aria-hidden className="my-[3px] w-px shrink-0 bg-border coarse:hidden" />

      {/* The preset selector; on a phone it lives in the Applications menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Change desktop"
            className="bevel-thin my-[3px] ml-[3px] hidden items-center gap-2 bg-secondary px-2.5 leading-none data-[state=open]:bevel-thin-in md:flex coarse:hidden"
          >
            <Swatch className={SWATCH[preset.id]} />
            {preset.name}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" sideOffset={2} className="min-w-[210px]">
          <DropdownMenuLabel>Desktop</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => set("system")} className="gap-3">
            <span className="w-2.5 text-center" aria-hidden>{choice === "system" ? "•" : ""}</span>
            <span className="flex-1">Follow the system</span>
          </DropdownMenuItem>
          {PRESETS.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => set(p.id)} className="gap-3">
              <Swatch className={SWATCH[p.id]} />
              <span className="flex-1">{p.name}</span>
              <span className="text-[11px] opacity-70">{p.code}</span>
              {choice === p.id && <span aria-hidden>•</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Applets: the link to the Channel, and the clock */}
      <span
        className="bevel-thin-in my-[3px] ml-[3px] hidden items-center gap-1.5 px-2 leading-none sm:flex coarse:hidden"
        title={connected ? "Connected to the Channel" : "Reconnecting to the Channel"}
      >
        <span aria-hidden className={cn("size-2 shrink-0", connected ? "bg-green" : "bg-orange")} />
        <span className="font-mono text-[11.5px]">{connected ? "live" : "wait"}</span>
      </span>
      <span className="bevel-thin-in my-[3px] mr-[3px] ml-[3px] hidden items-center gap-1.5 px-2 leading-none tabular-nums lg:flex coarse:hidden">
        <PixelIcon name="clock" />
        {now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--"}
      </span>
    </nav>
  );
}

/** Live is a filled square, Idle a hollow one, Gone a dot: shape carries it, not only colour. */
export function PresenceMark({ presence, className }: { presence: "live" | "idle" | "gone"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0",
        presence === "live" && "size-2 bg-green",
        presence === "idle" && "size-2 border border-orange",
        presence === "gone" && "size-1 bg-faint",
        className,
      )}
    />
  );
}
