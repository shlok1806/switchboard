/*
 * The head of a view (design.md "Page head"): the view's name or a sentence of its state in
 * the display face, its facts under it as one quiet line joined by middle dots, and the view's
 * own controls at the right. Never a row of figure tiles.
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
    <header className={cn("flex min-w-0 flex-wrap items-end gap-x-6 gap-y-3", className)}>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1.5">
        <h1 className="font-display text-head font-medium [overflow-wrap:anywhere] text-ink max-sm:text-head-phone">{title}</h1>
        {shown.length > 0 && (
          <p className="min-w-0 text-small text-ink-3">
            {shown.map((f, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden> · </span>}
                {f}
              </Fragment>
            ))}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
