/*
 * The states a view is in before and instead of its data (design.md, States): loading,
 * empty and error. Each is drawn inside the shell, under the view's own page head, so the
 * page keeps its place while it waits or fails.
 *
 * - Loading is a skeleton shaped like the view's own rows: the reader sees where the table,
 *   the board or the log will be, not five grey bars. It pulses unless motion is reduced.
 * - Empty is a title, one sentence and one action, under a rule, set left like the rows it
 *   stands in for.
 * - Error is the page head saying what failed, the reason as the Channel gave it, and what to
 *   do: one primary, and at most one secondary.
 *
 * The root of each carries `data-view-state`, which the screenshot tests read.
 */
import { Component, useEffect, useId, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/atoms/Button";
import { PageHead } from "@/components/shell/page-head";
import type { Route } from "@/lib/router";
import { cn } from "@/lib/utils";

/** One line of placeholder, the width of the text it stands for. */
function Bar({ w, h = "h-2.5", className }: { w: string; h?: string; className?: string }) {
  return <span aria-hidden className={cn("block shrink-0 rounded-[2px] bg-rule", h, className)} style={{ width: w }} />;
}

/** The page head: the view's name and its facts. */
function HeadBars({ title }: { title: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
      <h1 className="text-head font-semibold text-ink">{title}</h1>
      <Bar w="14rem" />
    </div>
  );
}

function ChipBars({ n = 5 }: { n?: number }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} aria-hidden className="h-[26px] w-16 rounded-[var(--r)] border border-rule max-sm:h-11" />
      ))}
    </div>
  );
}

// Widths that vary row to row, as names and Task titles do.
const NAMES = ["5.5rem", "7rem", "4.5rem", "6.5rem", "5rem", "7.5rem", "6rem", "4rem"];
const TASKS = ["16rem", "11rem", "14rem", "9rem", "18rem", "12rem", "15rem", "10rem"];

/** A table row: state, name over its second line, the Task, the context meter, since. */
function TableRow({ i, wide = true }: { i: number; wide?: boolean }) {
  return (
    <div className="flex h-14 items-start gap-6 border-b border-rule py-2.5 pl-3 max-sm:h-auto max-sm:flex-col max-sm:gap-2 max-sm:py-3">
      <span className="flex w-[7.5rem] shrink-0 items-center gap-2 max-sm:w-auto">
        <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] border border-rule-2" />
        <Bar w="3.5rem" />
      </span>
      <span className="flex w-36 shrink-0 flex-col gap-2 max-sm:w-auto">
        <Bar w={NAMES[i % NAMES.length]!} />
        <Bar w="6rem" h="h-2" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <Bar w={TASKS[i % TASKS.length]!} className="max-w-full" />
      </span>
      {wide && (
        <span className="flex w-24 shrink-0 items-center gap-2 max-lg:hidden">
          <Bar w="1.75rem" />
          <span aria-hidden className="h-1 w-14 bg-rule" />
        </span>
      )}
      <span className="w-12 shrink-0 pr-3 max-sm:hidden">
        <Bar w="2.5rem" className="ml-auto" />
      </span>
    </div>
  );
}

function GroupBar({ w = "9rem" }: { w?: string }) {
  return (
    <div className="flex h-11 items-center border-b border-rule-2 pl-3" /* taste-skill-ignore: the rule of the row it stands in for */>
      <Bar w={w} />
    </div>
  );
}

function Table({ rows = 6, wide = true }: { rows?: number; wide?: boolean }) {
  return (
    <div className="flex flex-col">
      <div className="h-9 border-b border-rule" />
      <GroupBar />
      {Array.from({ length: Math.min(3, rows) }, (_, i) => (
        <TableRow key={i} i={i} wide={wide} />
      ))}
      <GroupBar w="7rem" />
      {Array.from({ length: Math.max(0, rows - 3) }, (_, i) => (
        <TableRow key={i} i={i + 3} wide={wide} />
      ))}
    </div>
  );
}

