/* A titled group on a detail page: one tone step from the page, no outline. */
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
    <section className={cn("rounded-md", tone === "alert" ? "bg-red-tint" : "bg-inset", className)}>
      <header className="flex min-h-10 items-center gap-2 px-4 pt-3">
        <h2 className={cn("text-body font-medium", tone === "alert" ? "text-red" : "text-ink")}>{title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </header>
      <div className={cn("px-4 pt-1 pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}
