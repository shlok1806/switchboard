import { useState } from "react";
import { toast } from "sonner";
import type { Holder, Task } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCapabilities, useChannel, useMe, useStore } from "@/data/store";
import { holderName } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Take over a Stale Claim (#11, ADR 0002): `POST /api/tasks/:n/takeover`. Only a
 * Person does this, and only when the holder is Gone. The Person picks the new
 * holder (themselves or one of their own Live or Idle Agents) and confirms in a
 * Motif dialog; the Channel's answer, or its refusal, comes back as a notice.
 */
export function TakeoverAction({ task, compact = false }: { task: Task; compact?: boolean }) {
  const store = useStore();
  const me = useMe();
  const { agents } = useChannel();
  const can = useCapabilities();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  if (!task.claim?.stale || !can.takeover) return null;

  const from = task.claim.holder;
  const options: Holder[] = [
    { kind: "person", person: me },
    ...agents
      .filter((a) => a.person === me && a.presence !== "gone")
      .map((a): Holder => ({ kind: "agent", agentId: a.id })),
  ];
  const labelFor = (h: Holder) => (h.kind === "person" ? `Me (${h.person})` : holderName(h));

  const confirm = async () => {
    const to = options[pick];
    setBusy(true);
    const result = await store.source.act({ type: "takeover", task: task.number, to });
    setBusy(false);
    if (!result.ok) {
      toast.error(`Could not take over #${task.number}`, { description: result.reason });
      return;
    }
    setOpen(false);
    toast.success(`Took over #${task.number}`, { description: `Now held by ${holderName(to)}. ${holderName(from)} is told at its next turn.` });
  };

  return (
    <>
      <Button
        variant="accent"
        size={compact ? "xs" : "sm"}
        className={compact ? undefined : "w-full"}
        onClick={(e) => {
          e.stopPropagation();
          setPick(0);
          setOpen(true);
        }}
      >
        Take over
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Take over #{task.number}</DialogTitle>
            <DialogDescription>
              {holderName(from)} is Gone, so its Claim on "{task.title}" is Stale. The Steps already done and the last
              Update go to the new holder.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[13px] font-semibold">Give it to</legend>
            {options.map((h, i) => (
              <label key={i} className="flex cursor-pointer items-center gap-2 py-1 text-[13px] coarse:min-h-11">
                <input type="radio" name="takeover-to" checked={pick === i} onChange={() => setPick(i)} className="peer sr-only" />
                {/* A Motif radio: a diamond, pressed in when chosen */}
                <span
                  aria-hidden
                  className={cn(
                    "bevel-thin-in size-3 rotate-45 bg-card peer-focus-visible:outline-2 peer-focus-visible:outline-[hsl(var(--ring))]",
                    pick === i && "bg-primary",
                  )}
                />
                <span className={h.kind === "agent" ? "font-mono text-[12px]" : undefined}>{labelFor(h)}</span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="accent" size="sm" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Taking over" : "Take over"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
