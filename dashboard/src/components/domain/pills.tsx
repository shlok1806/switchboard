import type { Agent, Capture, ChannelEvent, Presence, Verdict, VerdictOption } from "@shared/index";
import { StatusPill } from "@/components/atoms/StatusPill";
import { Chip } from "@/components/atoms/Chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CAPTURE_LABEL, CLI_LABEL, PRESENCE_LABEL, VERDICT_LABEL, captureOrOrigin } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

const SMALL = "h-5 gap-1 px-2 text-[11.5px]";

const PRESENCE_TONE = { live: "green", idle: "orange", gone: "neutral" } as const;

export function PresencePill({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <StatusPill tone={PRESENCE_TONE[presence]} className={cn(SMALL, className)}>
      {PRESENCE_LABEL[presence]}
    </StatusPill>
  );
}

const VERDICT_TONE = { drop: "neutral", queue: "accent", interrupt: "orange" } as const;

export function VerdictPill({ option, className }: { option: VerdictOption; className?: string }) {
  return (
    <StatusPill tone={VERDICT_TONE[option]} className={cn(SMALL, className)}>
      {VERDICT_LABEL[option]}
    </StatusPill>
  );
}

export function StalePill({ className }: { className?: string }) {
  return (
    <StatusPill tone="red" className={cn(SMALL, className)}>
      Stale Claim
    </StatusPill>
  );
}

export function RawBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-4.5 items-center rounded-[4px] bg-orange-tint px-1.5 font-mono text-[10px] font-semibold tracking-[0.06em] text-orange">
          RAW
        </span>
      </TooltipTrigger>
      <TooltipContent>Proxy mode is raw: full model turns, including context, are shared.</TooltipContent>
    </Tooltip>
  );
}

export function CaptureChip({ event }: { event: ChannelEvent }) {
  const label = captureOrOrigin(event);
  return (
    <Chip tone={event.capture === "proxy" ? "accent" : "neutral"} className="!text-[11px]">
      {label}
    </Chip>
  );
}

export function CaptureName({ capture }: { capture: Capture }) {
  return <>{CAPTURE_LABEL[capture]}</>;
}

/** An Agent ID, always shown whole; the Nickname sits beside it, never instead. */
export function AgentLink({
  agent,
  id,
  showNickname = true,
  nicknameClassName,
  className,
}: {
  agent?: Agent;
  id: string;
  showNickname?: boolean;
  nicknameClassName?: string;
  className?: string;
}) {
  return (
    <a
      href={href({ view: "agent", id })}
      className={cn("group/agent inline-flex min-w-0 items-baseline gap-1.5 hover:text-accent-ink", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="truncate font-mono text-[12px] text-ink group-hover/agent:text-accent-ink">{id}</span>
      {showNickname && agent?.nickname && (
        <span className={cn("truncate text-[12px] text-ink-3", nicknameClassName)}>{agent.nickname}</span>
      )}
    </a>
  );
}

export function CliName({ agent }: { agent: Agent }) {
  return <span className="text-ink-2">{CLI_LABEL[agent.cli]}</span>;
}

export function TaskLink({ number, title, className }: { number: number; title?: string; className?: string }) {
  return (
    <a
      href={href({ view: "task", number })}
      onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex min-w-0 items-baseline gap-1 hover:text-accent-ink", className)}
    >
      <span className="font-mono text-[12px] text-ink-2">#{number}</span>
      {title && <span className="truncate">{title}</span>}
    </a>
  );
}

/** A compact tally of what one Event did to each Agent. */
export function VerdictTally({ verdicts }: { verdicts: Verdict[] }) {
  const n = (o: VerdictOption) => verdicts.filter((v) => v.option === o).length;
  const i = n("interrupt");
  const q = n("queue");
  const d = n("drop");
  // All-Drop is the common case; only show a tally when some Agent actually heard it.
  if (!verdicts.length || i + q === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-ink-3" aria-label={`${i} Interrupt, ${q} Queue, ${d} Drop`}>
      {i > 0 && <span className="inline-flex items-center gap-1 text-orange"><Dot className="bg-verdict-interrupt" />{i}</span>}
      {q > 0 && <span className="inline-flex items-center gap-1 text-accent-ink"><Dot className="bg-verdict-queue" />{q}</span>}
      <span className="inline-flex items-center gap-1"><Dot className="bg-verdict-drop" />{d}</span>
    </span>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn("size-1.5 rounded-full", className)} />;
}
