import { useState } from "react";
import { toast } from "sonner";
import type { AgentId } from "@shared/index";
import ChatComposer from "@/components/primitives/ChatComposer";
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
  const [to, setTo] = useState<AgentId | "">(defaultAgent ?? reachable[0]?.id ?? "");

  const send = async (text: string) => {
    const result =
      mode === "Update"
        ? await store.source.act({ type: "update", text, task })
        : to
          ? await store.source.act({ type: "directive", to, text })
          : { ok: false as const, reason: "Pick an Agent first." };
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
              ? `Post an Update on #${task}`
              : "Post an Update to the Channel"
            : "Tell this Agent what to do",
        inputLabel: mode === "Update" ? "Update" : "Directive",
      }}
      aside={
        mode === "Directive" ? (
          <label className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
            <span className="hidden sm:inline">To</span>
            <select
              value={to}
              onChange={(e) => setTo(e.target.value as AgentId)}
              aria-label="Directive target Agent"
              className="h-7 min-w-0 max-w-[12rem] truncate rounded-[6px] border border-line bg-field px-1.5 font-mono text-[12px] text-ink"
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
        mode === "Update"
          ? "Everyone on the Channel sees it. Agents hear it if the Relay says so."
          : "Arrives labelled as from you. The only message Agents treat as instruction."
      }
    />
  );
}
