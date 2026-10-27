/**
 * What the palette's search matches (QA-02): the label, the group, and the action's keywords, so
 * "tour" finds "Take the full tour" and "copy" finds "Duplicate step". Case does not matter.
 *
 * It also says how well an entry matches (`matchTier`), because the palette orders results by that
 * before it orders them by group, and never starts on a match made only by a command's summary: typing
 * "start" must not make "Insert spinUp" (whose summary says "starts sooner") the row Enter runs
 * (issue #410).
 */
export interface Searchable {
  label: string;
  group: string;
  keywords?: readonly string[];
  /** A robot command's summary: matched last, and never the first active row. */
  summary?: string;
}

/**
 * How well an entry matches, best first: 0 the whole label, 1 the start of the label, 2 the start of
 * a word in it, 3 anywhere in it, 4 its group or a keyword, 5 only its summary.
 */
export type MatchTier = 0 | 1 | 2 | 3 | 4 | 5;

/** The first tier that is only a summary's match: such a row is never the first active one. */
export const SUMMARY_ONLY_TIER: MatchTier = 5;

const WORD_CHARS = /[a-z0-9]/;

/** Whether `want` starts a word of `text`: after the start, a space, or any other non-alphanumeric. */
function startsAWord(text: string, want: string): boolean {
  let from = text.indexOf(want);
  while (from >= 0) {
    if (from === 0 || !WORD_CHARS.test(text.charAt(from - 1))) return true;
    from = text.indexOf(want, from + 1);
  }
  return false;
}

/** The entry's tier for `needle`, or null when it does not match at all. An empty needle matches everything. */
export function matchTier(entry: Searchable, needle: string): MatchTier | null {
  const want = needle.trim().toLowerCase();
  if (want === "") return 0;
  const label = entry.label.toLowerCase();
  if (label === want) return 0;
  if (label.startsWith(want)) return 1;
  if (startsAWord(label, want)) return 2;
  if (label.includes(want)) return 3;
  if (entry.group.toLowerCase().includes(want) || (entry.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(want))) return 4;
  if (entry.summary !== undefined && entry.summary.toLowerCase().includes(want)) return SUMMARY_ONLY_TIER;
  return null;
}

export function matchesQuery(entry: Searchable, needle: string): boolean {
  return matchTier(entry, needle) !== null;
}

/** What the palette's keyboard needs to know of a row. */
export interface NavRow {
  tier: MatchTier;
  disabled?: boolean;
}

/**
 * The row Enter acts on when the person has not moved yet: the first one that is not a summary-only
 * match, or -1 when there is none, so Enter then does nothing rather than something the person did
 * not ask for. It is the first row even when that row cannot run: Enter then says why and runs
 * nothing, rather than running a row further down that the person may not have read (UX review, S18).
 */
export function firstActive(rows: readonly NavRow[]): number {
  return rows.findIndex((row) => row.tier < SUMMARY_ONLY_TIER);
}

/** The next row that can run in the direction of an arrow key, skipping any that cannot; `from` when none is left. */
export function stepActive(rows: readonly NavRow[], from: number, direction: 1 | -1): number {
  for (let at = from + direction; at >= 0 && at < rows.length; at += direction) {
    if (rows[at]?.disabled !== true) return at;
  }
  return from;
}
