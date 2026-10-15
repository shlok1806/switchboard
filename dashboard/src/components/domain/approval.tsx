import type { Agent } from "@shared/index";
import { MAX_DENY_MESSAGE_LENGTH } from "@shared/index";
import { ShieldAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/atoms/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMe, useStore } from "@/data/store";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "./usage";

/**
 * The permission prompt an Agent's CLI is waiting on (ADR 0013). It is answered at the
 * Agent's terminal; the Agent's own Person may also deny it here when its wrapper holds
 * the prompt (ADR 0014), never approve it. The reason comes from the model, so it is
 * shown as the Agent's, not as a fact.
 */
export function PendingApproval({ agent, className }: { agent: Agent; className?: string }) {
  const now = useNow();
  const me = useMe();
  const a = agent.approval;
  if (!a || agent.presence === "gone") return null;
  const canDeny = a.deniable === true && a.deniedBy === undefined && agent.person === me;
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
      {a.deniedBy ? (
        <p className="text-ink-2">Denied by {a.deniedBy}. Waiting for the Agent to move on.</p>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-ink-3">
            {canDeny ? "Answer it at the Agent's terminal, or deny it here." : "Answer it at the Agent's terminal."}
          </p>
          {canDeny && <DenyAction agent={agent} id={a.id} tool={a.tool} />}
        </div>
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
        size="xs"
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
                <span className="font-mono">{agent.nickname ?? agent.id}</span> does not run it, and reads your message
                instead. Nothing can be approved from here.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">
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
                className="resize-none rounded-lg border border-line-strong bg-field px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-4 focus-visible:border-accent max-md:text-[16px]"
              />
            </label>
            <DialogFooter>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" size="sm" disabled={busy}>
                {busy ? "Denying" : "Deny"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
