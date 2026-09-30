import { Suspense, lazy, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronRight, Radio } from "lucide-react";
import { AccountMenu, ConnectionDot, SearchButton, TabBar, ViewTabs } from "@/components/shell/nav";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Banner, BannerAction, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import LoadingState from "@/components/primitives/LoadingState";
import { Button } from "@/components/atoms/Button";
import { CommandPalette } from "@/components/domain/palette";
import { useChannel, useIndex, useStore } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { DOWNGRADE_LABEL, prob } from "@/lib/format";
import { go, href, useRoute, type Route } from "@/lib/router";
import { signOut } from "@/lib/session";

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
        <Skeleton key={i} className="h-11 rounded-lg bg-hover" />
      ))}
    </div>
  );
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
                : DOWNGRADE_LABEL[v.downgraded.reason].replace(/^./, (c) => c.toUpperCase()),
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
    <Banner className="gap-3 border-b border-line bg-red-tint px-4 py-1.5 text-red" key={stale.map((t) => t.number).join()}>
      <BannerIcon icon={AlertTriangle} className="border-0 bg-transparent p-0 text-red" />
      <BannerTitle className="min-w-0 truncate text-[13px] font-medium">
        {stale.length === 1 ? `#${first.number} has a Stale Claim` : `${stale.length} Stale Claims`}
      </BannerTitle>
      <BannerAction
        variant="ghost"
        className="h-7 px-2.5 text-[13px] text-red hover:bg-red/10 hover:text-red"
        onClick={() => go(stale.length === 1 ? { view: "task", number: first.number } : { view: "tasks" })}
      >
        Review
      </BannerAction>
      <BannerClose variant="ghost" className="size-7 text-red hover:bg-red/10 hover:text-red" />
    </Banner>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-page p-4">{children}</div>;
}

function Loading() {
  return (
    <Center>
      <LoadingState label="Joining the Channel" />
    </Center>
  );
}

/** Where you are, when you are inside a Task or an Agent. */
function Crumb({ route, taskTitle }: { route: Route; taskTitle?: string }) {
  if (route.view !== "task" && route.view !== "agent") return null;
  const parent = route.view === "task" ? { label: "Board", to: href({ view: "tasks" }) } : { label: "Agents", to: href({ view: "agents" }) };
  return (
    <nav aria-label="Breadcrumb" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-4 text-[13px] sm:px-6">
      <a href={parent.to} className="text-ink-3 hover:text-ink">
        {parent.label}
      </a>
      <ChevronRight className="size-3.5 text-ink-4" aria-hidden />
      {route.view === "task" ? (
        <span className="min-w-0 truncate text-ink">
          <span className="font-mono text-ink-3">#{route.number}</span> {taskTitle}
        </span>
      ) : (
        <span className="min-w-0 truncate font-mono text-ink">{route.id}</span>
      )}
    </nav>
  );
}

export default function App() {
  const state = useChannel();
  const route = useRoute();
  const mobile = useIsMobile();
  const { taskByNumber } = useIndex();
  const [palette, setPalette] = useState(false);
  useInterruptToasts();

  if (state.status === "loading") return <Loading />;
  if (state.status === "error")
    return (
      <Center>
        <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-surface p-6 shadow-raised">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-[15px] font-medium">Could not reach the Channel</p>
              <p className="font-mono text-[12px] break-words text-ink-3">{state.error}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
            <Button size="sm" variant="accent" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </div>
        </div>
      </Center>
    );

  const repo = state.snapshot?.channel.repo ?? "Channel";

  return (
    <TooltipProvider delayDuration={500}>
      <div className="flex h-dvh flex-col bg-page">
        <header className="flex h-[var(--header-h)] shrink-0 items-stretch gap-4 border-b border-line bg-surface px-4 sm:px-6">
          <a href={href({ view: "feed" })} className="flex min-w-0 items-center gap-2.5" title={repo}>
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-on-accent">
              <Radio className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-[14px] font-semibold tracking-tight">Switchboard</span>
              <span className="truncate font-mono text-[11px] text-ink-3">{repo}</span>
            </span>
          </a>
          {!mobile && (
            <div className="ml-4">
              <ViewTabs route={route} />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <SearchButton onClick={() => setPalette(true)} compact={mobile} />
            <ConnectionDot />
            <AccountMenu />
          </div>
        </header>
        {route.view !== "tasks" && <StaleBanner />}
        <Crumb route={route} taskTitle={route.view === "task" ? taskByNumber.get(route.number)?.title : undefined} />
        <main className="flex min-h-0 flex-1 flex-col pb-[var(--tabbar-h)] md:pb-0">
          <Suspense fallback={<ViewFallback />}>
            {route.view === "feed" && <FeedView selected={route.event} />}
            {route.view === "tasks" && <TasksView />}
            {route.view === "task" && <TaskDetail number={route.number} />}
            {route.view === "agents" && <AgentsView />}
            {route.view === "agent" && <AgentDetail id={route.id} />}
            {route.view === "compare" && <CompareView turn={route.turn} />}
          </Suspense>
        </main>
        {mobile && <TabBar route={route} />}
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      {/* On a phone toasts come in from the top, so they never cover the composer or the tab bar. */}
      <Toaster
        position={mobile ? "top-center" : "bottom-right"}
        offset={{ bottom: "24px", right: "24px" }}
        mobileOffset={{ top: "calc(var(--header-h) + 8px)" }}
        closeButton
      />
    </TooltipProvider>
  );
}
