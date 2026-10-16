/*
 * A side sheet (design.md, Side sheet): a form that needs the page beside it, such as Start an Agent. It
 * comes in from the right at 400px over a light veil, and below 640px from the bottom as a
 * bottom sheet over the tab bar. It is a dialog: it holds focus, Escape or Close shuts it
 * (unless `locked`, while an answer is awaited), and focus goes back to what opened it. The
 * head and the actions stay put while the body scrolls between them.
 */
import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { buttonVariants } from "@/components/atoms/Button";
import { cn } from "@/lib/utils";

export function Sheet({
  open,
  onClose,
  locked = false,
  title,
  description,
  actions,
  onOpenAutoFocus,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** While set, Escape, the veil and Close do nothing. */
  locked?: boolean;
  title: string;
  description?: ReactNode;
  /** The row of buttons under the body. */
  actions?: ReactNode;
  /** Where focus goes on opening: call `preventDefault` and focus a field. Focus still returns to the opener on closing. */
  onOpenAutoFocus?: (e: Event) => void;
  children: ReactNode;
}) {
  // A Radix dialog gives focus back to its Trigger, and a sheet opened from anywhere has none:
  // it gives focus back to whatever had it when the sheet opened, if that is still on the page.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && !locked && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/25 dark:bg-black/55" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            onOpenAutoFocus?.(e);
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
            opener.current = null;
          }}
          className={cn(
            "fixed z-50 flex flex-col bg-paper text-ink outline-none",
            "inset-y-0 right-0 w-[400px] max-w-full border-l border-rule-2",
            "max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[90dvh] max-sm:w-full max-sm:border-t max-sm:border-l-0",
          )}
        >
          <div className="flex shrink-0 flex-col gap-1 px-5 pt-5 pb-4">
            <div className="flex items-start gap-2">
              <DialogPrimitive.Title className="min-w-0 flex-1 text-title font-semibold">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close
                disabled={locked}
                aria-label="Close"
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-mt-0.5 -mr-1.5 size-7 shrink-0 px-0")}
              >
                <X className="size-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>
            {description ? (
              <DialogPrimitive.Description className="text-small text-ink-3">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">{children}</div>
          {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">{actions}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
