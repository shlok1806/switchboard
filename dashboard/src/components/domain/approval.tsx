import type { Agent } from "@shared/index";
import { ShieldAlert } from "lucide-react";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "./usage";

/**
 * The permission prompt an Agent's CLI is waiting on (ADR 0013). Read-only: it is
 * answered at the Agent's terminal. The reason comes from the model, so it is shown
 * as the Agent's, not as a fact.
 */
export function PendingApproval({ agent, className }: { agent: Agent; className?: string }) {
  const now = useNow();
  const a = agent.approval;
  if (!a || agent.presence === "gone") return null;
  return (
    <section
      aria-label="Waiting for approval"
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border border-orange/30 bg-orange-tint p-3 text-[12px]", className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ShieldAlert aria-hidden className="size-3.5 shrink-0 text-orange" />
        <span className="min-w-0 truncate font-medium text-orange">Waiting for approval</span>
        <span className="ml-auto shrink-0 text-ink-3">{ago(a.openedAt, now)}</span>
      </div>
      <span className="break-all font-mono text-ink-2">{a.tool}</span>
      {a.detail && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface/70 px-2 py-1.5 font-mono text-[12px] text-ink">
          {a.detail}
        </pre>
      )}
      {a.reason && <p className="break-words text-ink-2">The Agent says: {a.reason}</p>}
      <p className="text-ink-3">Answer it at the Agent's terminal.</p>
    </section>
  );
}
