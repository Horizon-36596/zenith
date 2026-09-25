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
const UNVERIFIED = ["NEEDS MEASUREMENT", "PLACEHOLDER", "APPROX"];

/** What a number with no provenance at all is treated as: unmeasured (UI_GUIDE section 8.3). */
export const NO_PROVENANCE = "NEEDS MEASUREMENT";

/** The provenance the editor writes when a human drags or types a pose. */
export const EDITOR_PROVENANCE = "SET FROM EDITOR";

/**
 * The tier a string belongs to. Unverified wins over derived and derived over measured, so a
 * label like "SET FROM SIM; PLACEHOLDER until measured" reads as the weaker of the two claims.
 */
export function provenanceTier(provenance: string | undefined): ProvenanceTier {
  const text = (provenance ?? NO_PROVENANCE).toUpperCase();
  if (UNVERIFIED.some((label) => text.includes(label))) return "unverified";
  if (DERIVED.some((label) => text.includes(label))) return "derived";
  if (MEASURED.some((label) => text.includes(label))) return "measured";
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
