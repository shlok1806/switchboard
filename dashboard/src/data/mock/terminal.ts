// A simulated Agent terminal for the demo Channel (ADR 0021): a CLI screen that echoes
// what is typed into its prompt. It checks no signatures; the real wrapper does.

import type { AgentId, PendingApproval, TerminalInputFrame } from "@shared/index";
import { attachKeyFingerprint, fromBase64, TERMINAL_HOLD_IDLE_MS } from "@shared/index";
import type { TerminalFrame, TerminalLink } from "../source";

const COLS = 72;
const ROWS = 18;

/**
 * The demo screen of one Agent, as its wrapper would send it: tool calls as Claude Code
 * draws them, and its permission prompt at the bottom while one is open.
 */
export function mockTerminal(agent: AgentId, me: string, onFrame: (frame: TerminalFrame) => void, approval?: PendingApproval): TerminalLink {
  const history = [
    "● Read(web/src/users.tsx)",
    "  ⎿  Read 182 lines",
    "",
    "● Update(web/src/users.tsx)",
    "  ⎿  Updated with 12 additions and 3 removals",
    "",
    "● The list now pages by 50. Running the tests next.",
    "",
    "● Bash(npm test -- users)",
    "  ⎿  14 passed",
    "",
  ];
  const asking = approval
    ? [`? Run ${approval.detail ?? approval.tool}`, "  1. Yes   2. Yes, and don't ask again this session   3. No", ""]
    : [];
  let input = "";
  let typed = false;
  let closed = false;
  // Who holds the keyboard, as the wrapper keeps it: here, only the browser's own key.
  let holder: string | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const hold = (fingerprint: string | null) => {
    holder = fingerprint;
    clearTimeout(idle);
    if (fingerprint !== null)
      idle = setTimeout(() => {
        holder = null;
        send();
      }, TERMINAL_HOLD_IDLE_MS);
  };
  const send = () => {
    if (closed) return;
    const prompt = asking.length ? `  ${input}` : `> ${input}`;
    const tail = asking.length ? [...asking.slice(0, -1), prompt] : ["─".repeat(COLS), prompt];
    const body = history.slice(-(ROWS - tail.length - 1));
    const lines = [...body, ...tail];
    onFrame({
      type: "terminal.screen",
      agent,
      nonce: "mock",
      cols: COLS,
      rows: ROWS,
      lines: [...lines, ...Array(Math.max(0, ROWS - lines.length)).fill("")],
      cursor: { x: prompt.length, y: Math.min(ROWS, lines.length) - 1 },
      attached: typed ? [{ person: me, key: "MOCK" }] : [],
      prompt: asking.length > 0,
      paste: true,
      holder: holder === null ? null : { person: me, key: holder },
    });
  };
  const first = setTimeout(send, 300);
  return {
    send(frame: Omit<TerminalInputFrame, "type" | "from">) {
      if (closed) return false;
      // One after another, as the wrapper checks them.
      queue = queue.then(() => typedIn(frame));
      return true;
    },
    close() {
      closed = true;
      clearTimeout(first);
      clearTimeout(idle);
    },
  };

  async function typedIn(frame: Omit<TerminalInputFrame, "type" | "from">) {
    const spki = fromBase64(frame.key);
    const fingerprint = spki === null ? "" : await attachKeyFingerprint(spki);
    if (frame.op !== undefined) {
      hold(frame.op === "take" ? fingerprint : null);
      setTimeout(send, 30);
      return;
    }
    if (holder !== fingerprint) {
      onFrame({ type: "terminal.refused", agent, fingerprint, seq: frame.seq, reason: "take the keyboard first" });
      return;
    }
    hold(fingerprint);
    typed = true;
    // A bracketed paste is one piece of text: its line breaks do not submit it.
    const text = frame.text.replace(/\x1b\[200~([\s\S]*?)\x1b\[201~/g, (_m, pasted: string) =>
      pasted.replace(/\r/g, " "),
    );
    for (const ch of text) {
      if (ch === "\r") {
        if (input.trim() !== "") history.push(`> ${input}`, "", "  Understood.", "");
        input = "";
      } else if (ch === "\x7f") input = input.slice(0, -1);
      else if (ch >= " " && input.length < COLS - 4) input += ch;
    }
    setTimeout(send, 30);
  }
}
