/*
 * An Agent's live terminal (ADR 0021): its screen as the wrapper sends it, redacted on the
 * Person's machine, and typing into it with this browser's attach key. The Channel only
 * carries the keystrokes; the wrapper takes them once the Agent's Person has allowed the
 * key, so this panel shows the command that allows it.
 */
import type { Agent, TerminalInputOp, TerminalScreenFrame } from "@shared/index";
import { TERMINAL_INPUT_MAX } from "@shared/index";
import { type ClipboardEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { TerminalLink } from "@/data/source";
import { useChannel, useMe, useStore } from "@/data/store";
import { type AttachKey, attachKey, keyInput, nextSeq, pasteInput } from "@/lib/attach-key";
import { hostName } from "@/lib/format";
import { cn } from "@/lib/utils";

export function TerminalPanel({ agent }: { agent: Agent }) {
  const store = useStore();
  const me = useMe();
  const repo = useChannel().snapshot?.channel.repo;
  // Watching starts with the page: the Agent page is where a Person comes to watch.
  const [watching, setWatching] = useState(agent.presence !== "gone");
  const [taking, setTaking] = useState(false);
  const [screen, setScreen] = useState<TerminalScreenFrame | null>(null);
  const [typing, setTyping] = useState(false);
  const [key, setKey] = useState<AttachKey | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const link = useRef<TerminalLink | null>(null);
  const nonce = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** This page's own frames, by sequence number, with what each did: a refusal names it. */
  const sent = useRef(new Map<number, TerminalInputOp | undefined>());

  useEffect(() => {
    if (!watching) return;
    const l = store.source.terminal(agent.id, (frame) => {
      if (frame.type === "terminal.screen") {
        nonce.current = frame.nonce;
        setScreen(frame);
      } else if (sent.current.has(frame.seq)) {
        // Only this page's own keystrokes: another watcher's refusal is theirs.
        const op = sent.current.get(frame.seq);
        setRefused(`${op === "take" ? "Could not take the keyboard" : op === "release" ? "Not released" : "Not typed"}: ${frame.reason}`);
      }
    });
    link.current = l;
    return () => {
      l.close();
      link.current = null;
      setScreen(null);
    };
  }, [watching, store.source, agent.id]);

  useEffect(() => {
    if (!typing || key !== null) return;
    attachKey().then(setKey, (e: unknown) => setKeyError(e instanceof Error ? e.message : "This browser cannot keep a key."));
  }, [typing, key]);

  /** Sends signed frames one after another, so they leave in the order they were made. */
  const send = useCallback(
    (op: TerminalInputOp | undefined, text: string) => {
      if (key === null || repo === undefined) return;
      queue.current = queue.current
        .then(async () => {
          const n = nonce.current;
          if (n === null || link.current === null) return;
          const seq = nextSeq();
          const sig = await key.sign(repo, agent.id, n, seq, op, text);
          sent.current.set(seq, op);
          const frame = { agent: agent.id, key: key.spki, seq, ...(op === undefined ? {} : { op }), text, sig };
          if (link.current?.send(frame)) setRefused(null);
          else setRefused("Not sent: not connected to the Channel.");
        })
        // One frame that could not be signed must not stop the ones after it.
        .catch((e: unknown) => setRefused(`Not sent: ${e instanceof Error ? e.message : "this browser could not sign it."}`));
    },
    [key, repo, agent.id],
  );
  const type = useCallback(
    (text: string) => {
      for (let at = 0; at < text.length; at += TERMINAL_INPUT_MAX)
        send(undefined, text.slice(at, at + TERMINAL_INPUT_MAX));
    },
    [send],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLPreElement>) => {
    const text = keyInput(e);
    if (text === null) return;
    e.preventDefault();
    type(text);
  };
  const onPaste = (e: ClipboardEvent<HTMLPreElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text !== "") type(pasteInput(text, screen?.paste === true));
  };

  const owner = agent.person === me;
  const holder = screen?.holder ?? null;
  const mine = key !== null && holder?.key === key.fingerprint;
  const canType = typing && mine && repo !== undefined && screen !== null;
  const command = key && `switchboard attach allow ${key.fingerprint}${owner ? "" : ` --person ${me} --repo ${repo} --agent ${agent.id}`}`;

  // Take the keyboard as soon as this browser has its key: one click, as design.md asks.
  useEffect(() => {
    if (!taking || key === null || screen === null) return;
    setTaking(false);
    send("take", "");
  }, [taking, key, screen, send]);

  const take = () => {
    setTyping(true);
    setTaking(true);
  };
  const release = () => {
    send("release", "");
    setTyping(false);
  };
  const where = agent.host ? hostName(agent.host) : "terminal";
  const keyboard =
    holder === null ? "free" : mine ? "yours" : holder.key === null ? `${holder.person}, at the terminal` : `${holder.person}'s`;

  return (
    <section aria-label={`${agent.nickname ?? agent.id}'s terminal`} className="flex min-w-0 flex-col overflow-hidden rounded-[var(--r-2)] bg-term-bg text-term-fg">
      <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 border-b border-term-rule px-4 py-2 text-small text-term-dim">
        <h2 className="text-small font-medium text-term-fg">{where}</h2>
        {screen && (
          <span className="tabular-nums">
            {screen.cols}×{screen.rows}
          </span>
        )}
        {screen && (
          <span>
            Keyboard: <span className="font-medium text-term-fg">{keyboard}</span>
          </span>
        )}
        {screen?.prompt && <span className="text-term-signal">A dialog is open</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {watching && screen !== null && (mine ? <TermButton onClick={release}>Release the keyboard</TermButton> : <TermButton onClick={take}>Take the keyboard</TermButton>)}
          <TermButton quiet onClick={() => setWatching((w) => !w)} pressed={watching}>
            {watching ? "Stop watching" : "Watch"}
          </TermButton>
        </div>
      </div>
      {!watching ? (
        <p className="px-4 py-6 text-small text-term-dim">
          {agent.presence === "gone" ? "Gone. Its terminal shows again when it resumes." : "Not watching. Watch to see the screen its wrapper shows."}
        </p>
      ) : screen === null ? (
        <p className="px-4 py-6 text-small text-term-dim">{agent.presence === "gone" ? "Gone. Waiting for it to resume." : "Waiting for the wrapper's screen"}</p>
      ) : (
        <pre
          tabIndex={canType ? 0 : -1}
          aria-label="Screen"
          aria-readonly={!canType}
          onKeyDown={canType ? onKeyDown : undefined}
          onPaste={canType ? onPaste : undefined}
          className={cn(
            "min-h-[300px] overflow-x-auto p-4 font-mono text-small leading-[1.55] whitespace-pre text-term-fg focus-visible:-outline-offset-2" /* taste-skill-ignore: a terminal screen is literal text */,
            canType && "cursor-text",
          )}
        >
          <Screen frame={screen} />
        </pre>
      )}
      {typing && !mine && (keyError || key === null || command) && (
        <div className="flex flex-col gap-2 border-t border-term-rule px-4 py-3 text-small text-term-dim">
          {keyError ? (
            <p className="text-term-fg">{keyError}</p>
          ) : key === null ? (
            <p>Making this browser's key</p>
          ) : (
            <>
              <p>
                {owner
                  ? "The wrapper takes your keys once you allow this browser on the machine that runs it:"
                  : `${agent.person}'s wrapper takes your keys once they allow this browser on their machine:`}
              </p>
              <div className="flex min-w-0 items-start gap-2">
                <code className="min-w-0 flex-1 rounded-[var(--r)] bg-term-bg-2 px-2.5 py-1.5 [overflow-wrap:anywhere] text-term-fg">{command}</code>
                <TermButton onClick={() => void navigator.clipboard?.writeText(command ?? "")}>Copy</TermButton>
              </div>
            </>
          )}
        </div>
      )}
      {refused && <p className="border-t border-term-rule px-4 py-2 text-small text-term-fg">{refused}</p>}
      <p className="border-t border-term-rule px-4 py-2 text-small text-term-dim">
        Keys you type are signed with this browser's key, and {owner ? "your" : `${agent.person}'s`} wrapper takes them only once
        that key is allowed. Secrets on the screen are masked on {owner ? "your" : `${agent.person}'s`} machine before it leaves.
        {mine && " Others wait until you release the keyboard, or a minute passes without your keys."}
      </p>
    </section>
  );
}

/** A control on the terminal's dark header: outlined in the dim ink, or text only. */
function TermButton({ quiet = false, pressed, onClick, children }: { quiet?: boolean; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-[var(--r)] border px-2.5 text-small font-medium whitespace-nowrap transition-colors duration-[var(--dur)] active:translate-y-px",
        quiet ? "border-transparent text-term-dim hover:text-term-fg" : "border-term-dim text-term-fg hover:border-term-fg hover:bg-term-bg-2",
      )}
    >
      {children}
    </button>
  );
}

