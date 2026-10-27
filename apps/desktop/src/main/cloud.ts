/**
 * What the optional cloud (Firebase Authentication and Cloud Firestore, reached straight from the
 * page) needs the desktop app to let through, and nothing more.
 *
 * The cloud is on only when the build was given a Firebase web config, the same JSON the web build
 * reads from `VITE_ZENITH_FIREBASE_CONFIG`. `scripts/build.mjs` reads it with Vite's own env loader
 * from apps/web, so the main process and the page it serves always agree, and bakes it into the
 * bundle as `__ZENITH_FIREBASE_CONFIG__`. With no config, `cloudHostsFrom` returns null and the
 * policy and the window rules are exactly as strict as they are without this file.
 *
 * Where the host list comes from. Firebase's documentation site could not be reached from the
 * environment this was written in, so every host below was read from the source of the pinned SDK
 * itself (firebase 12.19.0, which brings Firebase Auth 1.13.6 and Cloud Firestore 4.17.2), both the
 * installed bundles and the firebase-js-sdk repository at the tag for that release:
 *
 * - Auth's default configuration names its REST host, identitytoolkit.googleapis.com, and its token
 *   host, securetoken.googleapis.com. No other googleapis host appears in the Auth bundle; the
 *   www.googleapis.com host older SDKs used is not contacted by this one.
 * - Firestore's default host is firestore.googleapis.com. Its streaming transport (WebChannel, and
 *   the long-polling fallback of the same transport) talks to that same host, at
 *   `/google.firestore.v1.Firestore/<method>/channel`, so it needs no host of its own.
 * - `signInWithPopup` loads Google's script loader from apis.google.com as a script element, opens a
 *   hidden frame at `https://<authDomain>/__/auth/iframe`, and opens the popup at
 *   `https://<authDomain>/__/auth/handler?...`, which then sends the user to the provider's own
 *   sign-in page and back.
 * - App Check. The page turns it on only when the build was given a reCAPTCHA Enterprise site key
 *   (`VITE_ZENITH_APPCHECK_SITE_KEY`), and only then does the policy let its hosts through. App
 *   Check's own source names two things: the reCAPTCHA Enterprise loader,
 *   `https://www.google.com/recaptcha/enterprise.js?render=explicit`, added as a script element, and
 *   the token exchange, a `fetch` to `https://content-firebaseappcheck.googleapis.com/v1/...`
 *   (`exchangeRecaptchaEnterpriseToken`). The loader then pulls its release script from
 *   www.gstatic.com under `/recaptcha/`, renders an invisible widget in a frame on www.google.com or
 *   recaptcha.google.com under `/recaptcha/`, and calls back to www.google.com under `/recaptcha/`;
 *   those three are Google's own list for a page with a Content-Security-Policy (the reCAPTCHA
 *   frequently asked questions, "Can I use reCAPTCHA with Content Security Policy"). So, with a site
 *   key: script-src gains www.google.com/recaptcha/ and www.gstatic.com/recaptcha/, frame-src gains
 *   www.google.com/recaptcha/ and recaptcha.google.com/recaptcha/, and connect-src gains
 *   www.google.com/recaptcha/ and the App Check exchange host. Each is limited to its path, so
 *   nothing else on www.google.com is let through.
 *
 *   Letting the hosts through does not make App Check work in the built app. A reCAPTCHA web key is
 *   for website domains, and the built app's page is `zenith://app`, which is not one, so the
 *   widget's domain check is expected to refuse it and the page gets no App Check token. The only way
 *   round the check, a key that allows every domain, leaves checking the token's host name to the
 *   site's own server, which Zenith does not have, so the key would then attest any page anywhere.
 *   While App Check is not enforced, requests without a token still reach the cloud. Once the owner
 *   enforces it, the desktop app's cloud stops working (cloud/README.md, step 7, and ADR 0011).
 *
 * Signing in. The built app's page is `zenith://app`, and Firebase Auth's popup accepts only a page on
 * an http or https address, so the built app signs in through the system browser instead
 * (nativeSignIn.ts, ADR 0011) and hands the result to `signInWithCredential`, which is a plain call to
 * the Auth REST host above. The built app therefore opens no sign-in window, loads no remote script and
 * allows no frame. Only a development run, whose page is the Vite dev server on `http://localhost`,
 * keeps the popup: its policy adds Google's script loader and the auth domain's frame, and it may open
 * Firebase Auth's handler window, limited to the auth domain and the providers' sign-in pages.
 */

/** The cloud as the desktop app sees it: the auth domain, when the config names a usable one. */
export interface CloudHosts {
  /** The config's `authDomain` host, such as `example-project.firebaseapp.com`, lower case; or null. */
  authDomain: string | null;
  /** True when the build was also given an App Check site key, so the page turns App Check on. */
  appCheck: boolean;
}

/** The REST and streaming hosts the page's `fetch` and XHR calls reach (connect-src). */
export const FIREBASE_CONNECT_ORIGINS: readonly string[] = [
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://firestore.googleapis.com",
];

/**
 * What App Check with the reCAPTCHA Enterprise provider needs, by directive, when the build has a site
 * key (see the top of this file for where each one comes from). A source ending in `/` matches that
 * path and everything under it, and nothing else on the host.
 */
