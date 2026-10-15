import type { Actor, Agent, Capture, ChannelEvent, Presence, Verdict, VerdictOption } from "@shared/index";
import { modelLabel } from "@shared/index";
import { GitMerge, Radio, User, Webhook, Wrench, Cpu, type LucideIcon } from "lucide-react";
import { Tag } from "@/components/atoms/Tag";
import { State } from "@/components/domain/state";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/components/shell/nav";
import { CAPTURE_LABEL, CLI_LABEL, VERDICT_LABEL, captureOrOrigin } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

const PRESENCE_STATE = { live: "running", idle: "idle", gone: "gone" } as const;

/** An Agent's presence alone, as the state vocabulary draws it. */
export function PresencePill({ presence, className }: { presence: Presence; className?: string }) {
  return <State state={PRESENCE_STATE[presence]} className={cn("text-small", className)} />;
}

export function VerdictPill({ option, className }: { option: VerdictOption; className?: string }) {
  return <Tag className={className}>{VERDICT_LABEL[option]}</Tag>;
}

export function StalePill({ className }: { className?: string }) {
  return <State state="stale" className={cn("text-small", className)} />;
}

export function RawBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Tag>Raw</Tag>
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
        <span className={cn("inline-grid shrink-0 place-items-center text-ink-3", className)} aria-label={label} role="img">
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
    <Tag>{captureOrOrigin(event)}</Tag>
  );
}

export function CaptureName({ capture }: { capture: Capture }) {
  return <>{CAPTURE_LABEL[capture]}</>;
}

/**
 * A square mark for whoever did something: initials for a Person, a robot for an Agent, the
 * mark for GitHub. Square at radius 3, so it never reads as a state disc.
 */
export function ActorAvatar({ actor, size = "md" }: { actor: Actor; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-6 text-small" : "size-8 text-small";
  if (actor.kind === "github" || actor.kind === "relay") {
    const Icon = actor.kind === "github" ? GitMerge : Radio;
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-[var(--r)] bg-paper-3 text-ink-2", box)} aria-hidden>
        <Icon className="size-[55%]" strokeWidth={1.75} />
      </span>
    );
  }
  // An Agent wears its Person's initials on paper-3; a Person's own are ink.
  if (actor.kind === "agent")
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-[var(--r)] bg-paper-3 font-semibold text-ink-2", box)} aria-hidden>
        {initials(actor.agentId.split("/")[0])}
      </span>
    );
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-[var(--r)] bg-ink font-semibold text-paper", box)} aria-hidden>
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
      <span className="min-w-0 text-body font-medium [overflow-wrap:anywhere] text-ink tabular-nums underline-offset-4 group-hover/agent:underline">{id}</span>
      {showNickname && agent?.nickname && <span className={cn("min-w-0 [overflow-wrap:anywhere] text-body text-ink-3", nicknameClassName)}>{agent.nickname}</span>}
    </a>
  );
}

/** Which login of its CLI the Agent runs under (ADR 0009), as its wrapper reported it. */
export function AccountLabel({ account, className }: { account: string; className?: string }) {
  return (
    <span className={className ?? "inline-flex min-w-0 items-center gap-1"} title="The login of its CLI this Agent runs under">
      <span className="[overflow-wrap:anywhere]">{account}</span>
    </span>
  );
}

/**
 * The model an Agent runs on (ADR 0010): a short name such as "Opus 5.5", the raw ID
 * on hover, and the reasoning effort when the requests carry one.
 */
export function ModelLabel({ model, effort, className }: { model: string; effort?: string; className?: string }) {
  const label = modelLabel(model);
  return (
    <span className={className ?? "inline-flex min-w-0 items-center gap-1"} title={effort ? `${model}, effort ${effort}` : model}>
      <span className="[overflow-wrap:anywhere]">
        {label}
        {effort ? ` · ${effort}` : ""}
      </span>
    </span>
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
      className={cn("group/task inline-flex min-w-0 items-baseline gap-1.5 transition-colors hover:text-ink", className)}
    >
      <span className="text-ink-3 tabular-nums">#{number}</span>
      {title && <span className="min-w-0 [overflow-wrap:anywhere] underline-offset-4 group-hover/task:underline">{title}</span>}
    </a>
  );
}

/** What one Event did to each Agent, in words. All-Drop is the common case and shows nothing. */
export function VerdictTally({ verdicts }: { verdicts: Verdict[] }) {
  const n = (o: VerdictOption) => verdicts.filter((v) => v.option === o).length;
  const i = n("interrupt");
  const q = n("queue");
  const d = n("drop");
  if (!verdicts.length || i + q === 0) return null;
  return (
    <span className="inline-flex items-center gap-2 text-small tabular-nums text-ink-3" title={`${i} Interrupt, ${q} Queue, ${d} Drop`}>
      {[i > 0 && `${i} Interrupt`, q > 0 && `${q} Queue`].filter(Boolean).join(" · ")}
    </span>
  );
}
