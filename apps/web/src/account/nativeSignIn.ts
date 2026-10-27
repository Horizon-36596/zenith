/**
 * How the page signs in with each provider (spec 13 section 4.1, ADR 0011).
 *
 * In a browser, Firebase's popup. In the desktop app, whose built page is on `zenith://app`, the
 * popup cannot work (Firebase accepts it only from an http or https page), so the desktop app runs
 * the sign-in in the system browser and hands back the provider's credential, which the page gives
 * to Firebase's `signInWithCredential`. A provider the desktop build has no OAuth client for is
 * hidden there, with one line saying why; a development run of the desktop app, whose page is the
 * dev server on `http://localhost`, falls back to the popup for such a provider instead. Delete my
 * account signs the account in again the same way, with the account's own provider.
 *
 * No DOM here: the model takes the bridge's sign-in half through `AccountDeps.nativeSignIn`, and the
 * page's address through `AccountDeps.pageUrl`, so the choice is tested in node.
 */
import type { SignInProvider } from "@horizon36596/zenith-cloud";
import type { CloudMode } from "./config";
import type {
  DesktopSignInCredential,
  DesktopSignInProgress,
  DesktopSignInProviders,
  ZenithDesktopBridge,
} from "../project/desktopBridge";

/** The desktop bridge's sign-in half (`window.zenithDesktop.cloudSignIn`). */
export type NativeSignInPort = ZenithDesktopBridge["cloudSignIn"];

export type { DesktopSignInCredential, DesktopSignInProgress, DesktopSignInProviders };

export type SignInRoute =
  | { kind: "popup" }
  | { kind: "native" }
  | {
      kind: "unavailable";
      /** One sentence, shown in place of the provider's button. */
      reason: string;
    };

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ["github", "microsoft", "google"];

/** Every provider on the popup, which is what a browser page does. */
export const POPUP_ROUTES: Record<SignInProvider, SignInRoute> = {
  github: { kind: "popup" },
  microsoft: { kind: "popup" },
  google: { kind: "popup" },
};

const onWebAddress = (pageUrl: string): boolean => {
  try {
    const protocol = new URL(pageUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Chooses each provider's route.
 * - The fake cloud, or no desktop bridge: the popup (the fake's popup signs in at once).
 * - The desktop app with the real cloud: the system browser where the build has that provider's
 *   client; otherwise the popup when the page is on a web address (a development run), and
 *   otherwise the provider is unavailable, with the desktop app's reason.
 */
export function chooseSignInRoutes(input: {
  mode: CloudMode;
  /** The desktop app's answer to `cloudSignIn.providers()`, or null when there is no desktop bridge. */
  native: DesktopSignInProviders | null;
  pageUrl: string;
}): Record<SignInProvider, SignInRoute> {
  const { mode, native, pageUrl } = input;
  if (mode !== "firebase" || native === null) return POPUP_ROUTES;
  const route = (provider: SignInProvider): SignInRoute => {
    const availability = native[provider];
    if (availability.available) return { kind: "native" };
    if (onWebAddress(pageUrl)) return { kind: "popup" };
    return { kind: "unavailable", reason: availability.reason ?? "This way to sign in is off in this build of the desktop app." };
  };
  return { github: route("github"), microsoft: route("microsoft"), google: route("google") };
}

/**
 * The provider the signed-in account signs in again with to delete it: the first of its sign-in
 * methods that is one of the three, as the cloud backend picks it. Null for an email-link account.
 */
export function accountSignInProvider(providerIds: readonly string[]): SignInProvider | null {
  for (const id of providerIds) {
    if (id === "github.com") return "github";
    if (id === "google.com") return "google";
    if (id === "microsoft.com") return "microsoft";
  }
  return null;
}