/** A log row: the time, who, the kind, what happened. */
function LogRow({ i }: { i: number }) {
  return (
    <div className="flex h-9 items-center gap-6 border-b border-rule px-1 max-sm:h-auto max-sm:flex-col max-sm:items-start max-sm:gap-2 max-sm:py-3" /* taste-skill-ignore: the rule of the row it stands in for */>
      <Bar w="3.5rem" />
      <span className="flex w-36 shrink-0 items-center gap-2">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-rule-2" />
        <Bar w={NAMES[i % NAMES.length]!} />
      </span>
      <Bar w="4rem" className="max-sm:hidden" />
      <Bar w={TASKS[(i + 3) % TASKS.length]!} className="max-w-full" />
    </div>
  );
}

/** A board card: title over two lines, its labels, a meter. */
function Card({ i }: { i: number }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--r)] border border-rule p-3">
      <Bar w={TASKS[i % TASKS.length]!} className="max-w-full" />
      <Bar w="6rem" />
      <Bar w="4rem" h="h-2" />
      <span aria-hidden className="mt-1 ml-auto h-1 w-14 bg-rule" />
    </div>
  );
}

/** A paragraph of a note: two lines, then its files and author. */
function NoteBlock({ i }: { i: number }) {
  return (
    <div className="flex flex-col gap-2.5 border-b border-rule py-4" /* taste-skill-ignore: the rule of the row it stands in for */>
      <Bar w="100%" className="max-w-[38rem]" />
      <Bar w={TASKS[i % TASKS.length]!} className="max-w-full" />
      <Bar w="13rem" h="h-2" />
    </div>
  );
}

/** A narrow column at the right: sections of label and value lines. */
function SideColumn() {
  return (
    <aside className="flex w-[var(--inspector-w)] shrink-0 flex-col gap-5 border-l border-rule px-5 pt-5 max-lg:hidden" /* taste-skill-ignore: the rule of the row it stands in for */>
      {[0, 1, 2].map((s) => (
        <div key={s} className="flex flex-col gap-3">
          <Bar w="6rem" h="h-3" />
          <div className="h-px bg-rule-2" /* taste-skill-ignore: the rule of the row it stands in for */ />
          {[0, 1, 2].map((i) => (
            <Bar key={i} w={TASKS[(s + i) % TASKS.length]!} className="max-w-full" />
          ))}
        </div>
      ))}
    </aside>
  );
}

const VIEW_NAME: Record<Route["view"], string> = {
  now: "Now",
  feed: "Activity",
  tasks: "Tasks",
  task: "Task",
  agents: "Agents",
  agent: "Agent",
  canvas: "Canvas",
  memory: "Memory",
  hosts: "Hosts",
  missing: "Page",
};

