/*
 * A titled group (design.md's section head): a 15/600 title, a meta run in ink-3, an
 * optional link or control at the right, and a 1px rule under the whole row. The title
 * takes the free width and wraps, so the meta and the link stay on the first line.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHead({ title, meta, action, as: H = "h2" }: { title: ReactNode; meta?: ReactNode; action?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule-2 pb-2">
      <H className="min-w-0 flex-[1_1_160px] text-title font-semibold text-ink [overflow-wrap:anywhere]">
        {title}
        {meta && <span className="ml-3 text-small font-normal text-ink-3">{meta}</span>}
      </H>
      {action && <span className="shrink-0 text-small">{action}</span>}
    </header>
  );
}

export function Section({
  title,
  meta,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col", className)}>
      <SectionHead title={title} meta={meta} action={action} />
      <div className={cn("pt-3", bodyClassName)}>{children}</div>
    </section>
  );
}
