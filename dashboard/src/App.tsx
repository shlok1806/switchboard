import { Suspense, lazy, useEffect, useState } from "react";
import { toast } from "sonner";
import { PhoneBar, TabBar, TopBar } from "@/components/shell/nav";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
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
const CanvasView = lazy(() => import("@/views/CanvasView").then((m) => ({ default: m.CanvasView })));
const CompareView = lazy(() => import("@/views/CompareView").then((m) => ({ default: m.CompareView })));

function ViewFallback() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-11 bg-panel" />
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

/** Where you are, inside a Task or an Agent: the way back, as a quiet trail over the page head. */
function Crumb({ route, taskTitle }: { route: Route; taskTitle?: string }) {
  if (route.view !== "task" && route.view !== "agent") return null;
  const parent = route.view === "task" ? { label: "Tasks", to: href({ view: "tasks" }) } : { label: "Agents", to: href({ view: "agents" }) };
  return (
    <nav aria-label="Breadcrumb" className="flex min-h-10 w-full shrink-0 items-end gap-1.5 px-[var(--gutter)] text-small text-ink-3">
      <a href={parent.to} className="hover:text-ink">
        {parent.label}
      </a>
      <span aria-hidden>/</span>
      {route.view === "task" ? (
        <span className="min-w-0 [overflow-wrap:anywhere] text-ink-2">
          #{route.number} {taskTitle}
        </span>
      ) : (
        <>
          <span>{route.id.split("/")[0]}</span>
          <span aria-hidden>/</span>
          <code className="min-w-0 [overflow-wrap:anywhere] text-ink-2">{route.id}</code>
        </>
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
        <div className="flex w-full max-w-sm flex-col gap-5 border-t border-rule-2 pt-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title font-semibold">Could not reach the Channel</h1>
            <p className="text-small break-words text-ink-3">{state.error}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
            <Button size="sm" variant="action" onClick={() => window.location.reload()}>
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
        {mobile ? (
          <PhoneBar repo={repo} onSearch={() => setPalette(true)} />
        ) : (
          <TopBar route={route} repo={repo} onSearch={() => setPalette(true)} />
        )}
        <Crumb route={route} taskTitle={route.view === "task" ? taskByNumber.get(route.number)?.title : undefined} />
        <main className="flex min-h-0 flex-1 flex-col pb-[var(--tabbar-h)] sm:pb-0">
          <Suspense fallback={<ViewFallback />}>
            {route.view === "feed" && <FeedView selected={route.event} />}
            {route.view === "tasks" && <TasksView />}
            {route.view === "task" && <TaskDetail number={route.number} />}
            {route.view === "agents" && <AgentsView />}
            {route.view === "agent" && <AgentDetail id={route.id} />}
            {route.view === "canvas" && <CanvasView selected={route.agent} />}
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
        mobileOffset={{ top: "calc(var(--topbar-h) + 8px)" }}
        closeButton
      />
    </TooltipProvider>
  );
}
