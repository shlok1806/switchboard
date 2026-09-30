/* A titled group on a detail page: a soft card with a small heading row. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({
  title,
  action,
  tone,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  action?: ReactNode;
  tone?: "alert";
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-surface", tone === "alert" ? "border-red/30" : "border-line", className)}>
      <header className="flex min-h-10 items-center gap-2 px-4 pt-3">
        <h2 className={cn("text-[13px] font-medium", tone === "alert" ? "text-red" : "text-ink")}>{title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </header>
      <div className={cn("px-4 pt-1 pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}
