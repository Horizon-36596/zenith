/**
 * Whether the signed-in person is a Horizon admin, asked again whenever the user changes (signing
 * in, signing out, or the fake cloud's switch of user). False with the cloud off and until the
 * answer comes.
 */
import { useEffect, useState } from "react";
import { isSignedInHorizonAdmin } from "../account/AdminEntry";
import { cloudEnabled } from "../account/config";
import { account } from "../account/store";

export function useHorizonAdmin(uid: string | null): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    setAdmin(false);
    if (uid === null || !cloudEnabled()) return;
    let live = true;
    void isSignedInHorizonAdmin(account.cloud()).then((answer) => {
      if (live) setAdmin(answer);
    });
    return () => {
      live = false;
    };
  }, [uid]);
  return admin;
}
