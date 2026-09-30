/*
 * The Motif window frame from shlokthakkar.com (components/os/Window.tsx):
 * a raised grey frame, a solid title bar in the preset's primary, and the
 * document inset into it. The Dashboard is one maximised window on a
 * stippled root window, so the frame never moves or resizes; only the look
 * comes across.
 */
import type { ReactNode } from "react";
import { PixelIcon, type IconName } from "@/components/pixel-icon";
import { cn } from "@/lib/utils";

/** A title bar button: the 16px glyph at 1:1 inside a 1px bevel, so it never blurs. */
export function TitleButton({
  label,
  icon,
  onClick,
  children,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="group flex h-6 shrink-0 items-center gap-1.5 px-[3px] coarse:h-11"
    >
      <span className="bevel-thin grid h-[18px] min-w-[18px] place-items-center bg-secondary leading-none text-secondary-foreground group-active:bevel-thin-in coarse:h-6 coarse:min-w-6">
        <PixelIcon name={icon} />
      </span>
      {children}
    </button>
  );
}

export function WindowFrame({
  title,
  left,
  right,
  status,
  children,
  className,
}: {
  title: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bevel-out flex min-h-0 min-w-0 flex-1 flex-col bg-secondary", className)}>
      <header className="titlebar-active flex h-[26px] shrink-0 select-none items-center gap-1.5 px-1 coarse:h-11">
        {left}
        <h1 className="min-w-0 flex-1 truncate px-1 text-[13px] leading-none font-bold tracking-tight">{title}</h1>
        {right}
      </header>
      <div className="bevel-in m-[3px] mt-0 flex min-h-0 flex-1 flex-col overflow-hidden bg-card text-card-foreground">
        {children}
      </div>
      {status && (
        <div className="mx-[3px] mb-[3px] flex h-[20px] shrink-0 items-center gap-3 overflow-hidden px-2 text-[12px] leading-none whitespace-nowrap text-muted-foreground">
          {status}
        </div>
      )}
    </section>
  );
}
