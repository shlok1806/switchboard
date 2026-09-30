/* Switchboard: Kibo UI Status. The pinging dot is gone (the site never eases or
 * pulses); shape carries the state instead, one bit deep: filled for online,
 * hollow for degraded, a small dot for offline. */
import type { ComponentProps, HTMLAttributes } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusProps = ComponentProps<typeof Badge> & {
  status: "online" | "offline" | "maintenance" | "degraded";
};

export const Status = ({ className, status, ...props }: StatusProps) => (
  <Badge
    className={cn("flex items-center gap-2", "group", status, className)}
    variant="secondary"
    {...props}
  />
);

export type StatusIndicatorProps = HTMLAttributes<HTMLSpanElement>;

export const StatusIndicator = ({
  className,
  ...props
}: StatusIndicatorProps) => (
  <span className={cn("relative grid size-2 place-items-center", className)} {...props}>
    <span
      className={cn(
        "inline-flex",
        "group-[.online]:size-2 group-[.online]:bg-green",
        "group-[.offline]:size-1 group-[.offline]:bg-faint",
        "group-[.maintenance]:size-2 group-[.maintenance]:bg-accent",
        "group-[.degraded]:size-2 group-[.degraded]:border group-[.degraded]:border-orange"
      )}
    />
  </span>
);

export type StatusLabelProps = HTMLAttributes<HTMLSpanElement>;

export const StatusLabel = ({
  className,
  children,
  ...props
}: StatusLabelProps) => (
  <span className={cn("text-muted-foreground", className)} {...props}>
    {children ?? (
      <>
        <span className="hidden group-[.online]:block">Online</span>
        <span className="hidden group-[.offline]:block">Offline</span>
        <span className="hidden group-[.maintenance]:block">Maintenance</span>
        <span className="hidden group-[.degraded]:block">Degraded</span>
      </>
    )}
  </span>
);
