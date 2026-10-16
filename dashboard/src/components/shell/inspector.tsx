/*
 * The inspector's frame (design.md): beside the list at 352px, or below 640px a bottom sheet
 * its row opens, as the Canvas's is. The sheet is a dialog over the page, above the tab bar:
 * it takes focus when it opens, Escape or Close shuts it, and focus goes back to the row.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { cn } from "@/lib/utils";

export function InspectorFrame({ label, onClose, children }: { label: string; /** Set on a phone, where the frame is a sheet. */ onClose?: () => void; children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const sheet = onClose !== undefined;
  useEffect(() => {
    if (!sheet) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    return () => opener?.focus();
  }, [sheet]);
  return (
    <aside
      ref={root}
      role={sheet ? "dialog" : undefined}
      tabIndex={sheet ? -1 : undefined}
      aria-label={label}
      onKeyDown={(e) => {
        if (sheet && e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "flex shrink-0 flex-col gap-6 overflow-y-auto",
        sheet
          ? "fixed inset-x-0 bottom-[var(--tabbar-h)] z-30 max-h-[70dvh] border-t border-rule-2 bg-paper px-4 pt-4 pb-6"
          : "w-[var(--inspector-w)] border-l border-rule px-5 pt-5 pb-12",
      )}
    >
      {children}
    </aside>
  );
}

/** The sheet's Close, set beside the inspector's name. */
export function SheetClose({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <button type="button" onClick={onClose} aria-label="Close" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "size-7 shrink-0 px-0")}>
      <X className="size-4" aria-hidden />
    </button>
  );
}

/**
 * The inspector for an address naming something it cannot show: not on the Channel, or the
 * Channel did not answer. One line on why, and Close, which goes back to the plain list.
 */
export function InspectorMissing({ title, children, onClose, sheet }: { title: string; children: ReactNode; onClose: () => void; sheet: boolean }) {
  return (
    <InspectorFrame label={`${title}, in the inspector`} onClose={sheet ? onClose : undefined}>
      <section data-view-state="missing" className="flex flex-col items-start gap-1.5">
        <h2 className="text-title font-semibold text-ink">{title}</h2>
        <p className="text-row text-ink-3">{children}</p>
        <div className="pt-3">
          <Button onClick={onClose}>Close</Button>
        </div>
      </section>
    </InspectorFrame>
  );
}
