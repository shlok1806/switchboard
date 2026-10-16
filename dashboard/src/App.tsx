import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { PhoneBar, TabBar, TopBar } from "@/components/shell/nav";
import { ErrorPage, ViewErrorBoundary, ViewSkeleton } from "@/components/shell/states";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { CommandPalette } from "@/components/domain/palette";
import { StartAgentSheet } from "@/components/domain/start-agent";
import { useChannel, useIndex } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { href, useRoute, type Route } from "@/lib/router";
import { channelRepo, signOut } from "@/lib/session";

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

/**
 * Which page the route is: a new one moves focus to the page (see App), a new selection on
 * the same page does not, so a row keeps focus when it selects itself.
 */
function pageOf(route: Route): string {
  switch (route.view) {
    case "agent":
      return `agent:${route.id}`;
    case "task":
      return `task:${route.number}`;
    case "missing":
      return `missing:${route.path}`;
    default:
      return route.view;
  }
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

  // Focus order: a new page puts focus at the start of the page, after the bars, as a page
  // load would; a key's Tab then goes on into the page, not back through the top bar. A view
  // that puts focus somewhere itself (the Directive field) keeps it, and so does a selection
  // on the same page.
  const main = useRef<HTMLElement>(null);
  const page = pageOf(route);
  const shown = useRef(page);
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    const el = main.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [page]);

  const repo = state.snapshot?.channel.repo ?? channelRepo() ?? "";
  const content =
    state.status === "loading" ? (
      <ViewSkeleton view={route.view} />
    ) : state.status === "error" ? (
      <ErrorPage
        title="Could not reach the Channel"
        reason={state.error}
        actions={
          <>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Try again
            </Button>
            <Button onClick={() => void signOut()}>Sign out</Button>
          </>
        }
      >
        The Dashboard could not read this Channel. Your Agents keep working; their Updates wait on the Channel until it answers.
      </ErrorPage>
    ) : (
      <ViewErrorBoundary key={page}>
        <Suspense fallback={<ViewSkeleton view={route.view} />}>
          {route.view === "now" && <NowView />}
          {route.view === "feed" && <ActivityView selected={route.event} byTurn={route.by === "turn"} turn={route.turn} />}
          {route.view === "tasks" && <TasksView />}
          {route.view === "task" && <TaskDetail number={route.number} />}
          {route.view === "agents" && <AgentsView selected={route.selected} />}
          {route.view === "agent" && <AgentDetail id={route.id} focus={route.focus} />}
          {route.view === "canvas" && <CanvasView selected={route.agent} />}
          {route.view === "memory" && <MemoryView selected={route.note} />}
          {route.view === "hosts" && <HostsView selected={route.host} />}
          {route.view === "missing" && (
            <ErrorPage
              title="No such page"
              actions={
                <a href={href({ view: "now" })} className={buttonVariants({ variant: "primary" })}>
                  Go to Now
                </a>
              }
            >
              <code className="[overflow-wrap:anywhere]">#{route.path}</code> is not a page of this Dashboard. The link may be from an older version of it.
            </ErrorPage>
          )}
        </Suspense>
      </ViewErrorBoundary>
    );

  return (
    <TooltipProvider delayDuration={500}>
      <div className="flex h-dvh flex-col bg-page">
        <a
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            main.current?.focus();
          }}
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-[var(--r)] focus:bg-ink focus:px-3 focus:py-1.5 focus:text-small focus:text-paper"
        >
          Skip to the page
        </a>
        {mobile ? (
          <PhoneBar repo={repo} onSearch={() => setPalette(true)} />
        ) : (
          <TopBar route={route} repo={repo} onSearch={() => setPalette(true)} />
        )}
        <Crumb route={route} taskTitle={route.view === "task" ? taskByNumber.get(route.number)?.title : undefined} />
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col pb-[var(--tabbar-h)] outline-none sm:pb-0"
        >
          {content}
        </main>
        {mobile && <TabBar route={route} />}
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} route={route} />
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