function Body({ view }: { view: Route["view"] }) {
  switch (view) {
    case "now":
      return (
        <div className="grid gap-8 lg:grid-cols-[5fr_7fr]">
          <div className="flex flex-col gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2.5">
                <Bar w={TASKS[i]!} />
                <span aria-hidden className="h-8 rounded-[var(--r)] bg-paper-2" />
                <Bar w="70%" />
                <span className="flex gap-2">
                  <span aria-hidden className="h-[30px] w-16 rounded-[var(--r)] border border-rule-2" />
                  <span aria-hidden className="h-[30px] w-28" />
                </span>
              </div>
            ))}
          </div>
          <Table rows={5} wide={false} />
        </div>
      );
    case "agents":
    case "hosts":
      return (
        <>
          <ChipBars n={view === "agents" ? 6 : 4} />
          <Table rows={view === "agents" ? 7 : 4} wide={view === "agents"} />
        </>
      );
    case "tasks":
      return (
        <>
          <ChipBars n={6} />
          {/* A phone's board: the column tabs over one column. */}
          <div className="grid h-11 grid-cols-4 items-center justify-items-center border-b border-rule-2 sm:hidden" /* taste-skill-ignore: the rule of the tabs it stands in for */>
            {[0, 1, 2, 3].map((i) => (
              <Bar key={i} w="3.5rem" />
            ))}
          </div>
          <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
            {[3, 2, 1, 2].map((n, c) => (
              <div key={c} className={cn("flex flex-col gap-3", c > 0 && "max-sm:hidden")}>
                <Bar w="5rem" h="h-3" className="max-sm:hidden" />
                {Array.from({ length: n }, (_, i) => (
                  <Card key={i} i={c + i} />
                ))}
              </div>
            ))}
          </div>
        </>
      );
    case "feed":
      return (
        <>
          <ChipBars n={7} />
          <div className="flex flex-col">
            <div className="h-8 border-b border-rule" /* taste-skill-ignore: the rule of the row it stands in for */ />
            {Array.from({ length: 12 }, (_, i) => (
              <LogRow key={i} i={i} />
            ))}
          </div>
        </>
      );
    case "memory":
      return (
        <>
          <ChipBars n={6} />
          <div className="flex max-w-[60rem] flex-col">
            {[0, 1, 2, 3].map((i) => (
              <NoteBlock key={i} i={i} />
            ))}
          </div>
        </>
      );
    case "canvas":
      return (
        <div className="grid flex-1 grid-cols-3 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {[2, 1, 1, 2].map((n, f) => (
            <div key={f} className="flex flex-col gap-3 rounded-[var(--r)] border border-rule p-3">
              <Bar w="7rem" h="h-3" />
              <div className="flex flex-wrap gap-3">
                {Array.from({ length: n }, (_, i) => (
                  <div key={i} className="flex w-52 flex-col gap-2 rounded-[var(--r)] border border-rule-2 p-3">
                    <Bar w={NAMES[f + i]!} />
                    <Bar w="9rem" />
                    <Bar w="5rem" h="h-2" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case "agent":
      return (
        <>
          <ChipBars n={2} />
          <div aria-hidden className="h-[26rem] rounded-[var(--r-2)] bg-term-bg max-sm:h-64" />
        </>
      );
    case "task":
      return (
        <>
          <Bar w="70%" />
          <Bar w="45%" />
          <div className="flex flex-col">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex h-10 items-center gap-3 border-b border-rule" /* taste-skill-ignore: the rule of the row it stands in for */>
                <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-rule-2" />
                <Bar w={TASKS[i]!} className="max-w-full" />
              </div>
            ))}
          </div>
        </>
      );
    case "missing":
      return null;
  }
}

// What is loading, for the one status region the app keeps on the page (LoadingStatus). A
// region that mounts with its words already in it is often not read; one that stays and
// changes its words is.
let loading: string[] = [];
const loadingListeners = new Set<() => void>();
const changed = () => {
  for (const l of loadingListeners) l();
};

/** While mounted, the status region says this is loading. */
function useAnnounceLoading(what: string) {
  useEffect(() => {
    loading = [...loading, what];
    changed();
    return () => {
      const at = loading.indexOf(what);
      loading = loading.filter((_, i) => i !== at);
      changed();
    };
  }, [what]);
}

/** The status region screen readers hear "Loading Agents" from. Mounted once, by the app. */
export function LoadingStatus() {
  const now = useSyncExternalStore(
    (l) => {
      loadingListeners.add(l);
      return () => loadingListeners.delete(l);
    },
    () => loading.at(-1),
  );
  return (
    <p role="status" className="sr-only">
      {now ? `Loading ${now}` : ""}
    </p>
  );
}

/**
 * The skeleton for a view whose code is still on its way: drawn only if the wait passes 150ms,
 * so a chunk that arrives at once never flashes a whole skeleton page.
 */
export function LateSkeleton({ view, after = 150 }: { view: Route["view"]; after?: number }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), after);
    return () => clearTimeout(timer);
  }, [after]);
  return late ? <ViewSkeleton view={view} /> : null;
}

