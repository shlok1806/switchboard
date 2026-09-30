/*
 * A Motif XmFrame: an etched line around a group of controls, its title set
 * into the top edge. This is what groups things on a Motif form instead of a
 * floating card with a drop shadow.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function GroupBox({
  title,
  action,
  tone,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  action?: ReactNode;
  tone?: "alert" | "warn";
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "relative mt-2 border border-[hsl(var(--bevel-dark))] shadow-[inset_1px_1px_0_hsl(var(--bevel-light)),1px_1px_0_hsl(var(--bevel-light))]",
        className,
      )}
    >
      <header className="absolute -top-2 right-2 left-2 flex items-center gap-2 leading-none">
        <h2
          className={cn(
            "bg-card px-1 text-[12px] font-bold",
            tone === "alert" && "text-red",
            tone === "warn" && "text-orange",
          )}
        >
          {title}
        </h2>
        {action && <span className="ml-auto bg-card px-1">{action}</span>}
      </header>
      <div className={cn("px-3 pt-3.5 pb-3", bodyClassName)}>{children}</div>
    </section>
  );
}
