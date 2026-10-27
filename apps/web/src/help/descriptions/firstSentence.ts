/**
 * The first sentence of a robot.json summary (UI_GUIDE sections 9.10 and 9.13, decision
 * robot-summaries). The author writes what the robot does first and notes for programmers after it,
 * so a list that has room for one sentence shows this and leaves the whole summary to the hint.
 *
 * The cut is at the first full stop, question mark or exclamation mark that is followed by a space
 * or the end of the text, with any closing quotes or brackets after it kept. A full stop that ends
 * "e.g.", "i.e." or "vs." never ends a sentence. One that ends "etc." or "approx." ends it only when
 * the next word starts with a capital letter, since both can close a sentence. The sentence keeps its
 * own end mark, and nothing is added: a cut at a sentence end is not an ellipsis. A summary of one
 * sentence comes back whole, and a decimal such as 0.5 never ends one.
 */

/** Abbreviations whose full stop never ends a sentence. */
const ABBREVIATION = /\b(?:e\.g|i\.e|vs)\.$/i;
/** Abbreviations that end a sentence only when a capitalised word follows them. */
const CLOSING_ABBREVIATION = /\b(?:etc|approx)\.$/i;
/** An end mark, then any closing quotes or brackets, then a space or the end of the text. */
const SENTENCE_END = /[.!?]+["'”’)\]]*(?=\s|$)/g;

export function firstSentence(summary: string): string {
  const text = summary.trim().replace(/\s+/g, " ");
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end >= text.length) return text;
    const sentence = text.slice(0, end);
    if (ABBREVIATION.test(sentence)) continue;
    if (CLOSING_ABBREVIATION.test(sentence) && !/^\s\p{Lu}/u.test(text.slice(end))) continue;
    return sentence;
  }
  return text;
}
