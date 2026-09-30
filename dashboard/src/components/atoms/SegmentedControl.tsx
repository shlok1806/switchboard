"use client";

/*
 * Segmented control. Switchboard: re-skinned from Beautiful UI's sliding thumb
 * to a Motif radio box: a row of push buttons, the chosen one pressed in.
 */
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
  return (
    <div
      className={`inline-grid select-none gap-[2px] ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
      role="tablist"
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="tab"
          aria-selected={opt === value}
          aria-pressed={opt === value}
          onClick={() => onChange(opt)}
          className={`btn-motif h-[26px] px-3 text-[12px] coarse:h-9 ${opt === value ? "bg-muted font-bold" : ""}`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
