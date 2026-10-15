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
  return (
    <header className={cn("rise flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {summary && <p className="text-body text-ink-3">{summary}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
