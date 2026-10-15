// Terminal escape sequences, removed whole. Removing only their ESC byte leaves `[31m`
// glued to the text after it, which hides a secret from the masking that looks for a
// word start before it, and still shows a reader the sequence's body.

/** One terminal escape sequence, of any kind, as a regular expression source. */
export const ESCAPE_SEQUENCE = [
  // CSI, 7-bit (ESC [) or 8-bit: parameters, intermediates, one final byte. Colours, cursor moves.
  "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
  // OSC (titles, hyperlinks, OSC 52 clipboard writes), and the DCS, SOS, PM and APC
  // strings: up to BEL or ST, or to the end when unterminated.
  "(?:\\x1b[\\]PX^_]|[\\x9d\\x90\\x98\\x9e\\x9f])[\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)",
  // Character set designations: ESC ( B and the like.
  "\\x1b[()*+\\-./][\\x20-\\x7e]",
  // Every other two-byte escape: ESC 7, ESC =, ESC c.
  "\\x1b[\\x20-\\x7e]",
].join("|");

const SEQUENCES = new RegExp(ESCAPE_SEQUENCE, "g");

/** `raw` without its terminal escape sequences, each removed whole. */
export function stripEscapes(raw: string): string {
  return raw.replace(SEQUENCES, "");
}
