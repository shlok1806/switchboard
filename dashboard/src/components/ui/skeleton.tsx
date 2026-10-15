import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("loading-pulse rounded-md bg-hover", className)}
      {...props}
    />
  )
}

export { Skeleton }
