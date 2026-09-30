import { useState } from "react";
import { toast } from "sonner";
import type { AgentId } from "@shared/index";
import { Info } from "lucide-react";
import ChatComposer from "@/components/primitives/ChatComposer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCapabilities, useChannel, useStore } from "@/data/store";

const MODES = ["Update", "Directive"] as const;
type Mode = (typeof MODES)[number];
const UPDATE_ONLY = ["Update"] as const;

/**
 * Post an Update to everyone, or send a Directive to one Agent.
 * A Directive is labelled as coming from you and is the only message with instruction weight.
 */
export function Composer({ defaultAgent, task, className }: { defaultAgent?: AgentId; task?: number; className?: string }) {
  const store = useStore();
  const { agents } = useChannel();
  const can = useCapabilities();
  const [mode, setMode] = useState<Mode>(defaultAgent && can.directives ? "Directive" : "Update");
  const reachable = agents.filter((a) => a.presence !== "gone");
  const [picked, setTo] = useState<AgentId | "">(defaultAgent ?? "");
  // Agents arrive after the first render, so an unpicked target follows the first reachable one.
  const to = picked && reachable.some((a) => a.id === picked) ? picked : (reachable[0]?.id ?? "");

  const send = async (text: string) => {
    const result =
      mode === "Update"
        ? await store.source.act({ type: "update", text, task })
        : to
          ? await store.source.act({ type: "directive", to, text })
          : { ok: false as const, reason: "No Agent is on the Channel to send a Directive to." };
    if (!result.ok) {
      toast.error(result.reason);
      return false;
    }
    toast.success(mode === "Update" ? "Update posted" : `Directive sent to ${to}`);
    return true;
  };

  return (
    <ChatComposer
      className={className}
      tabs={can.directives ? MODES : UPDATE_ONLY}
      tab={mode}
      onTabChange={setMode}
      onSend={send}
      labels={{
        placeholder:
          mode === "Update"
            ? task
              ? `Update on #${task}`
              : "Post an Update"
            : "Tell this Agent what to do",
        inputLabel: mode === "Update" ? "Update" : "Directive",
      }}
      aside={
        mode === "Directive" ? (
          <label className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3" onClick={(e) => e.stopPropagation()}>
            To
            <select
              value={to}
              onChange={(e) => setTo(e.target.value as AgentId)}
              aria-label="Directive target Agent"
              className="h-7 max-w-full min-w-0 truncate rounded-md border border-line bg-surface px-1.5 font-mono text-[12.5px] text-ink"
            >
              {reachable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
      footer={
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-grid size-7 place-items-center rounded-md text-ink-4 hover:text-ink-2" aria-label="Who hears this">
              <Info className="size-4" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {mode === "Update"
              ? "Everyone sees it. Agents hear it if the Relay says so."
              : "Labelled as from you. The only message Agents treat as instruction."}
          </TooltipContent>
        </Tooltip>
      }
    />
  );
}
