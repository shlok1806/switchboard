import type { Actor, Agent, Capture, ChannelEvent, Presence, Verdict, VerdictOption } from "@shared/index";
import { Bot, GitMerge, Radio, User, Webhook, Wrench, Cpu, type LucideIcon } from "lucide-react";
import { StatusPill } from "@/components/atoms/StatusPill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/components/shell/nav";
import { CAPTURE_LABEL, CLI_LABEL, PRESENCE_LABEL, VERDICT_LABEL, captureOrOrigin } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

const SMALL = "h-5 gap-1 px-2 text-[12px]";

const PRESENCE_TONE = { live: "green", idle: "orange", gone: "neutral" } as const;

const PRESENCE_HINT: Record<Presence, string> = {
  live: "Live: working now",
  idle: "Idle: connected, between turns",
  gone: "Gone: silent for about ten minutes",
};

export function PresencePill({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <StatusPill tone={PRESENCE_TONE[presence]} className={cn(SMALL, className)}>
      {PRESENCE_LABEL[presence]}
    </StatusPill>
  );
}

/** Presence as one coloured dot, named on hover. */
export function PresenceDot({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-grid size-3 shrink-0 place-items-center", className)}>
          <span
            className={cn(
              "size-2 rounded-full",
              presence === "live" && "bg-green",
              presence === "idle" && "bg-orange",
              presence === "gone" && "border border-ink-4",
            )}
          />
          <span className="sr-only">{PRESENCE_LABEL[presence]}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{PRESENCE_HINT[presence]}</TooltipContent>
    </Tooltip>
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
      Stale
    </StatusPill>
  );
}

export function RawBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-5 items-center rounded-full bg-orange-tint px-2 text-[11.5px] font-medium text-orange">Raw</span>
      </TooltipTrigger>
      <TooltipContent>Raw proxy mode: full model turns, context included, are shared.</TooltipContent>
    </Tooltip>
  );
}

const CAPTURE_ICON: Record<Capture, LucideIcon> = { proxy: Cpu, hook: Webhook, tool: Wrench };

/** Where an Event came from, as a small icon named on hover. */
export function CaptureIcon({ event, className }: { event: ChannelEvent; className?: string }) {
  const label = captureOrOrigin(event);
  const Icon = event.capture ? CAPTURE_ICON[event.capture] : label.startsWith("GitHub") ? GitMerge : label === "Dashboard" ? User : Radio;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-grid shrink-0 place-items-center text-ink-4", className)} aria-label={label} role="img">
          <Icon className="size-3.5" aria-hidden strokeWidth={1.75} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{event.capture ? `${label} Capture` : label}</TooltipContent>
    </Tooltip>
  );
}

/** Where an Event came from, as a quiet text chip (detail views). */
export function CaptureChip({ event }: { event: ChannelEvent }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11.5px]", event.capture === "proxy" ? "bg-accent-tint text-accent-ink" : "bg-hover text-ink-3")}>
      {captureOrOrigin(event)}
    </span>
  );
}

export function CaptureName({ capture }: { capture: Capture }) {
  return <>{CAPTURE_LABEL[capture]}</>;
}

/** A round avatar for whoever did something: initials for a Person, a robot for an Agent, the mark for GitHub. */
export function ActorAvatar({ actor, size = "md" }: { actor: Actor; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-6 text-[10px]" : "size-8 text-[11.5px]";
  if (actor.kind === "github" || actor.kind === "relay") {
    const Icon = actor.kind === "github" ? GitMerge : Radio;
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-full bg-hover-2 text-ink-2", box)} aria-hidden>
        <Icon className="size-[55%]" strokeWidth={1.75} />
      </span>
    );
  }
  // An Agent wears its Person's initials, with a small robot badge.
  if (actor.kind === "agent")
    return (
      <span className={cn("relative grid shrink-0 place-items-center rounded-full bg-hover-2 font-semibold text-ink-2", box)} aria-hidden>
        {initials(actor.agentId.split("/")[0])}
        <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-surface text-ink-3 ring-1 ring-line">
          <Bot className="size-2.5" strokeWidth={2} />
        </span>
      </span>
    );
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-full bg-accent-tint font-semibold text-accent-ink", box)} aria-hidden>
      {initials(actor.person)}
    </span>
  );
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
      className={cn("group/agent inline-flex min-w-0 items-baseline gap-1.5", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="min-w-0 font-mono text-[12.5px] [overflow-wrap:anywhere] text-ink group-hover/agent:text-accent-ink">{id}</span>
      {showNickname && agent?.nickname && <span className={cn("truncate text-[12.5px] text-ink-3", nicknameClassName)}>{agent.nickname}</span>}
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
      className={cn("inline-flex min-w-0 items-baseline gap-1.5 hover:text-accent-ink", className)}
    >
      <span className="font-mono text-[12px] text-ink-3">#{number}</span>
      {title && <span className="truncate">{title}</span>}
    </a>
  );
}

/** What one Event did to each Agent, as dots. All-Drop is the common case and shows nothing. */
export function VerdictTally({ verdicts }: { verdicts: Verdict[] }) {
  const n = (o: VerdictOption) => verdicts.filter((v) => v.option === o).length;
  const i = n("interrupt");
  const q = n("queue");
  const d = n("drop");
  if (!verdicts.length || i + q === 0) return null;
  const label = `${i} Interrupt, ${q} Queue, ${d} Drop`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] tabular-nums text-ink-3" role="img" aria-label={label}>
          {i > 0 && (
            <span className="inline-flex items-center gap-1 text-orange">
              <Dot className="bg-verdict-interrupt" />
              {i}
            </span>
          )}
          {q > 0 && (
            <span className="inline-flex items-center gap-1 text-accent-ink">
              <Dot className="bg-verdict-queue" />
              {q}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn("size-1.5 rounded-full", className)} />;
}
