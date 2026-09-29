import { Suspense, lazy, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Search } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Banner, BannerAction, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import LoadingState from "@/components/primitives/LoadingState";
import { CommandPalette } from "@/components/domain/palette";
import { useChannel, useIndex, useStore } from "@/data/store";
import { go, useRoute, type Route } from "@/lib/router";
// One chunk per route, loaded on first visit.
const FeedView = lazy(() => import("@/views/FeedView").then((m) => ({ default: m.FeedView })));
const TasksView = lazy(() => import("@/views/TasksView").then((m) => ({ default: m.TasksView })));
const TaskDetail = lazy(() => import("@/views/TaskDetail").then((m) => ({ default: m.TaskDetail })));
const AgentsView = lazy(() => import("@/views/AgentsView").then((m) => ({ default: m.AgentsView })));
const AgentDetail = lazy(() => import("@/views/AgentDetail").then((m) => ({ default: m.AgentDetail })));
const CompareView = lazy(() => import("@/views/CompareView").then((m) => ({ default: m.CompareView })));

function ViewFallback() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-11 rounded-card bg-hover" />
      ))}
    </div>
  );
}
import { prob } from "@/lib/format";

function title(route: Route, taskTitle?: string): { title: string; crumb?: string } {
  switch (route.view) {
    case "feed":
      return { title: "Feed" };
    case "tasks":
      return { title: "Tasks" };
    case "task":
      return { title: taskTitle ?? `Task #${route.number}`, crumb: "Tasks" };
    case "agents":
      return { title: "Agents" };
    case "agent":
      return { title: route.id, crumb: "Agents" };
    case "compare":
      return { title: "Compare Captures" };
  }
}

/** Toast when the Relay fires an Interrupt: the moment Persons most want to judge. */
function useInterruptToasts() {
  const store = useStore();
  useEffect(
    () =>
      store.onMessage((m) => {
        if (m.type !== "verdict") return;
        const v = m.verdict;
        if (v.option === "interrupt" && v.probabilities) {
          toast(`Interrupt to ${v.agent}`, {
            description: `Jev ${prob(v.probabilities.interrupt)} interrupt, ${prob(v.probabilities.queue)} queue`,
            action: { label: "View", onClick: () => go({ view: "feed", event: v.event }) },
          });
        } else if (v.downgraded && v.probabilities) {
          toast(`Queued for ${v.agent}, downgraded`, {
            description:
              v.downgraded.reason === "below-threshold"
                ? `Interrupt ${prob(v.probabilities.interrupt)} was below the threshold`
                : "This CLI cannot receive Interrupts",
            action: { label: "View", onClick: () => go({ view: "feed", event: v.event }) },
          });
        }
      }),
    [store],
  );
}

function StaleBanner() {
  const { tasks } = useChannel();
  const stale = tasks.filter((t) => t.claim?.stale);
  if (!stale.length) return null;
  const first = stale[0];
  return (
    <Banner className="gap-3 border-b border-red/20 bg-red-tint px-3 py-1.5 text-red sm:px-4" key={stale.map((t) => t.number).join()}>
      <BannerIcon icon={AlertTriangle} className="border-red/25 bg-transparent p-0.5 text-red shadow-none" />
      <BannerTitle className="min-w-0 truncate text-[12.5px]">
        {stale.length === 1
          ? `#${first.number} has a Stale Claim. Its holder is Gone.`
          : `${stale.length} Stale Claims. Their holders are Gone.`}
      </BannerTitle>
      <BannerAction
        className="h-7 border-red/30 px-2.5 text-[12px] text-red hover:bg-red/10 hover:text-red"
        onClick={() => go(stale.length === 1 ? { view: "task", number: first.number } : { view: "tasks" })}
      >
        Review
      </BannerAction>
      <BannerClose className="size-7 text-red hover:bg-red/10 hover:text-red" />
    </Banner>
  );
}

function Loading() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 p-6">
      <LoadingState label="Joining the Channel" />
      <div className="flex w-full max-w-md flex-col gap-2" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-11 rounded-card bg-hover" />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const state = useChannel();
  const route = useRoute();
  const { taskByNumber } = useIndex();
  const [palette, setPalette] = useState(false);
  useInterruptToasts();

  if (state.status === "loading") return <Loading />;
  if (state.status === "error")
    return (
      <div className="flex h-dvh items-center justify-center p-6 text-center">
        <div className="flex max-w-sm flex-col gap-2">
          <p className="text-[14px] font-semibold text-ink">Could not reach the Channel</p>
          <p className="text-[13px] text-ink-2">{state.error}</p>
        </div>
      </div>
    );

  const t = title(route, route.view === "task" ? taskByNumber.get(route.number)?.title : undefined);

  return (
    <TooltipProvider delayDuration={500}>
      <SidebarProvider className="h-dvh min-h-0">
        <AppSidebar route={route} />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <SidebarTrigger className="-ml-1 size-8" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
              {t.crumb && (
                <>
                  <a
                    href={route.view === "task" ? "#/tasks" : "#/agents"}
                    className="hidden text-[13px] text-ink-3 hover:text-ink sm:inline"
                  >
                    {t.crumb}
                  </a>
                  <span className="hidden text-ink-3 sm:inline" aria-hidden>
                    /
                  </span>
                </>
              )}
              <h1
                className={
                  route.view === "agent"
                    ? "min-w-0 truncate font-mono text-[13px] font-medium text-ink"
                    : "min-w-0 truncate font-display text-[15px] font-semibold text-ink"
                }
              >
                {route.view === "task" && <span className="mr-1.5 font-mono text-[13px] font-normal text-ink-3">#{route.number}</span>}
                {t.title}
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="inline-flex h-8 shrink-0 items-center gap-2 rounded-[6px] border border-line bg-surface px-2 text-[12.5px] text-ink-3 hover:border-line-strong hover:text-ink"
              aria-label="Open command palette"
            >
              <Search className="size-3.5" />
              <span className="hidden md:inline">Jump to</span>
              <kbd className="hidden rounded-[4px] bg-inset px-1 font-mono text-[10.5px] text-ink-3 shadow-hairline md:inline">⌘K</kbd>
            </button>
          </header>
          <StaleBanner />
          <main className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<ViewFallback />}>
              {route.view === "feed" && <FeedView selected={route.event} />}
              {route.view === "tasks" && <TasksView />}
              {route.view === "task" && <TaskDetail number={route.number} />}
              {route.view === "agents" && <AgentsView />}
              {route.view === "agent" && <AgentDetail id={route.id} />}
              {route.view === "compare" && <CompareView turn={route.turn} />}
            </Suspense>
          </main>
        </SidebarInset>
      </SidebarProvider>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <Toaster position="bottom-right" closeButton />
    </TooltipProvider>
  );
}
