/**
 * A GitHub token for GitHub mode from "Sign in with GitHub", in a browser (site/docs/github.md).
 *
 * GitHub's own OAuth web flow needs the OAuth app's client secret to trade the code for a token, and
 * a static page cannot keep one. Firebase Authentication already keeps that secret for the GitHub
 * sign-in provider (cloud/README.md step 4), and its popup hands back GitHub's access token along
 * with the Firebase user. So the page asks Firebase's popup for the `repo` scope and keeps only the
 * GitHub token.
 *
 * It runs on a second Firebase app with its own in-memory Auth, so it never signs the page in to, or
 * out of, the Zenith account. When the popup made a brand-new Firebase user (nobody had signed in to
 * Zenith with this GitHub account before), that user is deleted again at once, so the GitHub button
 * leaves no Zenith account behind. An existing account is only signed out of the second app.
 */
import { deleteApp, initializeApp, type FirebaseOptions } from "firebase/app";
import {
  browserPopupRedirectResolver,
  deleteUser,
  getAdditionalUserInfo,
  GithubAuthProvider,
  inMemoryPersistence,
  initializeAuth,
  signInWithPopup,
  signOut,
  type UserCredential,
} from "firebase/auth";
import { CloudError } from "../errors.js";

/**
 * What GitHub mode needs from an OAuth app's token. An OAuth app cannot be limited to one repository
 * the way a fine-grained token can: `repo` reaches every repository the account can, private ones
 * included, which the sign-in dialog says before the button. SPEC: GitHub's OAuth scopes page.
 */
export const GITHUB_REPO_SCOPES: readonly string[] = ["repo"];

const APP_NAME = "zenith-github-repo";

/** Each sign-in gets its own short-lived app, so a second click while a popup is open cannot clash. */
let sequence = 0;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

/** One sentence for the dialog, for the popup's failures a person can do something about. */
function sentenceFor(code: string): string {
  switch (code) {
    case "auth/popup-blocked":
      return "The browser blocked GitHub's sign-in window. Allow pop-ups for this site, then try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return "Sign-in was cancelled.";
    case "auth/unauthorized-domain":
      return "Sign in with GitHub is not set up for this address. Paste a token instead.";
    case "auth/operation-not-allowed":
      return "Sign in with GitHub is switched off for Zenith. Paste a token instead.";
    case "auth/network-request-failed":
      return "Could not reach GitHub. Check the connection and try again.";
    default:
      return "GitHub did not finish the sign-in. Try again, or paste a token instead.";
  }
}

/**
 * Opens GitHub's sign-in popup with the `repo` scope and resolves with GitHub's access token.
 * Rejects with a `CloudError` whose message is one sentence for the dialog.
 */
export async function githubRepoToken(config: FirebaseOptions): Promise<string> {
  sequence += 1;
  const app = initializeApp(config, `${APP_NAME}-${sequence}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  const provider = new GithubAuthProvider();
  for (const scope of GITHUB_REPO_SCOPES) provider.addScope(scope);
  // Always show GitHub's page, so a person signed in to GitHub sees which account and what access.
  provider.setCustomParameters({ allow_signup: "false" });

  let result: UserCredential;
  try {
    result = await signInWithPopup(auth, provider);
  } catch (error) {
    // An email already on a Zenith account with another provider: Firebase refuses the Firebase
    // sign-in, but GitHub's token came back all the same, and that is all GitHub mode needs.
    if (errorCode(error) === "auth/account-exists-with-different-credential") {
      const token = GithubAuthProvider.credentialFromError(error as Parameters<typeof GithubAuthProvider.credentialFromError>[0])?.accessToken;
      await deleteApp(app).catch(() => undefined);
      if (token) return token;
    } else {
      await deleteApp(app).catch(() => undefined);
    }
    throw new CloudError("invalid", sentenceFor(errorCode(error)));
  }

  const token = GithubAuthProvider.credentialFromResult(result)?.accessToken;
  try {
    if (getAdditionalUserInfo(result)?.isNewUser === true) await deleteUser(result.user);
    else await signOut(auth);
  } catch {
    // The token is already in hand. A Firebase user left behind here has no Zenith profile, so
    // nothing in Firestore names it and it can sign in to nothing it could not before.
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
  if (!token) throw new CloudError("invalid", "GitHub did not send a token. Try again, or paste a token instead.");
  return token;
}
