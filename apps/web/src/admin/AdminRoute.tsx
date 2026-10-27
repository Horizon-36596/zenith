/**
 * The `#/admin` route: while the address ends in `#/admin`, the review page is open beside the
 * editor for a signed-in Horizon admin. Closing it clears the hash, so the back button and a bookmark
 * both behave. The route is in the fragment, like the review links, so nothing about it is sent to
 * the host.
 *
 * Anyone else sees nothing of the page (owner ruling 2026-10-03, issue #99): signed out, or signed
 * in without being a Horizon admin, the route opens nothing and the hash is cleared quietly, the way
 * the page's own close button clears it. The check waits for the cloud's first answer about who is
 * signed in, so an admin's bookmark still opens the page after a reload, and it runs again whenever
 * the account changes: signing out beside the open page closes it.
 *
 * With the cloud off there is no review page: nobody can sign in, so the route opens nothing, and
 * `app/CloudOffLink.tsx` says the page is not in this build and clears the hash once closed.
 */
import { useEffect, useState } from "react";
import type { CloudBackend } from "@horizon36596/zenith-cloud";
import { cloudEnabled } from "../account/config";
import { useBetaNoticeOpen } from "../dialogs/betaNoticeState";
import { AdminPage } from "./AdminPage";
import { isAdminHash } from "./model";
import { useVerificationBackend } from "./store";

const closeListeners = new Set<() => void>();

/**
 * Closes the review page the way its own close button does: the hash leaves the address without a
 * new history entry. Going back between screens (`app/navigation.ts`) closes it through here too.
 */
export function closeAdminPage(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  for (const listener of closeListeners) listener();
}

/** Calls `listener` whenever the review page opens or closes, by its address or by `closeAdminPage`. */
export function onAdminRouteChange(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  closeListeners.add(listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    closeListeners.delete(listener);
  };
}

/** Whether the person signed in to `backend` is a Horizon admin. False signed out or on an error. */
async function signedInAdmin(backend: CloudBackend): Promise<boolean> {
  if (backend.currentUser() === null) return false;
  return backend.isHorizonAdmin().catch(() => false);
}

export function AdminRoute() {
  const backend = useVerificationBackend();
  const [open, setOpen] = useState(() => isAdminHash(window.location.hash));
  // Null until the check for the account signed in now has answered.
  const [admin, setAdmin] = useState<boolean | null>(null);
  const noticeOpen = useBetaNoticeOpen();

  useEffect(
    () =>
      onAdminRouteChange(() => {
        setOpen(isAdminHash(window.location.hash));
      }),
    [],
  );

  useEffect(() => {
    // With the cloud starting, the backend arrives a moment later; the page waits for it.
    if (!open || !cloudEnabled() || backend === null) return;
    let live = true;
    let asked = 0;
    const stop = backend.onAuthChange(() => {
      const mine = ++asked;
      setAdmin(null);
      void signedInAdmin(backend).then((yes) => {
        if (!live || mine !== asked) return;
        setAdmin(yes);
        if (!yes) closeAdminPage();
      });
    });
    return () => {
      live = false;
      stop();
      setAdmin(null);
    };
  }, [open, backend]);

  // A bookmark to the page, opened on a first load, shows it once the beta notice is closed.
  if (!open || !cloudEnabled() || admin !== true || noticeOpen) return null;
  return <AdminPage backend={backend} onClose={closeAdminPage} />;
}
