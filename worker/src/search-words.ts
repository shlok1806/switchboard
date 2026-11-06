// The words a search looks for (ADR 0043). A search matches any of its words, so the
// words of the question itself ("what", "the", "about") would match everything: they
// are dropped, unless they are all there is.

/** Words that say nothing about what is meant. */
export const QUESTION_WORDS: ReadonlySet<string> = new Set(
  "a an and are about as at be by do does for from how in is it of on or our say says the this to us we what when where which who why with".split(
    " ",
  ),
);

/** The words of `text` to search for, lowercased, without the question's own words. */
export function searchWords(text: string): string[] {
  const all = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const kept = all.filter((word) => !QUESTION_WORDS.has(word));
  return kept.length === 0 ? all : kept;
}
