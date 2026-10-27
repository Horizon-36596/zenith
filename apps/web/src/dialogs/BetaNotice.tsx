/**
 * The beta notice: on the first load of each version, a small dialog says Zenith is in beta, who has
 * tested it, and where to report a bug. One primary button, Got it; Escape counts as Got it. It is a
 * native `<dialog>` in the app's modal frame (UI_GUIDE section 9.14), so focus stays in it while it
 * is open. When it was dismissed, and what waits for it, is `betaNoticeState.ts`.
 */
import { useEffect, useRef } from "react";
import { Button } from "../components/primitives";
import { Modal } from "./Modal";
import { dismissBetaNotice, useBetaNoticeOpen } from "./betaNoticeState";
import dialogs from "./Dialogs.module.css";
import styles from "./BetaNotice.module.css";

/** The public issue tracker, where anyone can report a bug. */
export const ISSUES_URL = "https://github.com/Horizon-36596/zenith/issues";

/** What changed in each version. */
export const CHANGELOG_URL = "https://libraries.horizon36596.org/zenith/changelog/";

/** Focuses the field, or failing that the first region, when focus is on nothing in particular. */
function focusTheFieldIfLost(): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  const region = document.querySelector<HTMLElement>('[data-region][aria-label="Field canvas"]') ?? document.querySelector<HTMLElement>("[data-region]");
  region?.focus({ preventScroll: true });
}

export function BetaNotice() {
  return useBetaNoticeOpen() ? <Notice /> : null;
}

function Notice() {
  const body = useRef<HTMLDivElement | null>(null);

  // Got it takes the focus, so Enter closes the notice. The frame's `showModal` has already moved
  // focus to the first link by the time this runs, since a parent's effect runs after its child's.
  useEffect(() => {
    body.current?.closest("dialog")?.querySelector<HTMLButtonElement>("[data-testid='beta-notice-ok']")?.focus();
  }, []);

  const close = (): void => {
    dismissBetaNotice();
    // Nothing had the focus before the notice, so the frame has nowhere to return it. Once the
    // notice is gone and whatever waited for it has mounted, the preset card takes it if it opened;
    // otherwise the field does, so the keys work at once instead of from the page's body.
    window.setTimeout(focusTheFieldIfLost, 0);
  };

  return (
    <Modal
      title="Zenith is in beta"
      testId="beta-notice"
      width={440}
      onClose={close}
      footer={
        <>
          <a className={styles.changelog} href={CHANGELOG_URL} target="_blank" rel="noreferrer" data-testid="beta-notice-changelog">
            What changed
          </a>
          <Button kind="primary" testId="beta-notice-ok" onClick={close}>
            Got it
          </Button>
        </>
      }
    >
      <div ref={body} className={dialogs.lines}>
        <p className={dialogs.prose}>It has been tested mostly by one team, Horizon (FTC 36596), so some things may break.</p>
        <p className={dialogs.prose}>
          Found a bug? Use Help, Report a bug, or open an issue on{" "}
          <a className={styles.link} href={ISSUES_URL} target="_blank" rel="noreferrer" data-testid="beta-notice-issues">
            GitHub
          </a>
          .
        </p>
      </div>
    </Modal>
  );
}
