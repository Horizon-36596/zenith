/**
 * The banner an owner or admin sees when someone left the team on their own and the team key has not
 * been replaced yet. A member who leaves cannot make the new key themselves, because their device is
 * the one leaving, so the next owner or admin to open the team does it with this button.
 */
import { SheetButton } from "../../cloud/controls";
import { ROTATION } from "./words";
import styles from "./keys.module.css";

export interface RotationPendingProps {
  /** The display name of the member who left, when there was exactly one; otherwise null or absent. */
  leaverName?: string | null;
  /** Makes the new team key. */
  onRotate: () => void;
  /** True while the new key is being made and written. */
  busy: boolean;
  /** Why the viewer cannot make the key now (offline, for example), or null when they can. */
  whyCannotRotate?: string | null;
}

export function RotationPending({ leaverName = null, onRotate, busy, whyCannotRotate = null }: RotationPendingProps) {
  return (
    <div className={styles.banner} role="status" data-testid="rotation-pending">
      <p className={styles.bannerText}>{leaverName === null ? ROTATION.anyone : ROTATION.named(leaverName)}</p>
      <SheetButton
        tooltip={ROTATION.rotateTooltip}
        hint={ROTATION.rotateHint}
        whyDisabled={busy ? ROTATION.rotating : whyCannotRotate}
        testId="rotation-pending-rotate"
        onClick={onRotate}
      >
        {busy ? ROTATION.rotating : ROTATION.rotate}
      </SheetButton>
    </div>
  );
}
