import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Agent, AgentId, Task } from "@shared/index";
import { Bot, ChevronDown, UserRound } from "lucide-react";
import { Button } from "@/components/atoms/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCapabilities, useChannel, useMe, useStore } from "@/data/store";
import { holderName } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Claiming and releasing from the Dashboard (#9, spec story 22). A Person claims
 * a Task for themselves, or for one of their own Agents that is not Gone, so a
 * specific session picks up specific work. Every answer, and every refusal the
 * Channel gives (a Claim already held, a Stale Claim), comes back as one toast.
 */
export function useClaims() {
  const store = useStore();
  const me = useMe();
  const { agents } = useChannel();
  // The Agents a Person can point at work: their own, Live or Idle.
  const mine = agents.filter((a) => a.person === me && a.presence !== "gone");

  const claim = async (task: Task, forAgent?: AgentId): Promise<boolean> => {
    const result = await store.source.claim(task.number, forAgent);
    if (result.ok) {
      store.applyTask(result.task);
      toast.success(`Claimed #${task.number}`, {
        description: `Held by ${forAgent ?? me}. Mirrored to GitHub as an assignee.`,
      });
      return true;
    }
    toast.error(`Could not claim #${task.number}`, { description: refusal(result) });
    return false;
  };

  const release = async (task: Task): Promise<boolean> => {
    const result = await store.source.release(task.number);
    if (result.ok) {
      store.applyTask(result.task);
      toast.success(`Released #${task.number}`, { description: "It is Open again." });
      return true;
    }
    toast.error(`Could not release #${task.number}`, { description: refusal(result) });
    return false;
  };

  return { me, mine, claim, release };
}

/** The Channel's reason already names the holder; say it only when it does not. */
function refusal(result: { reason: string; heldBy?: Parameters<typeof holderName>[0] }): string {
  return result.heldBy && !result.reason.includes(holderName(result.heldBy))
    ? `${result.reason} Held by ${holderName(result.heldBy)}.`
    : result.reason;
}

/** True when a Person can claim this Task from the Dashboard right now. */
export function claimable(task: Task): boolean {
  return !task.claim && task.status !== "done";
}

/** One of the Person's own Agents in a menu: its Agent ID, with its Presence as a dot. */
function AgentOption({ agent }: { agent: Agent }) {
  return (
    <>
      <Bot className="size-4 text-ink-3" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{agent.id}</span>
      <span
        aria-label={agent.presence === "live" ? "Live" : "Idle"}
        role="img"
        className={cn("size-1.5 shrink-0 rounded-full", agent.presence === "live" ? "bg-green" : "bg-orange")}
      />
    </>
  );
}

/** The menu item that claims for the Person using the Dashboard. */
export function ClaimForMeItem({ me, onPick }: { me: string; onPick: () => void }) {
  return (
    <DropdownMenuItem onSelect={onPick} className="min-h-9">
      <UserRound className="size-4 text-ink-3" aria-hidden />
      <span className="flex-1">Me</span>
      <span className="text-[12.5px] text-ink-3">{me}</span>
    </DropdownMenuItem>
  );
}

/** Menu items that claim for one of the Person's own Agents. */
export function ClaimForAgentItems({ agents, onPick }: { agents: Agent[]; onPick: (agent: AgentId) => void }) {
  return agents.map((a) => (
    <DropdownMenuItem key={a.id} onSelect={() => onPick(a.id)} className="min-h-9">
      <AgentOption agent={a} />
    </DropdownMenuItem>
  ));
}

/**
 * Task detail's Claim action: one button claims for the Person, and the arrow
 * beside it picks one of their own Agents instead. Without Agents it is one button.
 */
export function ClaimAction({ task }: { task: Task }) {
  const can = useCapabilities();
  const { me, mine, claim } = useClaims();
  const [busy, setBusy] = useState(false);
  if (!can.claims || !claimable(task)) return null;

  const run = async (forAgent?: AgentId) => {
    setBusy(true);
    await claim(task, forAgent);
    setBusy(false);
  };

  return (
    <div className="flex w-full items-stretch">
      <Button
        variant="accent"
        size="sm"
        className={cn("flex-1", mine.length > 0 && "rounded-r-none")}
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? "Claiming" : "Claim"}
      </Button>
      {mine.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="accent"
              size="sm"
              aria-label="Claim for one of your Agents"
              className="rounded-l-none border-l border-on-accent/25 px-2"
              disabled={busy}
            >
              <ChevronDown className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
            <ClaimForLabel />
            <ClaimForMeItem me={me} onPick={() => void run()} />
            <ClaimForAgentItems agents={mine} onPick={(id) => void run(id)} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function ClaimForLabel({ children = "Claim for" }: { children?: ReactNode }) {
  return <DropdownMenuLabel className="text-[12px] font-normal text-ink-3">{children}</DropdownMenuLabel>;
}
