/**
 * "Sign in with GitHub" for GitHub mode (site/docs/github.md): a GitHub OAuth token with the `repo`
 * scope, so nobody has to make a token by hand. The pasted fine-grained token stays as the other way,
 * for anyone who wants access to one repository only.
 *
 * - In a browser, Firebase's GitHub popup, which keeps the OAuth app's client secret a static page
 *   cannot (`githubRepoToken` in the cloud package). It needs the build's Firebase config.
 * - In the desktop app, GitHub's device flow in the main process, which needs only the build's GitHub
 *   client id (ADR 0011). A development run, whose page is on `http://localhost`, can use the popup.
 * - The development fake cloud hands back `FAKE_OAUTH_TOKEN`, so the end-to-end specs can run the
 *   whole flow against a stubbed api.github.com. A release build never takes that branch.
 */
import { currentCloudConfig, isWebPage } from "../account/config";
import { desktopBridge } from "../project/desktop";

export type OAuthRoute =
  | { kind: "popup" }
  | { kind: "device" }
  | {
      kind: "unavailable";
      /** One sentence, shown in place of the button. */
      reason: string;
    };

/** The development fake cloud's GitHub token. Only a development build ever hands it out. */
export const FAKE_OAUTH_TOKEN = "gho_zenithDevelopmentFakeToken";

const NO_SERVICE = "Sign in with GitHub is not available in this build. Paste a token instead.";

/** Decides the route from what the page can see; kept free of the DOM so it is tested in node. */
export function chooseOAuthRoute(input: {
  cloudMode: "off" | "fake" | "firebase";
  /** The desktop app's answer to `github.oauthAvailability()`, or null without a desktop bridge. */
  desktop: { available: boolean; reason: string | null } | null;
  pageUrl: string;
}): OAuthRoute {
  const popupWorks = input.cloudMode !== "off" && isWebPage(input.pageUrl);
  if (input.desktop !== null) {
    if (input.desktop.available) return { kind: "device" };
    if (popupWorks) return { kind: "popup" };
    return { kind: "unavailable", reason: input.desktop.reason ?? NO_SERVICE };
  }
  return popupWorks ? { kind: "popup" } : { kind: "unavailable", reason: NO_SERVICE };
}

/** This page's route. An older desktop build without `oauthAvailability` counts as unavailable there. */
export async function readOAuthRoute(): Promise<OAuthRoute> {
  const github = desktopBridge()?.github;
  let desktop: { available: boolean; reason: string | null } | null = null;
  if (github !== undefined) {
    desktop =
      github.oauthAvailability === undefined || github.oauthToken === undefined
        ? { available: false, reason: "Sign in with GitHub needs a newer Zenith desktop app. Paste a token instead." }
        : await github.oauthAvailability().catch(() => ({ available: false, reason: NO_SERVICE }));
  }
  return chooseOAuthRoute({ cloudMode: currentCloudConfig().mode, desktop, pageUrl: window.location.href });
}

/** Runs the route's sign-in and resolves with GitHub's token. Rejects with a sentence for the dialog. */
export async function oauthToken(route: OAuthRoute): Promise<string> {
  if (route.kind === "unavailable") throw new Error(route.reason);
  if (route.kind === "device") {
    const start = desktopBridge()?.github.oauthToken;
    if (start === undefined) throw new Error(NO_SERVICE);
    return start();
  }
  const config = currentCloudConfig();
  // Written as one condition on import.meta.env.DEV so a production build folds the fake away.
  if (import.meta.env.DEV && config.mode === "fake") return FAKE_OAUTH_TOKEN;
  if (config.firebase === null) throw new Error(NO_SERVICE);
  const cloud = await import("@horizon36596/zenith-cloud");
  return cloud.githubRepoToken(config.firebase);
}

/** Stops a device-flow sign-in that is waiting on GitHub. The popup is closed by the person. */
export async function cancelOAuth(): Promise<void> {
  await desktopBridge()?.cloudSignIn.cancel().catch(() => undefined);
}
