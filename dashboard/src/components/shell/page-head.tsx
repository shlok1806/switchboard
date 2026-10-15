/*
 * The head of a view: its name at the title step, one quiet line about the Channel's
 * state, and the view's own controls at the right. Every view opens with one, on the
 * same left edge as its content, so a Person always reads where they are first.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHead({
  title,
  summary,
  actions,
  className,
}: {
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  // Title and actions share the first row at every width, so a phone never strands the action
  // on a line of its own; the summary runs under both.
  return (
    <header className={cn("rise grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1", className)}>
      <h1 className="min-w-0 text-title font-semibold text-ink">{title}</h1>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : <span />}
      {summary && <p className="col-span-2 text-body text-ink-3">{summary}</p>}
    </header>
  );
}
