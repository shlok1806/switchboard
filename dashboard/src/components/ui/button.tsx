import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/* Switchboard: shadcn's variants re-skinned as Motif push buttons (see index.css .btn-motif). */
const buttonVariants = cva(
  "btn-motif shrink-0 gap-2 font-normal outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "font-semibold outline outline-1 outline-[hsl(var(--foreground))]",
        destructive: "font-semibold text-destructive",
        outline: "",
        secondary: "",
        ghost: "border-transparent bg-transparent hover:bg-hover",
        link: "border-transparent bg-transparent text-accent-ink underline underline-offset-2",
      },
      size: {
        default: "h-8 px-4",
        xs: "h-6 gap-1 px-2 text-xs",
        sm: "h-[26px] gap-1.5 px-3",
        lg: "h-9 px-6",
        icon: "size-8",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
