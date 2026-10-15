import { useState } from "react";
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
import { useMe, useStore } from "@/data/store";

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

/**
 * Make one of this Person's own Agents a lead, or take the role back (ADR 0018). Making
 * one asks first, since it lets a model start processes on the Person's Hosts.
 */
export function LeadButton({ agent }: { agent: Agent }) {
  const store = useStore();
  const me = useMe();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (agent.person !== me) return null;
  const lead = agent.role === "lead";
  const name = agent.nickname ?? agent.id;

  const set = async () => {
    setBusy(true);
    const result = await store.source.setRole(agent.id, lead ? null : "lead");
    setBusy(false);
    setConfirming(false);
    if (!result.ok) toast.error(result.reason);
    else toast.success(lead ? `${name} is no longer a lead` : `${name} is a lead now`);
  };

  if (lead) {
    return (
      <Button size="sm" variant="ghost" disabled={busy} onClick={set}>
        {busy ? "Revoking" : "Revoke lead"}
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} className="gap-1.5">
        <Network className="size-3.5" aria-hidden /> <span>Make lead</span>
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Make {name} a lead?</DialogTitle>
            <DialogDescription>
              It may start Claude Code Agents on your Hosts, in their folders and permission modes, and stop and send
              Directives to the Agents it starts. Its Directives carry instruction weight for them; your own word still
              wins. Every step it takes is on the Channel, and you can revoke this at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="sm" disabled={busy} onClick={set}>
              {busy ? "Granting" : "Make lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
