/**
 * Which cloud backend the verification UI talks to. It starts empty, so a normal visit shows no
 * review page and no Verification section; the account session hands it the page's one backend
 * with `setVerificationBackend` once the cloud starts (`account/wiring.ts`), so the Teams sheet's
 * Verification section and the `#/admin` review page read what the account signed in to. With
 * `?cloud=fake` that is the account's in-memory backend; the test users in the Developer section of
 * Settings include the demonstration reviewer, who brings the review page's demonstration data
 * (`fakeVerification.ts`) with them.
 */
import { useSyncExternalStore } from "react";
import type { AdminAction, CloudBackend } from "@horizon36596/zenith-cloud";

let backend: CloudBackend | null = null;
const listeners = new Set<() => void>();

const current = (): CloudBackend | null => backend;

/** The backend the verification UI uses now, outside React (tests, and the account's wiring). */
export const verificationBackend = (): CloudBackend | null => backend;

/** Points the verification UI at a backend, or at none. */
export function setVerificationBackend(next: CloudBackend | null): void {
  if (next === backend) return;
  backend = next;
  for (const listener of listeners) listener();
}

/**
 * Records a Horizon admin's read in the admin access log (spec 13 section 13: admin access is
 * logged), before the page reads. The entry is written locally at once and sent like any other
 * write; a refusal shows in the outbox and does not stop the page, whose read the database refuses
 * to anyone it would refuse the entry to. Decisions write their own entry in the same write.
 */
export async function logAdminAccess(backend: CloudBackend, action: AdminAction, target?: string): Promise<void> {
  try {
    const queued = await backend.recordAdminAccess(action, target);
    queued.sent.catch(() => undefined);
  } catch {
    // Signed out or offline before the write was made: the read that follows says why.
  }
}

/** The backend the verification UI uses, or null when the cloud is not set up. */
export function useVerificationBackend(): CloudBackend | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    () => null,
  );
}
