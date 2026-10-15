import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * One button shape on the whole Dashboard: the one radius, flat fills, no shadow.
 * `action` is the tangerine primary and appears once per screen at most; `primary`
 * is solid ink for a strong control that is not the screen's main action;
 * `secondary` is a tone step; `ghost` shows only on hover. A disabled `action` or
 * `primary` falls back to the secondary tone step, not a faded slab of colour.
 */
export const buttonVariants = cva(
  `inline-flex items-center justify-center rounded-md font-medium select-none whitespace-nowrap
   transition-[transform,background-color,color,opacity] duration-150 ease-out
   active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none
   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`,
  {
    variants: {
      variant: {
        action: "bg-action text-on-action hover:bg-action-hover disabled:bg-hover-2 disabled:text-ink-3 disabled:opacity-100",
        primary: "bg-ink text-page hover:bg-ink-2 disabled:bg-hover-2 disabled:text-ink-3 disabled:opacity-100",
        secondary: "bg-inset text-ink hover:bg-hover-2 aria-expanded:bg-hover-2",
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
