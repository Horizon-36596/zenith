/**
 * The provenance chip beside a value the inspector can edit, made editable (#87). Clicking the chip
 * opens the app's action menu with the CLAUDE.md rule 4 vocabulary, the current label checked, and
 * a note field above it: the file format allows a reason after the label ("PLACEHOLDER: until
 * calibrated"), so the note is written back as `LABEL: note`. Choosing a label, or pressing Enter
 * in the note, writes only the provenance through the caller's edit, which is one undo step.
 *
 * A value that cannot be edited where it is shown keeps the plain `ProvenanceChip`.
 */
import { useCallback, useId, useRef, useState } from "react";
import { NO_PROVENANCE, PROVENANCE_LABELS } from "@horizon36596/zenith-core";
import { ActionMenu, type MenuEntry } from "./ActionMenu";
import { ProvenanceChip, provenanceLabel } from "./primitives";
import { PROVENANCE_MEANING, joinProvenance, splitProvenance } from "../lib/provenance";
import styles from "./ProvenancePicker.module.css";

/**
 * The hint for a pose's chip. The canvas drag, the arrow keys and the rotate keys stamp
 * SET FROM EDITOR on a point they move (`app/edits.ts`); typing a number in the inspector keeps the
 * provenance the point has, except MEASURED and CALIBRATED FROM ROBOT, which it relabels
 * SET FROM EDITOR with a warning (issue #273).
 */
export const POSE_PROVENANCE_HINT =
  "Click to set it by hand. Dragging the point on the field, or moving it with the arrow or R keys, sets it back to Set from editor; typing a number here keeps the label you chose, except Measured and Calibrated from robot, which become Set from editor.";

/** The hint for a value no edit relabels, such as an envelope or a rejoin pose. */
export const KEPT_PROVENANCE_HINT = "Click to set it by hand. Changing the numbers keeps the label you chose.";

export function ProvenancePicker({
  provenance,
  onChange,
  hint,
  testId,
  short = false,
}: {
  provenance: string | undefined;
  /** Writes the new provenance string; called only when it differs from the current one. */
  onChange: (provenance: string) => void;
  hint: string;
  testId?: string;
  /** The chip of a pose row: the short label, with the full one in its tooltip (UI_GUIDE 9.5). */
  short?: boolean;
}) {
  const [menu, setMenu] = useState<{ xPx: number; yPx: number } | null>(null);
  const [note, setNote] = useState("");
  const chip = useRef<HTMLSpanElement | null>(null);
  // The menu closes on any press outside it, the chip included; this remembers that the press
  // which closed it was on the chip, so the click that follows does not open it again.
  const closedByChip = useRef(false);
  const noteId = useId();

  // A file with no provenance reads as NEEDS MEASUREMENT (UI_GUIDE section 8.3), so that is the
  // label the menu checks, as the chip shows; choosing it still writes it into the file.
  const current = splitProvenance(provenance ?? NO_PROVENANCE).label;

  const close = useCallback(() => {
    setMenu(null);
    chip.current?.querySelector("button")?.focus();
  }, []);

  const choose = (label: (typeof PROVENANCE_LABELS)[number]): void => {
    const next = joinProvenance(label, note);
    if (next !== provenance) onChange(next);
  };

  const entries: MenuEntry[] = PROVENANCE_LABELS.map((label) => ({
    id: `provenance-${label.toLowerCase().replace(/ /g, "-")}`,
    label: provenanceLabel(label),
    does: PROVENANCE_MEANING[label],
    checked: label === current,
    run: () => {
      choose(label);
    },
  }));

  return (
    <span
      ref={chip}
      className={styles.anchor}
      onPointerDownCapture={(event) => {
        // A press inside the menu reaches here too, through the portal, so only one on the chip counts.
        closedByChip.current = menu !== null && chip.current?.contains(event.target as Node) === true;
      }}
    >
      <ProvenanceChip
        provenance={provenance}
        hint={hint}
        short={short}
        expanded={menu !== null}
        testId={testId}
        onClick={(event) => {
          if (closedByChip.current) {
            closedByChip.current = false;
            return;
          }
          const box = event.currentTarget.getBoundingClientRect();
          setNote(splitProvenance(provenance).note);
          setMenu({ xPx: box.left, yPx: box.bottom + 4 });
        }}
      />
      {menu === null ? null : (
        <ActionMenu
          xPx={menu.xPx}
          yPx={menu.yPx}
          entries={entries}
          onClose={close}
          label="Provenance"
          testId={testId === undefined ? undefined : `${testId}-menu`}
        >
          <div className={styles.note}>
            <label className={styles.noteLabel} htmlFor={noteId}>
              Note
            </label>
            <input
              id={noteId}
              className={styles.noteInput}
              value={note}
              placeholder="Optional, such as tape, 2026-09-30"
              spellCheck={false}
              data-testid={testId === undefined ? undefined : `${testId}-note`}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (current !== null) choose(current);
                close();
              }}
            />
            <p className={styles.noteHint}>Written after the label. Choose a label, or press Enter to keep the checked one.</p>
          </div>
        </ActionMenu>
      )}
    </span>
  );
}
