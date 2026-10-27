/**
 * The description table (issue #238, UI_GUIDE section 9.13): the words that explain a row, moved
 * out of the components into one place the tests lint. It is split by surface, `inspector.ts`,
 * `insert.ts` and `settings.ts`, so the lanes that fill it never touch the same lines.
 *
 * A row always shows its label. Its brief is drawn inline only when the Descriptions option is
 * "With descriptions" (`prefs.descriptions` is "full"). Its hint, which a long hover or Shift F1
 * opens and which is always its control's `aria-describedby`, is the brief and the more together,
 * in both modes.
 */
import { INSERT_DESCRIPTIONS } from "./insert";
import { INSPECTOR_DESCRIPTIONS } from "./inspector";
import { SETTINGS_DESCRIPTIONS } from "./settings";
import type { Description } from "./types";

export type { Description };

export const DESCRIPTIONS = {
  ...INSPECTOR_DESCRIPTIONS,
  ...INSERT_DESCRIPTIONS,
  ...SETTINGS_DESCRIPTIONS,
} as const satisfies Record<string, Description>;

export type DescriptionId = keyof typeof DESCRIPTIONS;

/** The most characters a brief may have: what fits on one Inspector line (MEASURED, 13 px Plex at 1440x900). */
export const BRIEF_MAX = 48;
/** The most characters a more may have: about two short sentences in the 280 px tooltip (SET BY HAND). */
export const MORE_MAX = 160;
/** Openings a brief may not have: they teach a standard gesture or point at the screen (section 9.13). */
const BANNED_OPENER = /^(click|drag|pick|here|this is)\b/i;

/** The entry's hint: the brief, made a sentence, then the more. */
export function descriptionHint(entry: Description): string {
  const trimmed = entry.brief?.trim() ?? "";
  const brief = trimmed === "" ? undefined : /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return [brief, entry.more?.trim()].filter((part): part is string => part !== undefined && part !== "").join(" ");
}

/**
 * The hint of an entry, for a button's tooltip or its disabled reason rather than a row (issue
 * #241). It takes `{ describe }`, so the test that every entry is shown finds the id where it is used.
 */
export const describedHint = ({ describe }: { describe: DescriptionId }): string => descriptionHint(DESCRIPTIONS[describe]);

/** What is wrong with one entry by the writing rules of UI_GUIDE section 9.13; empty when nothing is. */
export function descriptionProblems(entry: Description): string[] {
  const problems: string[] = [];
  const brief = entry.brief?.trim();
  const more = entry.more?.trim();
  const label = entry.label.trim();
  if ((brief === undefined || brief === "") && (more === undefined || more === "")) {
    problems.push("has neither a brief nor a more");
  }
  if (brief !== undefined && brief !== "") {
    if (brief.length > BRIEF_MAX) problems.push(`brief is ${String(brief.length)} characters, over ${String(BRIEF_MAX)}`);
    if (/\.(\s|$)/.test(brief)) problems.push("brief has a full stop");
    if (/[?!:;,]$/.test(brief)) problems.push("brief ends with punctuation");
    if (label !== "" && brief.toLowerCase().includes(label.toLowerCase())) problems.push(`brief repeats its label "${label}"`);
    const opener = BANNED_OPENER.exec(brief)?.[0];
    if (opener !== undefined) problems.push(`brief opens with "${opener}"`);
  }
  if (more !== undefined && more.length > MORE_MAX) {
    problems.push(`more is ${String(more.length)} characters, over ${String(MORE_MAX)}`);
  }
  return problems;
}
