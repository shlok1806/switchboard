"use client";

import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Switchboard: every variant is a Motif push button, drawn from the bevel
 * tokens as on shlokthakkar.com: raised at rest, pressed in while held. The
 * variants that used to be colour fills keep their names so call sites read
 * the same; "accent" is the default button of a dialog, which Motif marked
 * with a dark ring around the bevel rather than a colour.
 */
export const buttonVariants = cva(
  `btn-motif font-normal disabled:pointer-events-none`,
  {
    variants: {
      variant: {
        primary: "font-semibold outline outline-1 outline-offset-0 outline-[hsl(var(--foreground))]",
        secondary: "",
        ghost: "",
        accent: "font-semibold outline outline-1 outline-offset-0 outline-[hsl(var(--foreground))]",
        success: "font-semibold text-green",
        /* flat until pressed, for dense rows */
        quiet: "border-transparent bg-transparent hover:bg-hover",
      },
      size: {
        xs: "h-6 px-2 text-[12px] gap-1",
        sm: "h-[26px] px-3 text-[13px] gap-1.5",
        md: "h-8 px-4 text-[13px] gap-2",
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
