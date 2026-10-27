/**
 * The provenance vocabulary of CLAUDE.md rule 4, and the three tiers it collapses into: how
 * strongly a number is claimed, not what colour anything is drawn. The editor's chips
 * (apps/web/UI_GUIDE.md section 4), the renderer and a CLI report all rank the same string the
 * same way, so a PLACEHOLDER is never quietly promoted between one view of a file and another.
 *
 * The label is always shown in full; the tier only sorts it.
 */
export type ProvenanceTier = "measured" | "derived" | "unverified";

const MEASURED = ["MEASURED", "SPEC", "CALIBRATED FROM ROBOT"];
const DERIVED = [
  "SET BY HAND",
  "SET FROM EDITOR",
  "SET FROM SIM",
  "CALIBRATED FROM SIM",
  "CARRIED OVER",
  // Deliberately a prefix, not a label: the vocabulary's two "SET FROM ..." labels are already
  // above, and this catches a hand-written "SET FROM RobotConfig.java", naming the robot code a
  // number was copied from, as derived rather than dropping it to the unverified default.
  "SET FROM",
];
// A negated MEASURED is unverified, not a measurement: "UNMEASURED", "NOT MEASURED".
const UNVERIFIED = ["NEEDS MEASUREMENT", "PLACEHOLDER", "APPROX", "UNMEASURED", "NOT MEASURED", "NOT YET MEASURED"];

/** What a number with no provenance at all is treated as: unmeasured (UI_GUIDE section 8.3). */
export const NO_PROVENANCE = "NEEDS MEASUREMENT";

/** The provenance the editor writes when a human drags or types a pose. */
export const EDITOR_PROVENANCE = "SET FROM EDITOR";

/**
 * Whether `text` names `label` as whole words, so SPECIFICATION is not SPEC and UNMEASURED is not
 * MEASURED. The labels are letters and spaces only, so they need no escaping in a pattern.
 */
const namesLabel = (text: string, label: string): boolean =>
  new RegExp(`(?<![A-Z0-9])${label}(?![A-Z0-9])`).test(text);

/**
 * The tier a string belongs to. Unverified wins over derived and derived over measured, so a
 * label like "SET FROM SIM; PLACEHOLDER until measured" reads as the weaker of the two claims.
 *
 * A stronger tier needs its label as whole words; an unverified label counts anywhere in the
 * text, because reading a number as weaker than it is never overstates it.
 */
export function provenanceTier(provenance: string | undefined): ProvenanceTier {
  const text = (provenance ?? NO_PROVENANCE).toUpperCase();
  if (UNVERIFIED.some((label) => text.includes(label))) return "unverified";
  if (DERIVED.some((label) => namesLabel(text, label))) return "derived";
  if (MEASURED.some((label) => namesLabel(text, label))) return "measured";
  return "unverified";
}

/** Every provenance label the chip menu offers, in the order CLAUDE.md rule 4 lists them. */
export const PROVENANCE_LABELS = [
  "MEASURED",
  "SET BY HAND",
  "SPEC",
  "NEEDS MEASUREMENT",
  "CARRIED OVER",
  "PLACEHOLDER",
  "APPROX",
  "SET FROM SIM",
  "SET FROM EDITOR",
  "CALIBRATED FROM SIM",
  "CALIBRATED FROM ROBOT",
] as const;

/**
 * The vocabulary label a provenance string carries, for a message that has room for the label but
 * not the reason: the label it starts with, else a label it names later, else NEEDS MEASUREMENT
 * for a number with no provenance and the text before its first colon for one with no label.
 */
export function provenanceLabel(provenance: string | undefined): string {
  if (provenance === undefined || provenance.trim() === "") return NO_PROVENANCE;
  const text = provenance.trim().toUpperCase();
  const longestFirst = [...PROVENANCE_LABELS].sort((a, b) => b.length - a.length);
  // A label counts only as whole words, so SPECIFICATION is not SPEC and APPROXIMATELY is not APPROX.
  // The labels are letters and spaces only, so they need no escaping in a pattern.
  const asWords = (label: string, leadingOnly: boolean): RegExp =>
    new RegExp(`${leadingOnly ? "^" : "(?<![A-Z0-9])"}${label}(?![A-Z0-9])`);
  const leading = longestFirst.find((label) => asWords(label, true).test(text));
  if (leading !== undefined) return leading;
  const named = longestFirst.find((label) => asWords(label, false).test(text));
  if (named !== undefined) return named;
  // The text before the first colon; when that is empty (a provenance that starts with a colon),
  // the whole text, so the message never shows empty parentheses.
  const beforeColon = (provenance.split(":")[0] ?? "").trim();
  return beforeColon === "" ? provenance.trim() : beforeColon;
}
