/**
 * "Make it a wait step", next to the user's start offset (spec 13 section 9: "turning it into a
 * real wait step is one click, through the normal edit and undo path"). One click puts a wait of
 * the offset's length in front of the auto's first step and sets the offset back to 0 s, so the
 * robot waits exactly as long and both lanes look as they did.
 *
 * Only the user's own offset can become a wait. When it is 0 s and a partner has an offset of its
 * own, the partner is the one waiting (the user's robot starts first), and that wait belongs in the
 * partner's auto, which this cannot edit; the tooltip says so.
 */
import { isReadOnly, useEditor } from "../state/store";
import { Tooltip } from "../components/Tooltip";
import { offsetToWait } from "./actions";
import { useAllianceState } from "./store";
import styles from "./alliance.module.css";

/** Why the button cannot be used right now, or null when it can. */
export function offsetToWaitBlocked(
  ownOffsetS: number,
  partnerOffsetsS: readonly number[],
  readOnly: boolean,
): string | null {
  if (readOnly) return "Review mode is read only.";
  if (ownOffsetS > 0) return null;
  if (partnerOffsetsS.some((offsetS) => offsetS > 0)) {
    return "Your start offset is 0 s, so it is your partner who waits. A partner's wait cannot become a step in your auto: ask them to add it to theirs.";
  }
  return "Your start offset is 0 s, so there is no wait to make. Set an offset first.";
}

export function OffsetToWait() {
  const editor = useEditor();
  const { ownOffsetS, partners } = useAllianceState();
  if (editor.auto === null) return null;
  const blocked = offsetToWaitBlocked(
    ownOffsetS,
    partners.map((partner) => partner.offsetS),
    isReadOnly(editor),
  );
  const hint =
    blocked ??
    `Puts a ${ownOffsetS.toFixed(1)} s wait in front of the first step of your auto and sets your start offset back to 0 s, so your robot and the lanes look the same. It is a real edit: Undo removes it. Only your own offset can become a wait; when your partner waits instead, that wait belongs in their auto.`;
  return (
    <div className={styles.offsetToWait}>
      <Tooltip label="Make it a wait step" hint={hint}>
        <button
          type="button"
          className={styles.textButton}
          aria-disabled={blocked === null ? undefined : true}
          data-testid="partners-offset-to-wait"
          onClick={() => {
            if (blocked === null) offsetToWait();
          }}
        >
          Make it a wait step
        </button>
      </Tooltip>
    </div>
  );
}
