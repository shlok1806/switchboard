import { Suspense, lazy, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, PixelIcon } from "@/components/pixel-icon";
import { Panel } from "@/components/shell/panel";
import { TitleButton, WindowFrame } from "@/components/shell/window";
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
        <Skeleton key={i} className="h-11 bg-hover" />
      ))}
    </div>
  );
}

import { DOWNGRADE_LABEL, prob } from "@/lib/format";
import { leaveChannel } from "@/lib/session";

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
    <Banner
      className="gap-3 border-b border-border bg-red-tint px-3 py-1 text-red sm:px-4"
      key={stale.map((t) => t.number).join()}
    >
      <BannerIcon icon={AlertTriangle} className="border-0 bg-transparent p-0 text-red" />
      <BannerTitle className="min-w-0 truncate text-[12.5px] font-semibold">
        {stale.length === 1
          ? `#${first.number} has a Stale Claim. Its holder is Gone.`
          : `${stale.length} Stale Claims. Their holders are Gone.`}
      </BannerTitle>
      <BannerAction
        className="h-[26px] px-3 text-[12px]"
        onClick={() => go(stale.length === 1 ? { view: "task", number: first.number } : { view: "tasks" })}
      >
        Review
      </BannerAction>
      <BannerClose className="size-[26px]" />
    </Banner>
  );
}

function Loading() {
  return (
    <div className="stipple flex h-dvh items-center justify-center p-4">
      <WindowFrame title="Switchboard" className="w-full max-w-md flex-none">
        <div className="flex flex-col items-center gap-5 p-6">
          <LoadingState label="Joining the Channel" />
          <div className="flex w-full flex-col gap-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 bg-hover" />
            ))}
          </div>
        </div>
      </WindowFrame>
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
      <div className="stipple flex h-dvh items-center justify-center p-4">
        <WindowFrame title="Switchboard: error" className="w-full max-w-sm flex-none">
          <div className="flex gap-3 p-4">
            <AlertTriangle className="mt-0.5 text-red" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-[13px] font-semibold">Could not reach the Channel</p>
              <p className="font-mono text-[12px] break-words text-ink-2">{state.error}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border bg-secondary p-2">
            <button type="button" onClick={leaveChannel} className="btn-motif h-[26px] px-3">
              Join with another name
            </button>
            <button type="button" onClick={() => window.location.reload()} className="btn-motif h-[26px] px-3 font-semibold outline outline-1 outline-[hsl(var(--foreground))]">
              Try again
            </button>
          </div>
        </WindowFrame>
      </div>
    );

  const t = title(route, route.view === "task" ? taskByNumber.get(route.number)?.title : undefined);

  const counts = `${state.tasks.length} ${state.tasks.length === 1 ? "Task" : "Tasks"} · ${state.agents.filter((a) => a.presence === "live").length} Live`;

  return (
    <TooltipProvider delayDuration={500}>
      {/*
        The root window: the preset's stipple, one maximised window on it and
        the panel along the bottom, as on shlokthakkar.com. On a phone the
        window fills the screen the way the site maximises its windows there.
      */}
      <div className="stipple flex h-dvh flex-col p-0 pb-[var(--panel-h)] md:p-2 md:pb-[calc(var(--panel-h)+8px)]">
        <WindowFrame
          title={
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="hidden shrink-0 sm:inline">Switchboard:</span>
              {t.crumb && (
                <a href={route.view === "task" ? "#/tasks" : "#/agents"} className="hidden shrink-0 font-normal hover:underline sm:inline">
                  {t.crumb} /
                </a>
              )}
              {route.view === "task" && <span className="shrink-0 font-mono font-normal">#{route.number}</span>}
              <span className={route.view === "agent" ? "truncate font-mono font-normal" : "truncate"}>{t.title}</span>
            </span>
          }
          left={<PixelIcon name="terminal" className="ml-0.5" />}
          right={
            <TitleButton label="Jump to (Ctrl K)" icon="search" onClick={() => setPalette(true)}>
              <span className="hidden text-[12px] font-normal md:inline">Jump to</span>
            </TitleButton>
          }
          status={
            <>
              <span className="truncate font-mono text-[11.5px]">{state.snapshot?.channel.repo ?? "Channel"}</span>
              <span className="truncate">{counts}</span>
              <span className="ml-auto hidden font-mono text-[11px] md:inline">⌘K jump to</span>
            </>
          }
          className="md:max-h-full"
        >
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
        </WindowFrame>
        <Panel route={route} />
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <Toaster position="bottom-right" offset={{ bottom: "calc(var(--panel-h) + 40px)", right: "20px" }} mobileOffset={{ bottom: "calc(var(--panel-h) + 28px)" }} closeButton />
    </TooltipProvider>
  );
}
