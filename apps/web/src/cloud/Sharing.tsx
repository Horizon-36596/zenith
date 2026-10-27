/**
 * Whichever sharing sheet is open: the share dialog, the Sharing page, the share viewer, or none;
 * and the in-app expiry warning, which shows while none is open. With the cloud off, none of them.
 * With partner sharing off in Settings, General, only the viewer: a share link someone was sent
 * still opens, but nothing offers to share, and nothing warns about shares ending.
 */
import { cloudEnabled } from "../account/config";
import { useBetaNoticeOpen } from "../dialogs/betaNoticeState";
import { useFeature } from "../state/features";
import { ExpiryNotice } from "./ExpiryNotice";
import { ShareSheet } from "./ShareSheet";
import { SharedAutoViewer } from "./SharedAutoViewer";
import { SharingPage } from "./SharingPage";
import { useCloud } from "./store";

export function Sharing() {
  const partners = useFeature("partners");
  // A share link opened on a first load shows its sheet once the beta notice is closed.
  const noticeOpen = useBetaNoticeOpen();
  if (!cloudEnabled() || noticeOpen) return null;
  return (
    <>
      <SharingSheet partners={partners} />
      {partners ? <ExpiryNotice /> : null}
    </>
  );
}

function SharingSheet({ partners }: { partners: boolean }) {
  const { sheet } = useCloud();
  if (sheet === "share" && partners) return <ShareSheet />;
  if (sheet === "sharing" && partners) return <SharingPage />;
  if (sheet === "viewer") return <SharedAutoViewer />;
  return null;
}
