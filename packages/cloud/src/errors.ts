/** Why a cloud call failed. Each code comes with a sentence the app can show as it is. */
export type CloudErrorCode =
  /** The security rules refused the read or write. */
  | "permission-denied"
  /** The document does not exist, or the caller may not know that it does. */
  | "not-found"
  /** The caller gave a value the call cannot take. */
  | "invalid"
  /** The call needs a signed-in user and nobody is signed in. */
  | "signed-out"
  /** The call needs the server and the device is offline. */
  | "unavailable"
  /** The call conflicts with the current state, for example a team number that is already claimed. */
  | "conflict"
  /** A sensitive call, such as deleting the account, needs the person to sign in again first. */
  | "reauth-required"
  /**
   * This device does not hold the team key it needs yet (spec 14 section 4.3): it is waiting for an
   * owner, an admin or another of the member's devices to give it the key.
   */
  | "no-key"
  /**
   * Encrypted data, a key record or a signature did not check out: it was changed, moved or made by
   * someone without the key. Nothing of it is shown. Only the server, or someone who controls it,
   * could have done this.
   */
  | "tampered"
  /**
   * A partner team's public key is not the one this device saw for it before, under the same or an
   * older version (spec 14 section 4.6). Compare the team's safety code before trusting the new key.
   */
  | "key-changed"
  /**
   * The approval code typed for a device is not that device's: its first part does not come from the
   * keys the device registered, or it is not a code at all (spec 14 section 4.3).
   */
  | "wrong-code";

export class CloudError extends Error {
  readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloudError";
    this.code = code;
  }
}

export function isCloudError(value: unknown, code?: CloudErrorCode): value is CloudError {
  return value instanceof CloudError && (code === undefined || value.code === code);
}

/**
 * What a store says when the cloud's rules refuse a read or a write. The rules say only that they
 * refused, never why, so the sentence says what most often causes it. Both stores use it, so the
 * app can tell it from the client's own refusals, which say exactly what is wrong.
 */
export const RULES_REFUSED = "The cloud refused that. Your role in the team may not allow it.";

/** What a store says when the device is offline and holds no copy of what was asked for. */
export const OFFLINE_NOT_SAVED =
  "This computer cannot reach the cloud, and has no copy of that saved for offline use. Try again once it is back online.";

/** What a store says when what was asked for is not there, or the caller may not know it is. */
export const NOT_FOUND = "That no longer exists, or you cannot open it.";

/**
 * Why Delete my account stopped before deleting anything: the sign-in provider asked the person to
 * sign in again and they did not finish (the window was closed, blocked or signed in as someone else).
 */
export const SIGN_IN_AGAIN_TO_DELETE =
  "Deleting your account needs you to sign in again first, so Zenith knows it is you. Nothing was deleted. Press Delete my account again and finish signing in.";

/**
 * Why Delete my account stopped before deleting anything: the person signed in again, but as a
 * different account from the one being deleted.
 */
export const DIFFERENT_ACCOUNT_NOT_DELETED =
  "That was a different account. Nothing was deleted. Sign in again with the account you want to delete.";

/**
 * Why sign-out could not clear the offline cache (spec 13 section 6): the person is signed out, but
 * the browser refused to delete the cache, most often because another Zenith tab or window still
 * has it open. This tab stops using it (it keeps no offline copy until it is reloaded), so another
 * account signing in here cannot read it; the copy stays on this computer until it is cleared.
 */
export const SIGN_OUT_CACHE_KEPT =
  "You are signed out, but the team library's offline copy could not be cleared, usually because another Zenith tab or window still has it open. This tab no longer uses it, but it stays on this computer until Zenith is closed in every tab and window. Then open Zenith, sign in and sign out again to clear it.";
