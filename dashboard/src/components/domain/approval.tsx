import type { Agent } from "@shared/index";
import { MAX_DENY_MESSAGE_LENGTH } from "@shared/index";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Glyph, State } from "@/components/domain/state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useChannel, useMe, useStore } from "@/data/store";
import { elapsed, hostName, localTime, zoneCity } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useNow } from "./usage";

/**
 * The Ask (design.md): the permission prompt an Agent's CLI is waiting on (ADR 0013), the
 * same on the Agents list, an Agent's page and the canvas. It is answered at the Agent's
 * terminal; the Agent's own Person may also deny it here when its wrapper holds the prompt
 * (ADR 0014), never approve it. The reason comes from the model, so it is shown as the
 * Agent's, not as a fact.
 */
export function PendingApproval({
  agent,
  word = false,
  heading: H = "h3",
  onOpenTerminal,
  className,
}: {
  agent: Agent;
  /** Name the state before the line, as the Now queue does. */
  word?: boolean;
  /** The heading level, so the page's outline never skips one. */
  heading?: "h2" | "h3";
  /** On the Agent's own page the terminal is below the Ask: go to it rather than link to this page. */
  onOpenTerminal?: () => void;
  className?: string;
}) {
  const now = useNow();
  const me = useMe();
  const { snapshot, tasks } = useChannel();
  const a = agent.approval;
  if (!a || agent.presence === "gone") return null;
  const mine = agent.person === me;
  const canDeny = a.deniable === true && a.deniedBy === undefined && mine;
  const zone = snapshot?.persons.find((p) => p.name === agent.person)?.timeZone;
  const theirTime = zone ? localTime(now, zone) || null : null;
  const where = zone && zoneCity(zone);
  const task = tasks.find((t) => t.claim?.holder.kind === "agent" && t.claim.holder.agentId === agent.id && t.status !== "done");
  const meta = [
    `${mine ? "Your Agent" : `${agent.person}'s Agent`} ${agent.host ? `on ${hostName(agent.host)}` : "in a terminal"}`,
    task && `#${task.number} ${task.title}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-label={`${agent.nickname ?? agent.id} wants to run ${a.tool}`} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 items-baseline gap-2">
        <H className="min-w-0 flex-1 text-row font-semibold [overflow-wrap:anywhere] text-ink">
          {word ? (
            <State state={mine ? "needs" : "needs-other"} person={agent.person} className="mr-2 align-[-1px]" />
          ) : (
            <Glyph state={mine ? "needs" : "needs-other"} className="mr-2 align-[-1px]" />
          )}
          {agent.nickname ?? agent.id} wants to run <code>{a.tool}</code>
        </H>
        <span className="shrink-0 text-small text-ink-3 tabular-nums">{elapsed(a.openedAt, now)}</span>
      </div>
      {a.detail && (
        <pre className="max-h-40 overflow-auto rounded-[var(--r)] bg-paper-2 px-3 py-2 text-small leading-normal whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">
          {a.detail}
        </pre>
      )}
      {a.reason && <p className="max-w-[72ch] text-row break-words text-ink">The Agent says: {a.reason}</p>}
      {mine && <p className="text-small text-ink-3">{meta}</p>}
      {a.deniedBy ? (
        <p className="text-small text-ink-3">Denied by {a.deniedBy}. Waiting for the Agent to move on.</p>
      ) : (
        <>
          <p className="max-w-[60ch] text-small text-ink-3">
            {mine
              ? canDeny
                ? "Answer it at the Agent's terminal, or deny it here."
                : "Answer it at the Agent's terminal."
              : `Only ${agent.person} can answer${theirTime ? `; it is ${theirTime}${where ? ` in ${where}` : " for them"}` : ""}. You can watch.`}
          </p>
          <div data-acts className="flex flex-wrap items-center gap-2 pt-1">
            {canDeny && <DenyAction agent={agent} id={a.id} tool={a.tool} />}
            {onOpenTerminal ? (
              <button type="button" onClick={onOpenTerminal} className={buttonVariants({ variant: mine ? "ghost" : "secondary" })}>
                {mine ? "Open the terminal" : "Watch"}
              </button>
            ) : (
              <a href={href({ view: "agent", id: agent.id })} onClick={(e) => e.stopPropagation()} className={buttonVariants({ variant: mine ? "ghost" : "secondary" })}>
                {mine ? "Open the terminal" : "Watch"}
              </a>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Deny the prompt from the Channel, with a message the Agent reads (ADR 0014). */
function DenyAction({ agent, id, tool }: { agent: Agent; id: string; tool: string }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const said = message.trim();
    const result = await store.source.act({
      type: "deny-approval",
      agent: agent.id,
      id,
      ...(said === "" ? {} : { message: said }),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error("Could not deny the prompt", { description: result.reason });
      return;
    }
    setOpen(false);
    toast.success(`Denied ${tool}`, { description: "The Agent reads why and moves on." });
  };

  return (
    <>
      <Button
        variant="secondary"
        onClick={(e) => {
          e.stopPropagation();
          setMessage("");
          setOpen(true);
        }}
      >
        Deny
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Deny {tool}</DialogTitle>
              <DialogDescription>
                <span className="font-medium text-ink">{agent.nickname ?? agent.id}</span> does not run it, and reads your message
                instead. Nothing can be approved from here.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-1.5">
              <span className="text-small font-medium text-ink">
                Message <span className="font-normal text-ink-3">optional</span>
              </span>
              <textarea
                name="message"
                rows={3}
                autoFocus
                maxLength={MAX_DENY_MESSAGE_LENGTH}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Not now. Use the cached build instead."
                className="resize-none rounded-[var(--r)] border border-rule-2 bg-paper px-3 py-2 text-row text-ink hover:bg-paper-2 max-sm:text-[16px]"
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                {busy ? "Denying" : "Deny"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
