import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Agent } from "@shared/index";
import { MAX_NICKNAME_LENGTH } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStore } from "@/data/store";

/**
 * Renames the Agent while it runs (ADR 0009). Anyone on the Channel may; the Agent ID
 * never changes, and the rename shows in the history as old → new. Closed, it gives focus
 * back to `returnFocusTo` (a menu's button, when a menu item opened it), or else to what had
 * focus when it opened: a Radix dialog would give it to its Trigger, and this one has none.
 */
export function RenameDialog({
  agent,
  open,
  onOpenChange,
  returnFocusTo,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(agent.nickname ?? "");
  const [busy, setBusy] = useState(false);
  // Opened again, or someone else renamed it meanwhile: start from the Channel's name.
  useEffect(() => setName(agent.nickname ?? ""), [agent.nickname, open]);
  const changed = name.trim() !== (agent.nickname ?? "");

  const save = async (nickname: string | null) => {
    setBusy(true);
    const r = await store.source.act({ type: "rename", agent: agent.id, nickname });
    setBusy(false);
    if (!r.ok) return toast.error(r.reason);
    onOpenChange(false);
    toast.success(nickname ? `${agent.id} is now ${nickname.trim()}` : `${agent.id} has no Nickname now`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          opener.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
          e.preventDefault();
          input.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
          opener.current = null;
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void save(name.trim() || null);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Rename {agent.nickname ?? agent.id}</DialogTitle>
            <DialogDescription>Anyone on the Channel can rename an Agent while it runs. Its Agent ID never changes, and Nicknames are unique.</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5">
            <span className="text-small text-ink-3">Nickname</span>
            <input
              ref={input}
              placeholder="api-client"
              maxLength={MAX_NICKNAME_LENGTH}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-[30px] rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:text-[16px]"
            />
          </label>
          <DialogFooter>
            {agent.nickname && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)} className="sm:mr-auto">
                Clear the Nickname
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!changed || busy}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
