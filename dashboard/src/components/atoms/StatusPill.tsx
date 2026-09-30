import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusPillVariants = cva(
  "inline-flex h-5 items-center gap-1.5 border border-current/35 px-1.5 text-[12px] font-semibold leading-none",
  {
    variants: {
      tone: {
        green: "text-green",
        orange: "text-orange",
        red: "bg-destructive text-destructive-foreground border-transparent",
        accent: "text-accent-ink",
        neutral: "text-ink-2",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

type Tone = NonNullable<VariantProps<typeof statusPillVariants>["tone"]>;

/* the leading dot lives on a separate element, so its color stays a small lookup */
const dotColor: Record<Tone, string> = {
  green: "bg-green",
  orange: "bg-orange",
  red: "bg-red",
  accent: "bg-accent",
  neutral: "bg-ink-3",
};

export function StatusPill({
  tone = "neutral",
  children,
  dot = true,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cn(statusPillVariants({ tone }), className)}>
      {dot && <span className={cn("size-1.5", tone === "red" ? "bg-current" : dotColor[tone])} />}
      {children}
    </span>
  );
}
