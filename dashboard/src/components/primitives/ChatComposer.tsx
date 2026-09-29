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

  return (
    <div className={`flex w-full flex-col overflow-hidden rounded-[10px] bg-surface shadow-card ${className}`}>
      {/* header - tabs + actions */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line p-1.5">
        <div className="flex items-center" role="tablist">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              onClick={() => onTabChange(item)}
              className={`rounded-[6px] px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100 ${tab === item ? "bg-field" : "opacity-60 hover:opacity-85"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1">{aside}</div>
      </div>

      {/* composer */}
      <div className="shrink-0 p-1.5">
        <div
          role="presentation"
          onClick={() => inputRef.current?.focus()}
          className="flex cursor-text flex-col gap-2 rounded-control border border-line bg-field p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.025)]"
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
            className="min-h-9 resize-none bg-transparent text-[13px] leading-[1.4] text-ink outline-none placeholder:text-ink-3"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[11.5px] text-ink-3">{footer}</div>
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={() => void send()}
              className="flex size-7 shrink-0 items-center justify-center rounded-[8px]
                transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]"
              style={{
                background: canSend ? "var(--ink)" : "var(--line-strong)",
                color: canSend ? "var(--surface)" : "var(--ink-2)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
