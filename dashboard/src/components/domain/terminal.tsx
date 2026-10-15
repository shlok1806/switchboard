/*
 * An Agent's live terminal (ADR 0021): its screen as the wrapper sends it, redacted on the
 * Person's machine, and typing into it with this browser's attach key. The Channel only
 * carries the keystrokes; the wrapper takes them once the Agent's Person has allowed the
 * key, so this panel shows the command that allows it.
 */
import type { Agent, TerminalInputOp, TerminalScreenFrame } from "@shared/index";
import { TERMINAL_INPUT_MAX } from "@shared/index";
import { Keyboard, Monitor } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Snippet, SnippetCopyButton, SnippetHeader, SnippetTabsContent } from "@/components/kibo-ui/snippet";
import { Section } from "@/components/shell/section";
import type { TerminalLink } from "@/data/source";
import { useChannel, useMe, useStore } from "@/data/store";
import { type AttachKey, attachKey, keyInput, nextSeq, pasteInput } from "@/lib/attach-key";
import { cn } from "@/lib/utils";

export function TerminalPanel({ agent }: { agent: Agent }) {
  const store = useStore();
  const me = useMe();
  const repo = useChannel().snapshot?.channel.repo;
  const [watching, setWatching] = useState(false);
  const [screen, setScreen] = useState<TerminalScreenFrame | null>(null);
  const [typing, setTyping] = useState(false);
  const [key, setKey] = useState<AttachKey | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const link = useRef<TerminalLink | null>(null);
  const nonce = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const sent = useRef(new Set<number>());

  useEffect(() => {
    if (!watching) return;
    const l = store.source.terminal(agent.id, (frame) => {
      if (frame.type === "terminal.screen") {
        nonce.current = frame.nonce;
        setScreen(frame);
      } else if (sent.current.has(frame.seq)) {
        // Only this page's own keystrokes: another watcher's refusal is theirs.
        setRefused(frame.reason);
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
      queue.current = queue.current.then(async () => {
        const n = nonce.current;
        if (n === null || link.current === null) return;
        const seq = nextSeq();
        const sig = await key.sign(repo, agent.id, n, seq, op, text);
        sent.current.add(seq);
        const frame = { agent: agent.id, key: key.spki, seq, ...(op === undefined ? {} : { op }), text, sig };
        if (link.current?.send(frame)) setRefused(null);
        else setRefused("Not connected to the Channel.");
      });
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
  const stopTyping = () => {
    if (mine) send("release", "");
    setTyping(false);
  };
  const command = key && `switchboard attach allow ${key.fingerprint}${owner ? "" : ` --person ${me} --repo ${repo} --agent ${agent.id}`}`;

  return (
    <Section
      title="Terminal"
      action={
        <Button size="xs" variant="ghost" onClick={() => setWatching((w) => !w)} aria-pressed={watching}>
          <Monitor className="size-3.5" aria-hidden />
          {watching ? "Stop watching" : "Watch"}
        </Button>
      }
      bodyClassName="flex flex-col gap-3"
    >
      {!watching ? (
        <p className="text-small text-ink-3">
          {agent.presence === "gone"
            ? "Gone. Its terminal shows again when it resumes."
            : `The screen ${agent.person}'s wrapper shows, with secrets masked before it leaves their machine.`}
        </p>
      ) : (
        <>
          <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">
            {screen === null ? (
              <span>{agent.presence === "gone" ? "Gone. Waiting for it to resume." : "Waiting for the wrapper's screen"}</span>
            ) : (
              <>
                <span className="tabular-nums">
                  {screen.cols} × {screen.rows}
                </span>
                {screen.prompt && (
                  <span className="rounded-sm bg-orange-tint px-1.5 text-orange">Waiting on a dialog</span>
                )}
                <span>
                  {holder === null
                    ? "Keyboard free"
                    : mine
                      ? "You hold the keyboard"
                      : holder.key === null
                        ? `${holder.person} holds the keyboard, at the terminal`
                        : `${holder.person} holds the keyboard`}
                </span>
              </>
            )}
          </div>
          {screen !== null && (
            <pre
              tabIndex={canType ? 0 : -1}
              aria-label={`${agent.nickname ?? agent.id}'s terminal`}
              aria-readonly={!canType}
              onKeyDown={canType ? onKeyDown : undefined}
              onPaste={canType ? onPaste : undefined}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className={cn(
                "overflow-x-auto rounded-md bg-page p-3 font-mono text-small leading-[1.45] whitespace-pre text-ink-2" /* taste-skill-ignore: a terminal screen is literal text */,
                canType && "cursor-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              )}
            >
              <Screen frame={screen} cursor={canType && focused} />
            </pre>
          )}
          {!typing ? (
            <Button size="sm" className="self-start" onClick={() => setTyping(true)} disabled={screen === null}>
              <Keyboard className="size-3.5" aria-hidden />
              Type into it
            </Button>
          ) : keyError ? (
            <p className="text-small text-red">{keyError}</p>
          ) : key === null ? (
            <p className="text-small text-ink-3">Making this browser's key</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-small text-ink-2">
                {owner
                  ? "Take the keyboard, then click the screen and type. The wrapper takes your keys once you allow this browser on the machine that runs it:"
                  : `Take the keyboard, then click the screen and type. ${agent.person}'s wrapper takes your keys once they allow this browser on their machine:`}
              </p>
              <Snippet defaultValue="allow" className="bg-page">
                <SnippetHeader>
                  <span className="text-small font-medium">Key {key.fingerprint}</span>
                  <SnippetCopyButton value={command ?? ""} aria-label="Copy command" />
                </SnippetHeader>
                <SnippetTabsContent value="allow">{command}</SnippetTabsContent>
              </Snippet>
              {refused && <p className="text-small text-orange">Not typed: {refused}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {mine ? (
                  <Button size="sm" variant="secondary" className="bg-page" onClick={() => send("release", "")}>
                    Release the keyboard
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => send("take", "")}>
                    <Keyboard className="size-3.5" aria-hidden />
                    Take the keyboard
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={stopTyping}>
                  Stop typing
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** The screen's lines, with the cursor drawn where the wrapper says it is. */
function Screen({ frame, cursor }: { frame: TerminalScreenFrame; cursor: boolean }) {
  return frame.lines.map((line, y) => {
    const here = cursor && y === frame.cursor.y;
    const padded = here ? line.padEnd(frame.cursor.x + 1) : line;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: a screen row is its index
      <span key={y} className="block min-h-[1.45em]">
        {here ? (
          <>
            {padded.slice(0, frame.cursor.x)}
            <span className="bg-ink text-page">{padded[frame.cursor.x]}</span>
            {padded.slice(frame.cursor.x + 1)}
          </>
        ) : (
          line
        )}
      </span>
    );
  });
}
