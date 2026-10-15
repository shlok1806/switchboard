import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * One button shape on the whole Dashboard: the one radius, flat fills, no shadow.
 * `action` is the screen's main control, solid ink (ADR 0023: tangerine is kept for
 * "a Person is needed"), and appears once per screen at most; `primary` is the same
 * ink for a strong control that is not the main action; `secondary` is a tone step;
 * `ghost` shows only on hover. A disabled `action` or
 * `primary` falls back to the secondary tone step, not a faded slab of colour.
 */
export const buttonVariants = cva(
  `inline-flex items-center justify-center rounded-md font-medium select-none whitespace-nowrap
   transition-[transform,background-color,color,opacity] duration-150 ease-out
   active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none
   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`,
  {
    variants: {
      variant: {
        action: "bg-action text-on-action hover:bg-action-hover disabled:bg-inset-2 disabled:text-ink-3 disabled:opacity-100",
        primary: "bg-action text-on-action hover:bg-action-hover disabled:bg-inset-2 disabled:text-ink-3 disabled:opacity-100",
        secondary: "bg-inset text-ink hover:bg-inset-2 aria-expanded:bg-inset-2",
        ghost: "text-ink-2 hover:bg-hover hover:text-ink",
      },
      size: {
        xs: "h-7 px-2.5 text-small gap-1",
        sm: "h-8 px-3 text-small gap-1.5",
        md: "h-10 px-4 text-body gap-2",
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
