"use client";

import { useRef, useState, type ReactNode } from "react";

/* Switchboard: adapted from Beautiful UI ChatComposer (MIT, Shane Levine).
 * Kept: the mode tabs, the field shell and the round send button.
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

  // Switchboard: one rounded field. The mode tabs and the aside sit in its bottom row, beside Send.
  return (
    <div className={`w-full ${className}`}>
      <div
        role="presentation"
        onClick={() => inputRef.current?.focus()}
        className="flex cursor-text flex-col gap-1.5 rounded-xl border border-line bg-field p-2 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong"
      >
        {aside && <div className="flex min-w-0 items-center gap-1 px-1.5 pt-0.5">{aside}</div>}
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
          className="min-h-10 resize-none bg-transparent px-1.5 pt-1 text-[14px] leading-[1.45] text-ink outline-none placeholder:text-ink-4 max-md:text-[16px]"
        />
        <div className="flex items-center gap-2">
          {tabs.length > 1 && (
            <div className="flex shrink-0 items-center rounded-lg bg-hover p-0.5" role="tablist">
              {tabs.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabChange(item);
                  }}
                  className={`h-7 rounded-md px-2.5 text-[12.5px] transition-colors ${tab === item ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-3 hover:text-ink-2"}`}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {footer}
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={(e) => {
                e.stopPropagation();
                void send();
              }}
              className="grid size-8 shrink-0 place-items-center rounded-lg transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96] enabled:bg-accent enabled:text-on-accent disabled:bg-hover-2 disabled:text-ink-4"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
