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
 * dialog; the Channel's answer, or its refusal, comes back as a toast.
 */
export function TakeoverAction({
  task,
  compact = false,
  line = false,
  size,
}: {
  task: Task;
  compact?: boolean;
  /** A queue line's primary action, naming the Task. */
  line?: boolean;
  /** Overrides the size the other two set, as on a canvas node. */
  size?: "xs" | "sm" | "md";
}) {
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
    toast.success(`Took over #${task.number}`, { description: `Now held by ${holderName(to)}` });
  };

  return (
    <>
      <Button
        variant={compact || line ? "primary" : "action"}
        size={size ?? (line ? "md" : compact ? "xs" : "sm")}
        className={compact || line ? undefined : "w-full"}
        onClick={(e) => {
          e.stopPropagation();
          setPick(0);
          setOpen(true);
        }}
      >
        {line ? `Take over #${task.number}` : "Take over"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Take over #{task.number}</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-ink">{holderName(from)}</span> is Gone. Its Steps and last Update go to the new holder.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1.5 text-small text-ink-3">Give it to</legend>
            {options.map((h, i) => (
              <label
                key={i}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-3 text-body transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                  pick === i ? "bg-paper-3 text-ink" : "bg-inset hover:bg-inset-2",
                )}
              >
                <input type="radio" name="takeover-to" checked={pick === i} onChange={() => setPick(i)} className="sr-only" />
                <span
                  aria-hidden
                  className={cn("grid size-4 place-items-center rounded-full border", pick === i ? "border-ink" : "border-line-strong")}
                >
                  {pick === i && <span className="size-2 rounded-full bg-ink" />}
                </span>
                <span className="tabular-nums">{labelFor(h)}</span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="action" size="sm" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Taking over" : "Take over"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
