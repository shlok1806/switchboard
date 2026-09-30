"use client";

import { useRef, useState, type ReactNode } from "react";

/* Switchboard: adapted from Beautiful UI ChatComposer (MIT, Shane Levine).
 * Kept: the tab header, the field shell and the send button, class for class.
 * Changed: the scripted reply thread is removed; tabs switch the composer mode,
 * a slot sits beside the tabs (the Directive target), and sending is async.
 * ─────────────────────────────────────────────────────────
 * CHAT - interactive panel with tabs, replies, and composer.
 * ───────────────────────────────────────────────────────── */

export type ChatComposerLabels = {
  /** composer input placeholder */
  placeholder: string;
  /** accessible name of the input */
  inputLabel: string;
};

const DEFAULT_LABELS: ChatComposerLabels = {
  placeholder: "Write a message",
  inputLabel: "Message",
};

export default function ChatComposer<T extends string>({
  tabs,
  tab,
  onTabChange,
  labels,
  onSend,
  aside,
  footer,
  className = "",
}: {
  /** header chips (tabs) for switching mode */
  tabs: readonly T[];
  tab: T;
  onTabChange: (tab: T) => void;
  /** prominent copy strings */
  labels?: Partial<ChatComposerLabels>;
  /** fired with the trimmed text. Resolve true to clear the field. */
  onSend: (text: string) => Promise<boolean>;
  /** content on the right side of the header */
  aside?: ReactNode;
  /** a line under the field, such as who will see it */
  footer?: ReactNode;
  className?: string;
}) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const canSend = draft.trim().length > 0 && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    const ok = await onSend(draft.trim());
    setBusy(false);
    if (ok) setDraft("");
    inputRef.current?.focus();
  };

  // Switchboard: re-skinned as a Motif form. The tabs are a radio box of push
  // buttons, the field is inset, and Send is a default push button.
  return (
    <div className={`flex w-full flex-col bg-secondary text-secondary-foreground ${className}`}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-1 pt-1 pb-1.5">
        <div className="flex items-center gap-[2px]" role="tablist">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-pressed={tab === item}
              onClick={() => onTabChange(item)}
              className={`btn-motif h-[24px] px-2.5 text-[12px] coarse:h-9 ${tab === item ? "bg-muted font-bold" : ""}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1">{aside}</div>
      </div>

      <div
        role="presentation"
        onClick={() => inputRef.current?.focus()}
        className="bevel-in mx-1 flex cursor-text flex-col gap-1 bg-card px-2 py-1.5 text-card-foreground"
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={l.placeholder}
          aria-label={l.inputLabel}
          className="min-h-9 resize-none bg-transparent font-mono text-[13px] leading-[1.45] outline-none placeholder:text-faint coarse:text-[16px]"
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-1 pt-1.5 pb-1">
        <div className="min-w-0 text-[11.5px] leading-snug text-muted-foreground">{footer}</div>
        <button
          type="button"
          aria-label="Send"
          disabled={!canSend}
          onClick={() => void send()}
          className="btn-motif h-[26px] shrink-0 px-3 font-semibold outline outline-1 outline-[hsl(var(--foreground))] disabled:outline-[hsl(var(--faint))] coarse:h-10"
        >
          Send
        </button>
      </div>
    </div>
  );
}
