/** Monospace token chip - for code values like `updated_at`. */
export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "orange";
  className?: string;
}) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    accent: "bg-muted text-accent-ink",
    orange: "bg-muted text-orange",
  };
  return (
    <code
      className={`bevel-thin-in inline px-1 py-[1px] font-mono text-[11px]
        leading-none align-[-1px] ${tones[tone]} ${className}`}
    >
      {children}
    </code>
  );
}
