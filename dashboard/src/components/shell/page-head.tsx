/*
 * The head of a view (design.md): one line, a 20/600 sentence of state or the view's name,
 * then its facts in ink-3 on the same baseline, separated by middle dots. Never a row of
 * figure tiles. The view's own controls sit at the right.
 */
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHead({
  title,
  facts = [],
  actions,
  className,
}: {
  title: ReactNode;
  /** Short facts, each a phrase; empty ones are left out. */
  facts?: ReactNode[];
  actions?: ReactNode;
  className?: string;
}) {
  const shown = facts.filter((f) => f !== null && f !== undefined && f !== false && f !== "");
  return (
    <header className={cn("flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2", className)}>
      <h1 className="text-head font-semibold text-ink">{title}</h1>
      {shown.length > 0 && (
        <p className="min-w-0 flex-[1_1_20rem] text-small text-ink-3">
          {shown.map((f, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden> · </span>}
              {f}
            </Fragment>
          ))}
        </p>
      )}
      {actions && <div className="ml-auto flex items-center gap-2 self-center">{actions}</div>}
    </header>
  );
}
