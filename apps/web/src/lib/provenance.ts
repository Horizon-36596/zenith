/**
 * A provenance string split into its vocabulary label and its note, and put back together, for the
 * chip menu that sets a value's provenance by hand (#87).
 *
 * The file format keeps provenance a plain string: "the label goes first, then the reason"
 * (site/docs/file-format.md, "Provenance labels"), as in "PLACEHOLDER: until calibrated" or
 * "MEASURED 2026-01-15 ForwardVelocityTuner". So a note is allowed, and the menu writes one back as
 * `LABEL: note`, the form the starter files and the editor's own strings use.
 */
import { EDITOR_PROVENANCE, PROVENANCE_LABELS } from "@horizon36596/zenith-core";

export type ProvenanceVocabularyLabel = (typeof PROVENANCE_LABELS)[number];

export interface ProvenanceParts {
  /** The vocabulary label the string starts with, or null when it starts with none. */
  label: ProvenanceVocabularyLabel | null;
  /** Everything after the label, without the colon or spaces that separate them. */
  note: string;
}

/** The labels longest first, so "SET FROM EDITOR" is found before a shorter label could match. */
const LONGEST_FIRST = [...PROVENANCE_LABELS].sort((a, b) => b.length - a.length);

/**
 * Splits a provenance string into its label and its note. A string that starts with no vocabulary
 * label has no label, and the whole string is its note, so choosing a label in the menu keeps it.
 */
export function splitProvenance(text: string | undefined): ProvenanceParts {
  const trimmed = (text ?? "").trim();
  const upper = trimmed.toUpperCase();
  const label = LONGEST_FIRST.find(
    (candidate) => upper === candidate || upper.startsWith(`${candidate}:`) || upper.startsWith(`${candidate} `),
  );
  if (label === undefined) return { label: null, note: trimmed };
  const rest = trimmed.slice(label.length).trim();
  return { label, note: (rest.startsWith(":") ? rest.slice(1) : rest).trim() };
}

/**
 * The labels that say a number was read off the real robot or field. Typing a different number over
 * one is the editor's own guess, so it no longer holds (owner ruling 2026-10-10, issue #273).
 */
export const READ_OFF_LABELS = ["MEASURED", "CALIBRATED FROM ROBOT"] as const satisfies readonly ProvenanceVocabularyLabel[];

export type ReadOffLabel = (typeof READ_OFF_LABELS)[number];

/** What a pose's provenance is once a number was typed for it, and what that replaced. */
export interface TypedProvenance {
  /** The provenance to write with the typed number. */
  provenance: string;
  /** The read-off label the typed number replaced, or null when the label stays. */
  replaced: ReadOffLabel | null;
}

/**
 * The provenance a number typed in the inspector leaves a waypoint, path point or start with. One
 * labelled MEASURED or CALIBRATED FROM ROBOT becomes SET FROM EDITOR, and `replaced` names what it
 * was so the caller can warn; the chip sets it back in one step. Every other label is kept, because
 * a typed number is often a number the person just worked out and labelled themselves, and a value
 * with no label gets the editor's.
 */
export function provenanceAfterTyping(provenance: string | undefined): TypedProvenance {
  const { label } = splitProvenance(provenance);
  const replaced = READ_OFF_LABELS.find((candidate) => candidate === label) ?? null;
  if (replaced !== null) return { provenance: EDITOR_PROVENANCE, replaced };
  return { provenance: provenance ?? EDITOR_PROVENANCE, replaced: null };
}

/**
 * The warning that goes with `provenanceAfterTyping` relabelling something: it says what changed to
 * what, for what (`what` is mid-sentence, such as "waypoint park" or "the start"), and the two ways
 * back, the label's chip or Ctrl+Z.
 */
export const typedNumberWarning = (replaced: ReadOffLabel, what: string): string =>
  `This changes ${replaced} to ${EDITOR_PROVENANCE} on ${what}. Click its label to choose ${replaced} again, or press Ctrl+Z.`;

/** The string the file stores for a label and a note: the label alone when the note is empty. */
export function joinProvenance(label: ProvenanceVocabularyLabel, note: string): string {
  const clean = note.replace(/\s+/g, " ").trim();
  return clean === "" ? label : `${label}: ${clean}`;
}

/**
 * What each label is for, as the file format documents it (site/docs/file-format.md), so the menu's
 * tooltips and the docs say the same thing.
 */
export const PROVENANCE_MEANING: Readonly<Record<ProvenanceVocabularyLabel, string>> = {
  MEASURED: "Measured on the real robot or field.",
  "SET BY HAND": "Chosen deliberately, such as a speed limit.",
  SPEC: "Taken from the game manual or a part's datasheet.",
  "NEEDS MEASUREMENT": "Known to be wrong or missing; measure it.",
  "CARRIED OVER": "Copied from an older robot or season.",
  PLACEHOLDER: "A stand-in so the file works.",
  APPROX: "An estimate, close but not measured.",
  "SET FROM SIM": "Read off a simulator run.",
  "SET FROM EDITOR": "Placed by dragging or typing in the editor.",
  "CALIBRATED FROM SIM": "Fitted by zenith calibrate from simulator traces.",
  "CALIBRATED FROM ROBOT": "Fitted by zenith calibrate from real-robot recordings.",
};

/** The longest a short chip label may be, so a pose row keeps its chip on one line (UI_GUIDE 9.5). */
export const SHORT_PROVENANCE_MAX = 12;

/** The short form of each vocabulary label, for the chip at the end of a pose row. */
const SHORT_LABELS: Readonly<Record<ProvenanceVocabularyLabel, string>> = {
  MEASURED: "Measured",
  "SET BY HAND": "Set by hand",
  SPEC: "Spec",
  "NEEDS MEASUREMENT": "Needs meas.",
  "CARRIED OVER": "Carried over",
  PLACEHOLDER: "Placeholder",
  APPROX: "Approx",
  "SET FROM SIM": "From sim",
  "SET FROM EDITOR": "From editor",
  "CALIBRATED FROM SIM": "Calib. sim",
  "CALIBRATED FROM ROBOT": "Calib. robot",
};

/**
 * The text of a pose row's chip: the vocabulary label the string starts with in its short form, at
 * most `SHORT_PROVENANCE_MAX` characters. A string that starts with no label is cut to that length.
 * The chip's tooltip carries the full label and its meaning.
 */
export function shortProvenanceLabel(text: string | undefined): string {
  const { label, note } = splitProvenance(text);
  if (label !== null) return SHORT_LABELS[label];
  const plain = (text ?? note).trim();
  return plain.length > SHORT_PROVENANCE_MAX ? `${plain.slice(0, SHORT_PROVENANCE_MAX - 1)}…` : plain;
}

/**
 * The tooltip label of a pose row's short chip: the full label and its note, as "Set from editor:
 * dragged". A string that starts with no vocabulary label is all note, so the tooltip shows it once
 * as written instead of repeating it after its own head. `fullLabel` is the chip's sentence-case label.
 */
export function shortChipTipLabel(text: string, fullLabel: string): string {
  const { label, note } = splitProvenance(text);
  if (label === null) return text.trim();
  return note === "" ? fullLabel : `${fullLabel}: ${note}`;
}
