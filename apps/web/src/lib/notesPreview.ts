/**
 * A step's notes as the one-line preview in its Inspector header (issue #241): the first line that
 * is not blank, cut at a word before `max` characters with an ellipsis, so the preview is never cut
 * off by its box. The whole of the notes is the preview's hover title, and a click opens them.
 */

/** The most characters the preview shows, the ellipsis included (SET BY HAND: what fits in 200 px of 13 px Plex). */
export const NOTES_PREVIEW_MAX = 28;

/** The first `count` characters of `text`, counting a surrogate pair as one so a cut never splits it. */
function cutAtCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

export function notesPreview(notes: string, max: number = NOTES_PREVIEW_MAX): string {
  const line = (notes.split("\n").find((candidate) => candidate.trim() !== "") ?? "").trim();
  if (line.length <= max) return line;
  const room = cutAtCodePoints(line, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = space > max / 2 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,.;:]+$/, "")}…`;
}