/** A tool call or its result, as Claude Code draws them: shown in the dim ink. */
const TOOL_LINE = /^\s*(?:[●⏺]\s*[\w.-]+\(|⎿|\s+⎿)/;
/** Where an open dialog starts: Claude Code's question or its numbered choices. */
const DIALOG_LINE = /^\s*(?:\?\s|Do you want|❯\s*\d)/; // taste-skill-ignore

/**
 * The screen's lines, tool lines dim and an open dialog in the signal colour (design.md),
 * with a block cursor where the wrapper says it is. The cursor does not blink.
 */
function Screen({ frame }: { frame: TerminalScreenFrame }) {
  let dialog = -1;
  if (frame.prompt) for (let y = frame.lines.length - 1; y >= 0; y--) if (DIALOG_LINE.test(frame.lines[y]!)) dialog = y;
  return frame.lines.map((line, y) => {
    const here = y === frame.cursor.y;
    const padded = here ? line.padEnd(frame.cursor.x + 1) : line;
    const tone = dialog >= 0 && y >= dialog ? "text-term-signal" : TOOL_LINE.test(line) ? "text-term-dim" : undefined;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: a screen row is its index
      <span key={y} className={cn("block min-h-[1.55em]", tone)}>
        {here ? (
          <>
            {padded.slice(0, frame.cursor.x)}
            <span className="bg-term-fg text-term-bg">{padded[frame.cursor.x]}</span>
            {padded.slice(frame.cursor.x + 1)}
          </>
        ) : (
          line
        )}
      </span>
    );
  });
}
