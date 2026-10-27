/**
 * The account root: starts the cloud session once (never with a prompt), publishes on save when the
 * team asks for it, and shows whichever account sheet is open. With the cloud off it renders nothing.
 * The account itself (display name, signing out, your data) is a section of the Settings window
 * (`settings/SettingsWindow.tsx`), not a sheet.
 */
import { useEffect } from "react";
import { useBetaNoticeOpen } from "../dialogs/betaNoticeState";
import { LibrarySheet } from "../library/LibrarySheet";
import { cloudEnabled } from "./config";
import { OutboxSheet } from "./OutboxSheet";
import { SignInSheet } from "./SignInSheet";
import { initAccount, useAccount, useWatchSaves } from "./store";
import { TeamsSheet } from "./TeamsSheet";

export function Account() {
  useEffect(() => initAccount(), []);
  useWatchSaves();
  const { panel } = useAccount();
  // An invite link opened on a first load asks to sign in once the beta notice is closed.
  const noticeOpen = useBetaNoticeOpen();
  if (!cloudEnabled() || noticeOpen) return null;
  if (panel === "signIn") return <SignInSheet />;
  if (panel === "teams") return <TeamsSheet />;
  if (panel === "library") return <LibrarySheet />;
  if (panel === "outbox") return <OutboxSheet />;
  return null;
}
