/**
 * The admin page's Beta access view (`BetaAccess.tsx`): what each field says when it cannot be sent,
 * the count line, and what an admin may do with each row. It reads nothing and draws nothing. Who
 * may write the lists is the rules' decision (cloud/firestore.rules, `betaTesters/{uid}` and
 * `admins/{uid}`); these only keep a button from offering what they refuse.
 */
import { isCloudError, type BetaAccessLists } from "@horizon36596/zenith-cloud";
import { cloudErrorSentence } from "../cloud/errorSentence";

/** The longest name the beta lists take, as the rules allow. */
export const MAX_NAME = 80;
/** The longest user code the form takes. */
export const MAX_USER_CODE = 128;

/** Why a typed name cannot be sent, or null when it can. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Type the person's name.";
  if (trimmed.length > MAX_NAME) return `A name has at most ${String(MAX_NAME)} characters.`;
  return null;
}

/** Why a pasted user code cannot be sent, or null when it can. */
export function userCodeProblem(code: string): string | null {
  const trimmed = code.trim();
  if (trimmed === "") return "Paste the person's user code.";
  if (trimmed.length > MAX_USER_CODE || trimmed.includes("/")) return "A user code has at most 128 characters and no slash.";
  // Firestore cannot use these as document ids, so the write would fail.
  if (trimmed === "." || trimmed === ".." || /^__.*__$/.test(trimmed)) {
    return "That is not a user code. Copy it again from the person's private-beta screen.";
  }
  return null;
}

/** The sentence shown when an add fails because another admin got there first. */
export const ALREADY_HANDLED = "Another admin already added this person; refresh.";

/**
 * What an add says when it fails. The rules refuse it when another admin got there first (the
 * tester or admin entry already exists); the raw error does not say so.
 */
export function grantErrorWords(error: unknown): string {
  if (isCloudError(error, "permission-denied") || isCloudError(error, "not-found")) return ALREADY_HANDLED;
  return cloudErrorSentence(error);
}

/** "1 tester" or "4 testers". */
export function testerCountWords(count: number): string {
  return count === 1 ? "1 tester" : `${String(count)} testers`;
}

export function isTester(lists: BetaAccessLists, uid: string): boolean {
  return lists.testers.some((tester) => tester.uid === uid);
}

export function isAdmin(lists: BetaAccessLists, uid: string): boolean {
  return lists.admins.some((admin) => admin.uid === uid);
}

/** Why an admin cannot be removed by `me`, or null: nobody removes themselves. */
export function removeAdminProblem(uid: string, me: string): string | null {
  return uid === me ? "You cannot remove yourself. Another Horizon admin can." : null;
}

/** Why `uid` cannot be made an admin, or null. */
export function makeAdminProblem(lists: BetaAccessLists, uid: string): string | null {
  return isAdmin(lists, uid) ? "This person is already a Horizon admin." : null;
}

/** The name an admin row shows: the name the console or an admin typed, or the user code. */
export function adminName(admin: { uid: string; name: string | null }): string {
  return admin.name ?? admin.uid;
}
