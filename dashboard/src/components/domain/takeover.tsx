import { useState } from "react";
import { toast } from "sonner";
import type { Holder, Task } from "@shared/index";
import ApprovalCard from "@/components/primitives/ApprovalCard";
import { Button } from "@/components/atoms/Button";
import { useCapabilities, useChannel, useMe, useStore } from "@/data/store";
import { holderName } from "@/lib/format";

/**
 * Take over a Stale Claim: pick the new holder (yourself or one of your Agents).
 * Only offered when the holder is Gone (ADR 0002). Confirmed in Beautiful UI's ApprovalCard.
 */
export function TakeoverAction({ task, compact = false }: { task: Task; compact?: boolean }) {
  const store = useStore();
  const me = useMe();
  const { agents } = useChannel();
  const [open, setOpen] = useState(false);
  const can = useCapabilities();
  if (!task.claim?.stale || !can.takeover) return null;

  const options: Holder[] = [
    { kind: "person", person: me },
    ...agents
      .filter((a) => a.person === me && a.presence !== "gone")
      .map((a): Holder => ({ kind: "agent", agentId: a.id })),
  ];
  const labelFor = (h: Holder) => (h.kind === "person" ? `Me (${h.person})` : holderName(h));

  if (!open) {
    return (
      <Button
        variant="accent"
        size={compact ? "xs" : "sm"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        Take over
      </Button>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()} className="w-full">
      <ApprovalCard
        className="w-full"
        autoAdvance={false}
        allowCustom={false}
        resettable={false}
        onDismiss={() => setOpen(false)}
        questions={[
          {
            q: `Give #${task.number} to`,
            type: "radio",
            options: options.map(labelFor),
          },
        ]}
        labels={{ send: "Take over", skip: "Cancel", sentMessage: `Took over #${task.number}` }}
        onSubmitted={async (answers) => {
          const pick = answers[0]?.[0];
          if (pick === undefined) return;
          const to = options[pick];
          const result = await store.source.act({ type: "takeover", task: task.number, to });
          if (result.ok) toast.success(`#${task.number} is now held by ${holderName(to)}`);
          else toast.error(result.reason);
        }}
      />
    </div>
  );
}
