"use client";

/** Segmented control - equal-width segments, sliding thumb. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  const index = options.indexOf(value);
  return (
    <div
      className={`relative inline-grid h-9 select-none rounded-md bg-hover p-0.5 ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
      role="tablist"
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 rounded-sm bg-surface
          transition-transform duration-200"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          left: 2,
          transform: `translateX(${index * 100}%)`,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      />
      {options.map((opt) => (
        <button
          key={opt}
          role="tab"
          aria-selected={opt === value}
          onClick={() => onChange(opt)}
          className={`relative z-10 rounded-sm px-3 text-small font-medium focus-visible:outline-2 focus-visible:outline-accent
            transition-colors duration-150
            ${opt === value ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
