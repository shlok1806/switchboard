import { Suspense, lazy, useState } from "react";
import { PhoneBar, TabBar, TopBar } from "@/components/shell/nav";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import LoadingState from "@/components/primitives/LoadingState";
import { Button } from "@/components/atoms/Button";
import { CommandPalette } from "@/components/domain/palette";
import { StartAgentSheet } from "@/components/domain/start-agent";
import { useChannel, useIndex } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { href, useRoute, type Route } from "@/lib/router";
import { signOut } from "@/lib/session";

// One chunk per route, loaded on first visit.
const NowView = lazy(() => import("@/views/NowView").then((m) => ({ default: m.NowView })));
const ActivityView = lazy(() => import("@/views/ActivityView").then((m) => ({ default: m.ActivityView })));
const TasksView = lazy(() => import("@/views/TasksView").then((m) => ({ default: m.TasksView })));
const TaskDetail = lazy(() => import("@/views/TaskDetail").then((m) => ({ default: m.TaskDetail })));
const AgentsView = lazy(() => import("@/views/AgentsView").then((m) => ({ default: m.AgentsView })));
const AgentDetail = lazy(() => import("@/views/AgentDetail").then((m) => ({ default: m.AgentDetail })));
const CanvasView = lazy(() => import("@/views/CanvasView").then((m) => ({ default: m.CanvasView })));
const MemoryView = lazy(() => import("@/views/MemoryView").then((m) => ({ default: m.MemoryView })));
const HostsView = lazy(() => import("@/views/HostsView").then((m) => ({ default: m.HostsView })));

function ViewFallback() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-11 bg-panel" />
      ))}
    </div>
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
            {route.view === "now" && <NowView />}
            {route.view === "feed" && <ActivityView selected={route.event} byTurn={route.by === "turn"} turn={route.turn} />}
            {route.view === "tasks" && <TasksView />}
            {route.view === "task" && <TaskDetail number={route.number} />}
            {route.view === "agents" && <AgentsView selected={route.selected} />}
            {route.view === "agent" && <AgentDetail id={route.id} focus={route.focus} />}
            {route.view === "canvas" && <CanvasView selected={route.agent} />}
            {route.view === "memory" && <MemoryView selected={route.note} />}
            {route.view === "hosts" && <HostsView selected={route.host} />}
          </Suspense>
        </main>
        {mobile && <TabBar route={route} />}
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <StartAgentSheet />
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
