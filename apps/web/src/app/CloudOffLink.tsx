/**
 * With the cloud off (a build from source without a cloud config; releases have it on), a share link,
 * an invite link or `#/admin` opens a plain page saying that it is not available in this build, instead of an empty editor with the link still in the address bar.
 * Closing the page clears the address, so a reload or a bookmark opens the editor, and on a first
 * visit it opens the example and the tour as the plain address would. With the cloud on this renders
 * nothing, and the account session follows the link.
 */
import { useEffect, useState } from "react";
import { cloudEnabled } from "../account/config";
import { Modal } from "../dialogs/Modal";
import { useBetaNoticeOpen } from "../dialogs/betaNoticeState";
import { Button } from "../components/primitives";
import { cloudLinkKind, cloudOffNotice, type CloudLinkKind } from "./cloudLinks";
import styles from "../dialogs/Dialogs.module.css";

const clearHash = (): void => {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
};

const linkNow = (): CloudLinkKind | null => (cloudEnabled() ? null : cloudLinkKind(window.location.hash));

/**
 * `onClosed` runs once the page is closed and the address is clear, so a first visit that came in
 * through a link can still open the example and start the tour, as a first visit at the plain
 * address does.
 */
export function CloudOffLink({ onClosed }: { onClosed?: () => void }) {
  const [kind, setKind] = useState<CloudLinkKind | null>(linkNow);
  const noticeOpen = useBetaNoticeOpen();

  useEffect(() => {
    if (cloudEnabled()) return undefined;
    const follow = () => {
      setKind(linkNow());
    };
    window.addEventListener("hashchange", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
    };
  }, []);

  // The link's page comes after the beta notice on a first load, never under or over it.
  if (kind === null || noticeOpen) return null;
  const notice = cloudOffNotice(kind);
  const close = () => {
    clearHash();
    setKind(null);
    onClosed?.();
  };
  return (
    <Modal
      title={notice.title}
      testId="cloud-off-link"
      onClose={close}
      footer={
        <Button kind="primary" testId="cloud-off-link-close" onClick={close}>
          Open the editor
        </Button>
      }
    >
      {notice.paragraphs.map((paragraph) => (
        <p key={paragraph} className={styles.prose}>
          {paragraph}
        </p>
      ))}
    </Modal>
  );
}
