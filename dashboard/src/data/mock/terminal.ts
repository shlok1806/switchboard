// A simulated Agent terminal for the demo Channel (ADR 0021): a CLI screen that echoes
// what is typed into its prompt. It checks no signatures; the real wrapper does.

import type { AgentId, TerminalInputFrame } from "@shared/index";
import type { TerminalFrame, TerminalLink } from "../source";

const COLS = 72;
const ROWS = 14;

/** The demo screen of one Agent, as its wrapper would send it. */
export function mockTerminal(agent: AgentId, me: string, onFrame: (frame: TerminalFrame) => void): TerminalLink {
  const history = [
    "  Read web/src/users.tsx",
    "  Edit web/src/users.tsx  +12 -3",
    "",
    "  The list now pages by 50. Running the tests next.",
    "",
    "  Bash npm test -- users",
    "  ✓ 14 passed", // taste-skill-ignore: a test runner's own check mark, as the CLI prints it
    "",
  ];
  let input = "";
  let typed = false;
  let closed = false;
  const send = () => {
    if (closed) return;
    const prompt = `> ${input}`;
    const body = history.slice(-(ROWS - 3));
    const lines = [...body, "", "─".repeat(COLS), prompt];
    onFrame({
      type: "terminal.screen",
      agent,
      nonce: "mock",
      cols: COLS,
      rows: ROWS,
      lines: [...lines, ...Array(Math.max(0, ROWS - lines.length)).fill("")],
      cursor: { x: prompt.length, y: Math.min(ROWS, lines.length) - 1 },
      attached: typed ? [{ person: me, key: "MOCK" }] : [],
      prompt: false,
    });
  };
  const first = setTimeout(send, 300);
  return {
    send(frame: Omit<TerminalInputFrame, "type" | "from">) {
      if (closed) return false;
      typed = true;
      for (const ch of frame.text) {
        if (ch === "\r") {
          if (input.trim() !== "") history.push(`> ${input}`, "", "  Understood.", "");
          input = "";
        } else if (ch === "\x7f") input = input.slice(0, -1);
        else if (ch >= " " && input.length < COLS - 4) input += ch;
      }
      setTimeout(send, 30);
      return true;
    },
    close() {
      closed = true;
      clearTimeout(first);
    },
  };
}
