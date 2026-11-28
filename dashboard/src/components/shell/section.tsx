/*
 * A titled group (design.md "Section head"). A section of a page (h2) is titled in the
 * display face at 20px; a section inside an inspector, or one level down (h3), in the body
 * face at 15/600. A meta run in ink-3 follows the title, an optional link or control sits at the
 * right, and a 1px rule runs under the whole row. The title takes the free width and wraps,
 * so the meta and the link stay on the first line.
 */
import { type ReactNode, useId } from "react";
import { useInInspector } from "@/components/shell/inspector";
import { cn } from "@/lib/utils";

export function SectionHead({
  title,
  meta,
  action,
  as: H = "h2",
  id,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  as?: "h2" | "h3";
  id?: string;
}) {
  // A page's sections are set in the display face; an inspector's, dense, in the body face.
  const inInspector = useInInspector();
  const display = H === "h2" && !inInspector;
  return (
    <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule-2 pb-2">
      <H
        className={cn(
          "min-w-0 flex-[1_1_160px] text-ink [overflow-wrap:anywhere]",
          display ? "font-display text-section font-medium" : "text-title font-semibold",
        )}
      >
        {/* The id names the section by its title alone, not the meta after it. */}
        <span id={id}>{title}</span>
        {meta && <span className="ml-3 inline-block font-sans text-small font-normal text-ink-3">{meta}</span>}
      </H>
      {/* On a phone the link is a 44px target; its margins keep the head's height. */}
      {action && (
        <span className="shrink-0 text-small max-sm:[&>a,&>button]:-my-3.5 max-sm:[&>a,&>button]:inline-flex max-sm:[&>a,&>button]:min-h-11 max-sm:[&>a,&>button]:items-center">
          {action}
        </span>
      )}
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
  as,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** The heading level, so a section inside another titled region never skips one. */
  as?: "h2" | "h3";
}) {
  // Named by its title, so assistive tech lists it as a region by that name.
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn("flex min-w-0 flex-col", className)}>
      <SectionHead id={titleId} title={title} meta={meta} action={action} as={as} />
      <div className={cn("pt-3", bodyClassName)}>{children}</div>
    </section>
  );
}
