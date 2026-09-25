/**
 * The modal frame of UI_GUIDE section 8.10: a native `<dialog>` so focus is trapped and Escape
 * closes, a 60 % scrim over the app surface, 6 px radius, 20 px padding, exactly one primary button.
 * The title names the dialog for a screen reader (QA-16), and focus goes back to whatever had it
 * when the dialog opened once the dialog goes away (QA-17): the app closes a dialog by unmounting
 * it, which the browser does not treat as a close, so the frame puts focus back itself.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Modal.module.css";

export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 520,
  tall = false,
  testId,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
  /**
   * Lets the body use the window's whole height instead of 60 % of it, for a reference sheet. If
   * it still does not fit, the body scrolls with a fade along its bottom edge.
   */
  tall?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  // Read while rendering, before `showModal` moves focus in. An effect would be too late in
  // development, where React mounts effects twice and the second sees focus inside the dialog.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    const opener = openerRef.current ?? null;
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      // Another dialog opening in this one's place takes focus itself; otherwise the opener gets it
      // back, if it is still on the page.
      if (opener === null || !opener.isConnected || opener === document.body) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && active.closest("dialog[open]") !== null) return;
      opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={tall ? `${styles.dialog} ${styles.tall}` : styles.dialog}
      style={{ width: `${String(width)}px` }}
      data-testid={testId}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <h2 id={titleId} className={styles.title}>{title}</h2>
      <div className={tall ? `${styles.body} ${styles.tallBody}` : styles.body}>
        {children}
        {tall ? <div className={styles.fade} aria-hidden /> : null}
      </div>
      {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
    </dialog>
  );
}
