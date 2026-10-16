/*
 * Activity's composer: post an Update everyone reads, or send one Agent a Directive. A
 * Directive is labelled as from you and is the only message an Agent treats as instruction;
 * the label over the field says which of the two this is and who hears it.
 */
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AgentId } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { shortName } from "@/components/domain/fleet";
import { useCapabilities, useChannel, useStore } from "@/data/store";

type Mode = "update" | "directive";

const FIELD =
  "h-[30px] min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-3 hover:bg-paper-2 max-sm:text-[16px]";

export function Composer({ task }: { task?: number }) {
  const store = useStore();
  const { agents } = useChannel();
  const can = useCapabilities();
  const [mode, setMode] = useState<Mode>("update");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const reachable = agents.filter((a) => a.presence !== "gone");
  const [picked, setTo] = useState<AgentId | "">("");
  // Agents arrive after the first render, so an unpicked target follows the first reachable one.
  const to = picked && reachable.some((a) => a.id === picked) ? picked : (reachable[0]?.id ?? "");
  const directive = mode === "directive" && can.directives;
  const target = reachable.find((a) => a.id === to);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    if (directive && !to) return void toast.error("No Agent is on the Channel to send a Directive to.");
    setBusy(true);
    const r = directive ? await store.source.act({ type: "directive", to, text: said }) : await store.source.act({ type: "update", text: said, task });
    setBusy(false);
    if (!r.ok) return void toast.error(r.reason);
    setText("");
    toast.success(directive ? `Directive sent to ${target ? `${target.person}/${shortName(target)}` : to}` : "Update posted");
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {can.directives && (
        <div role="group" aria-label="Say it as" className="flex gap-1.5">
          <Chip on={mode === "update"} onClick={() => setMode("update")}>
            Update
          </Chip>
          <Chip on={mode === "directive"} onClick={() => setMode("directive")}>
            Directive
          </Chip>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1 text-small text-ink-3">
          {directive ? "Directive: labelled as from you, read at the start of its next turn" : "Update: everyone reads it, and Agents hear it when the Relay says so"}
          <input
            // Activity's empty state focuses the Channel's composer by this ID.
            id={task === undefined ? "composer-text" : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={directive ? "Run the tests before pushing." : "Paging lands in users.tsx next."}
            className={FIELD}
          />
        </label>
        {directive && (
          <label className="flex min-w-0 flex-col gap-1 text-small text-ink-3">
            To
            <select value={to} onChange={(e) => setTo(e.target.value as AgentId)} className={`${FIELD} pr-7`}>
              {reachable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.person}/{shortName(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>
          {directive ? "Send" : "Post"}
        </Button>
      </div>
    </form>
  );
}
