import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import { toast } from "sonner";
import type { Agent } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStore } from "@/data/store";

/** An Agent its Person made a lead (ADR 0018). */
export function LeadLabel() {
  return (
    <span
      className="inline-flex items-center gap-1 text-ink-2"
      title="A lead: its Person lets it start Agents on their Hosts, and stop and direct the Agents it starts"
    >
      <Network className="size-3.5 shrink-0" aria-hidden />
      <span>lead</span>
    </span>
  );
}

/** Grants or takes back the lead role on one of this Person's own Agents (ADR 0018). */
export function useSetLead(agent: Agent) {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const name = agent.nickname ?? agent.id;
  /** Resolves to why it failed, or null. A caller that shows the reason itself passes `toastError: false`. */
  const set = async (lead: boolean, toastError = true): Promise<string | null> => {
    setBusy(true);
    const result = await store.source.setRole(agent.id, lead ? "lead" : null);
    setBusy(false);
    if (!result.ok) {
      if (toastError) toast.error(result.reason);
      return result.reason;
    }
    toast.success(lead ? `${name} is a lead now` : `${name} is no longer a lead`);
    return null;
  };
  return { busy, set };
}

/**
 * Asks before making an Agent a lead, since it lets a model start processes on the
 * Person's Hosts. Taking the role back needs no question.
 */
export function LeadDialog({ agent, open, onOpenChange }: { agent: Agent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { busy, set } = useSetLead(agent);
  const [error, setError] = useState<string | null>(null);
  const name = agent.nickname ?? agent.id;
  // A failed grant keeps the dialog open with its reason; opening it again starts clean.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const grant = async () => {
    const reason = await set(true, false);
    if (reason === null) onOpenChange(false);
    else setError(reason);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make {name} a lead?</DialogTitle>
          <DialogDescription>
            It may start Claude Code Agents on your Hosts, in their folders and permission modes, and stop and send
            Directives to the Agents it starts. Its Directives carry instruction weight for them; your own word still
            wins. Every step it takes is on the Channel, and you can revoke this at any time.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-row text-ink">
            Not granted: {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => void grant()}>
            {busy ? "Granting" : "Make lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
