import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * The Dashboard's one button voice (design.md): 30px, 13/500, radius 3, one verb, a label
 * that never wraps. `primary` is ink, one per region (`action` is the same, kept for the
 * views that name it); `secondary` is a 1px outline; `ghost` is text only. A press moves
 * it down 1px. The signal colour is never a button.
 */
export const buttonVariants = cva(
  `inline-flex items-center justify-center rounded-[var(--r)] border font-medium select-none whitespace-nowrap
   transition-[background-color,border-color,color] duration-[var(--dur)] ease-[var(--ease-out)]
   active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none
   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`,
  {
    variants: {
      variant: {
        action: "border-ink bg-ink text-paper hover:border-ink-2 hover:bg-ink-2",
        primary: "border-ink bg-ink text-paper hover:border-ink-2 hover:bg-ink-2",
        secondary: "border-rule-2 bg-transparent text-ink hover:border-ink-3 hover:bg-paper-2 active:bg-paper-3 aria-expanded:bg-paper-3",
        ghost: "border-transparent text-ink hover:bg-paper-2",
      },
      size: {
        xs: "h-[26px] px-2 text-label gap-1.5",
        sm: "h-7 px-2.5 text-small gap-2",
        md: "h-[30px] px-3 text-small gap-2",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export function Button({
  variant,
  size,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
