/*
 * The inspector's frame (design.md): beside the list at 352px, or below 640px a bottom sheet
 * its row opens, as the Canvas's is. The sheet is a dialog over a veil and the tab bar: it holds
 * focus while it is open, Escape, the veil or Close shuts it, and focus goes back to the row.
 */
import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { cn } from "@/lib/utils";

export function InspectorFrame({ label, onClose, children }: { label: string; /** Set on a phone, where the frame is a sheet. */ onClose?: () => void; children: ReactNode }) {
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  if (onClose === undefined) {
    return (
      <aside aria-label={label} className="flex w-[var(--inspector-w)] shrink-0 flex-col gap-6 overflow-y-auto border-l border-rule px-5 pt-5 pb-12">
        {children}
      </aside>
    );
  }
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/25 dark:bg-black/55" />
        <DialogPrimitive.Content
          ref={content}
          aria-label={label}
          aria-describedby={undefined}
          // Focus lands on the sheet itself, not its first button, so the reader starts at the top.
          onOpenAutoFocus={(e) => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            e.preventDefault();
            content.current?.focus();
          }}
          // There is no Trigger to go back to: focus goes back to the row that opened the sheet.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
            opener.current = null;
          }}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col gap-6 overflow-y-auto border-t border-rule-2 bg-paper px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-ink outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
        <p className="text-row text-ink-2">{children}</p>
        <div className="pt-3">
          <Button onClick={onClose}>Close</Button>
        </div>
      </section>
    </InspectorFrame>
  );
}