export const APP_CHECK_SOURCES = {
  /** The Enterprise loader (www.google.com) and the release script it loads (www.gstatic.com). */
  script: ["https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
  /** The invisible widget's frame, on either of the two hosts reCAPTCHA serves it from. */
  frame: ["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"],
  /** reCAPTCHA's own calls back to Google, and App Check's token exchange. */
  connect: ["https://www.google.com/recaptcha/", "https://content-firebaseappcheck.googleapis.com"],
} as const;

/** Google's script loader, which Firebase Auth loads to talk to its hidden frame (script-src). */
export const GAPI_ORIGIN = "https://apis.google.com";

/** The path of Firebase Auth's sign-in handler page on the auth domain, which the popup opens. */
export const AUTH_HANDLER_PATH = "/__/auth/handler";

/**
 * The provider pages the sign-in window may move to after the handler: GitHub's, Google's and
 * Microsoft's own sign-in pages. Each entry matches that host exactly, never its subdomains.
 */
export const PROVIDER_SIGN_IN_HOSTS: readonly string[] = [
  // GitHub: sign-in, two-factor and the OAuth consent page all live on github.com itself.
  "github.com",
  // Google: the account chooser and consent pages, and the cookie hop Google makes on sign-in.
  "accounts.google.com",
  "accounts.youtube.com",
  // Microsoft: work and school accounts, and personal Microsoft accounts.
  "login.microsoftonline.com",
  "login.live.com",
  "account.live.com",
];

/** A DNS host name of two or more labels, letters, digits and hyphens only; nothing a policy could misread. */
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Whether the build's `VITE_ZENITH_APPCHECK_SITE_KEY` turns App Check on, by the web app's own rule
 * (`parseAppCheckSiteKey`): a value that is not blank and holds no white space.
 */
export function appCheckOn(siteKey: string | undefined | null): boolean {
  const trimmed = siteKey?.trim() ?? "";
  return trimmed !== "" && !/\s/.test(trimmed);
}

/**
 * Reads the Firebase config JSON the build was given, and its App Check site key. It follows the web
 * app's rule, so the two never disagree about whether the cloud is on: anything that is not an
 * object with `apiKey` and `projectId` strings means no cloud, whatever the site key. An `authDomain`
 * that is not a plain host name is ignored, which leaves the data hosts open and the sign-in window
 * shut.
 */
export function cloudHostsFrom(json: string | undefined | null, appCheckSiteKey?: string | null): CloudHosts | null {
  if (json === undefined || json === null || json.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["apiKey"] !== "string" || typeof record["projectId"] !== "string") return null;
  const domain = typeof record["authDomain"] === "string" ? record["authDomain"].trim().toLowerCase() : "";
  return { authDomain: HOST_NAME.test(domain) ? domain : null, appCheck: appCheckOn(appCheckSiteKey) };
}

/**
 * The sources the cloud adds to each policy directive; empty lists when the cloud is off. `popup` is
 * true only in a development run, the one place Firebase's popup can work (see above). App Check's
 * sources are added only when the build has a site key.
 */
export function cloudCspSources(
  cloud: CloudHosts | null,
  options: { popup: boolean },
): { connect: string[]; script: string[]; frame: string[] } {
  if (cloud === null) return { connect: [], script: [], frame: [] };
  const authOrigin = cloud.authDomain === null || !options.popup ? [] : [`https://${cloud.authDomain}`];
  const appCheck = cloud.appCheck;
  return {
    connect: [...FIREBASE_CONNECT_ORIGINS, ...(appCheck ? APP_CHECK_SOURCES.connect : [])],
    // Without an auth domain the SDK cannot sign in with a popup, so it never loads the script loader.
    script: [...(authOrigin.length === 0 ? [] : [GAPI_ORIGIN]), ...(appCheck ? APP_CHECK_SOURCES.script : [])],
    frame: [...authOrigin, ...(appCheck ? APP_CHECK_SOURCES.frame : [])],
  };
}

/** Parses a URL that is plain https on the default port with no user name or password, or returns null. */
function plainHttps(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  return parsed;
}

/**
 * True for the one window a development run's page may open: Firebase Auth's handler on the
 * configured auth domain. index.ts passes null for `cloud` in a built app, so it opens nothing.
 * The host must be the auth domain exactly, so `evil-firebaseapp.com`, a longer name that ends in
 * it, or a name that merely contains it are all refused.
 */
export function isAuthHandlerUrl(url: string, cloud: CloudHosts | null): boolean {
  if (cloud === null || cloud.authDomain === null) return false;
  const parsed = plainHttps(url);
  return parsed !== null && parsed.hostname === cloud.authDomain && parsed.pathname === AUTH_HANDLER_PATH;
}

/**
 * True for a page the sign-in window may show: anything on the auth domain, or a provider's own
 * sign-in page. Every other address closes the window (index.ts), so it cannot become a browser.
 */
export function isAuthWindowUrl(url: string, cloud: CloudHosts | null): boolean {
  if (cloud === null || cloud.authDomain === null) return false;
  const parsed = plainHttps(url);
  if (parsed === null) return false;
  if (parsed.hostname === cloud.authDomain) return true;
  return PROVIDER_SIGN_IN_HOSTS.includes(parsed.hostname);
}

/**
 * The sign-in window's web preferences: no preload, no Node, context isolation and the sandbox on.
 * It shares the app's session, which Firebase's popup needs to hand the result back to the page.
 */
export const AUTH_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
} as const;