/** The view's loading state: its page head, then placeholders shaped like its rows. */
export function ViewSkeleton({ view }: { view: Route["view"] }) {
  const side = view === "agent" || view === "task";
  useAnnounceLoading(VIEW_NAME[view]);
  return (
    <div data-view-state="loading" aria-busy="true" className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-hidden px-[var(--gutter)] pt-5 pb-12">
        <HeadBars title={VIEW_NAME[view]} />
        <div className="loading-pulse flex flex-col gap-5">
          <Body view={view} />
        </div>
      </div>
      {side && <SideColumn />}
    </div>
  );
}

/** A view with nothing to show yet: what is missing, how it comes, and the one thing to do. */
export function EmptyState({ title, children, action, className }: { title: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section data-view-state="empty" aria-label={title} className={cn("flex max-w-[34rem] flex-col items-start gap-1.5 border-t border-rule pt-5", className)} /* taste-skill-ignore: the top rule of the list it stands in for */>
      <h2 className="text-title font-semibold text-ink">{title}</h2>
      <p className="text-row text-ink-2">{children}</p>
      {action && <div className="pt-3">{action}</div>}
    </section>
  );
}

/** A whole view with nothing to show: its page head, then the empty state. */
export function EmptyView({ view, title, children, action }: { view: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[var(--gutter)] pt-5 pb-12">
      <PageHead title={view} />
      <EmptyState title={title} action={action}>
        {children}
      </EmptyState>
    </div>
  );
}

/**
 * A command to paste in a terminal, shown whole with Copy beside it: an empty state's action
 * when the fix is a command. It wraps rather than scrolls on a phone.
 */
export function CopyCommand({ command }: { command: string }) {
  return (
    <div className="flex max-w-full items-stretch rounded-[var(--r)] border border-rule-2 bg-paper-2">
      <code className="min-w-0 px-2.5 py-1.5 font-mono text-small [overflow-wrap:anywhere] text-ink">
        <span className="text-ink-3 select-none" aria-hidden>
          ${" "}
        </span>
        {command}
      </code>
      <button
        type="button"
        aria-label={`Copy ${command}`}
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => toast.success("Copied", { description: command }),
            () => toast.error("Could not copy", { description: command }),
          );
        }}
        className="flex shrink-0 items-center gap-1.5 border-l border-rule-2 px-2.5 text-label font-medium text-ink hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
      >
        <Copy className="size-3.5" aria-hidden />
        Copy
      </button>
    </div>
  );
}

/** A page that could not be drawn: what failed, why, and what to do about it. */
export function ErrorPage({
  title,
  reason,
  children,
  actions,
  missing = false,
}: {
  title: string;
  reason?: string;
  children?: ReactNode;
  actions: ReactNode;
  /** Nothing failed: the address names nothing. Said plainly, with focus on the title, not as an alert. */
  missing?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (missing) heading.current?.focus({ preventScroll: true });
  }, [missing]);
  return (
    <div data-view-state="error" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[var(--gutter)] pt-5 pb-12">
      <section role={missing ? undefined : "alert"} aria-labelledby={id} className="flex max-w-[34rem] flex-col items-start gap-2">
        <h1 ref={heading} id={id} tabIndex={missing ? -1 : undefined} className="text-head font-semibold text-ink outline-none">
          {title}
        </h1>
        {children && <p className="text-row text-ink-2">{children}</p>}
        {reason && <p className="w-full rounded-[var(--r)] bg-paper-2 px-2.5 py-1.5 text-small [overflow-wrap:anywhere] text-ink-2">{reason}</p>}
        <div className="flex flex-wrap items-center gap-2 pt-3">{actions}</div>
      </section>
    </div>
  );
}

/**
 * A view that throws while rendering shows an error page in its place instead of a blank
 * screen; the rest of the Dashboard keeps working. Try again draws the view afresh.
 */
export class ViewErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A view failed to render", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorPage
        title="This page stopped working"
        reason={error.message}
        actions={
          <Button variant="primary" onClick={() => this.setState({ error: undefined })}>
            Try again
          </Button>
        }
      >
        Something in it failed while it was drawn. The rest of the Dashboard still works.
      </ErrorPage>
    );
  }
}
