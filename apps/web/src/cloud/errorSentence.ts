/**
 * Why a cloud call failed, as the one sentence any screen shows: Sharing, the account and team
 * sheets, the team library and the admin pages all say the same failure the same way (UI_GUIDE
 * section 9.19). The sentence says what went wrong in plain words and ends with what to do.
 *
 * A `CloudError` carries a sentence already: the client's own checks say exactly what is wrong
 * ("Only an owner of the team can delete it."), and the stores word what the cloud's rules and the
 * network say (`RULES_REFUSED`, `OFFLINE_NOT_SAVED`), never the SDK's developer text. Any other
 * error is the SDK's or the browser's, so its text is shown only when it is a sentence Zenith wrote.
 *
 * The CloudError code is found by its fields (`cloudErrorCode`), and the stores' sentences come from
 * the cloud package's Firebase-free `sharing` entry, so this file does not load the Firebase SDK.
 */
import { NOT_FOUND, OFFLINE_NOT_SAVED, RULES_REFUSED } from "@horizon36596/zenith-cloud/sharing";
import { cloudErrorCode, keyErrorSentence } from "../account/keys/errors";

/** What a screen says for the failures whose words depend on where they happen. */
export interface CloudErrorWords {
  /** Nobody is signed in: "Sign in to share." Unset, the client's own sentence or a general one. */
  signedOut?: string;
}

export const OFFLINE = OFFLINE_NOT_SAVED;
export const REQUEST_FAILED = "The request failed. Try again in a moment.";

/** A code's sentence, for a `CloudError` whose own message is not one. */
const BY_CODE: Readonly<Record<string, string>> = {
  "permission-denied": RULES_REFUSED,
  unavailable: OFFLINE,
  "not-found": NOT_FOUND,
  invalid: "The cloud could not take that request. Try again in a moment.",
  conflict: "That changed on the cloud while this was being sent. Try again.",
  "reauth-required": "Sign in again, then try again.",
};

/**
 * True when the cloud's rules refused the call, which says only that they refused. A screen that
 * knows what the rules allow there says that instead; the client's own refusals say exactly what is
 * wrong and are kept.
 */
export function isRulesRefusal(error: unknown): boolean {
  return cloudErrorCode(error) === "permission-denied" && error instanceof Error && error.message === RULES_REFUSED;
}

/** The error's message when it is a whole sentence, or null. */
export function ownSentence(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  // An SDK's own errors are written for developers ("Firebase: Error (auth/...)."), sentence or not.
  if (error.name === "FirebaseError" || /^Firebase:|\(auth\//.test(error.message)) return null;
  const message = error.message.trim();
  return /^[A-Z].*[.!?]$/s.test(message) ? message : null;
}

/** The Firebase SDK's error code (`auth/network-request-failed`), found by shape, or null. */
function firebaseCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "FirebaseError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Why a cloud call failed, as one sentence with what to do. `words` are the screen's own. */
export function cloudErrorSentence(error: unknown, words: CloudErrorWords = {}): string {
  const key = keyErrorSentence(error);
  if (key !== null) return key;
  const code = cloudErrorCode(error);
  if (code === "signed-out") return words.signedOut ?? ownSentence(error) ?? "Sign in, then try again.";
  if (code !== null) return ownSentence(error) ?? BY_CODE[code] ?? REQUEST_FAILED;
  const sdk = firebaseCode(error);
  if (sdk !== null) return /network-request-failed|unavailable/.test(sdk) ? OFFLINE : REQUEST_FAILED;
  return ownSentence(error) ?? REQUEST_FAILED;
}
