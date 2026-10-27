/**
 * Which cloud, if any, this page talks to (spec 13 section 1: accounts are
 * optional and everything works without one).
 *
 * - `fake`: `?cloud=fake` in the address, or `localStorage["zenith.cloudFake"] = "on"`, in a
 *   development build only (the dev server, and the tests and end-to-end specs that run on it). The
 *   account, sharing and the verification UI then all run on one in-memory `MemoryBackend`, which
 *   runs the cloud's real permission rules and nothing leaves the page. A release build ignores
 *   both switches (owner ruling 2026-09-30), so nobody reaches the sharing screens before the real
 *   cloud is switched on.
 * - `firebase`: the build was given a Firebase web config in `VITE_ZENITH_FIREBASE_CONFIG`, as JSON
 *   (cloud/README.md step 3; the config is not a secret).
 * - `off`: neither. Every cloud control stays hidden, and the app is exactly what it is without
 *   accounts.
 */
export type CloudMode = "off" | "fake" | "firebase";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  appId?: string;
  [key: string]: unknown;
}

/**
 * Firebase App Check (spec 13 section 13): every request carries a token that says it came from the
 * real app, so once enforcement is on in the console nobody else can use up the free quota. Zenith
 * uses the reCAPTCHA Enterprise provider, which Firebase recommends for new apps and which works on the
 * no-cost Spark plan (cloud/README.md step 7). Off unless the build sets a site key.
 */
export interface AppCheckConfig {
  provider: "recaptcha-enterprise";
  /** The reCAPTCHA Enterprise site key from the console. Public, like the Firebase config. */
  siteKey: string;
}

export interface CloudConfig {
  mode: CloudMode;
  firebase: FirebaseWebConfig | null;
  /** App Check for the real cloud, or null when the build set no site key. Never used by the fake. */
  appCheck: AppCheckConfig | null;
}

/** Reads `VITE_ZENITH_APPCHECK_SITE_KEY`. Empty or blank means App Check stays off. */
export function parseAppCheckSiteKey(value: string | undefined | null): AppCheckConfig | null {
  const siteKey = value?.trim() ?? "";
  if (siteKey === "" || /\s/.test(siteKey)) return null;
  return { provider: "recaptcha-enterprise", siteKey };
}

/** The fake switch in browser storage, which lasts across reloads. */
export const FAKE_FLAG_KEY = "zenith.cloudFake";

/**
 * Reads the Firebase config JSON. Anything that is not an object with `apiKey` and `projectId`
 * strings is treated as absent, so a half-set variable leaves the cloud off rather than broken.
 */
export function parseFirebaseConfig(json: string | undefined | null): FirebaseWebConfig | null {
  if (json === undefined || json === null || json.trim() === "") return null;
  try {
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.apiKey !== "string" || typeof record.projectId !== "string") return null;
    return record as FirebaseWebConfig;
  } catch {
    return null;
  }
}

/**
 * Decides the mode from what the page can see. `allowFake` is true only in a development build;
 * there the fake wins, so a developer can try it anywhere. Anywhere else `?cloud=fake` and the
 * stored switch do nothing.
 */
export function cloudConfigFrom(input: {
  search: string;
  fakeFlag: string | null;
  firebaseJson: string | undefined | null;
  appCheckSiteKey?: string | undefined | null;
  allowFake: boolean;
}): CloudConfig {
  const firebase = parseFirebaseConfig(input.firebaseJson);
  const fake = input.allowFake && (new URLSearchParams(input.search).get("cloud") === "fake" || input.fakeFlag === "on");
  if (fake) return { mode: "fake", firebase, appCheck: null };
  if (firebase !== null) return { mode: "firebase", firebase, appCheck: parseAppCheckSiteKey(input.appCheckSiteKey) };
  return { mode: "off", firebase: null, appCheck: null };
}

let cached: CloudConfig | null = null;

/** This page's cloud config, read once. Off in node and anywhere without a window. */
export function currentCloudConfig(): CloudConfig {
  if (cached !== null) return cached;
  if (typeof window === "undefined") {
    cached = { mode: "off", firebase: null, appCheck: null };
    return cached;
  }
  // Written on import.meta.env.DEV so a release build never reads the switch at all.
  const allowFake = import.meta.env.DEV;
  let fakeFlag: string | null = null;
  if (allowFake) {
    try {
      fakeFlag = window.localStorage.getItem(FAKE_FLAG_KEY);
    } catch {
      fakeFlag = null;
    }
  }
  cached = cloudConfigFrom({
    allowFake,
    search: window.location.search,
    fakeFlag,
    firebaseJson: import.meta.env.VITE_ZENITH_FIREBASE_CONFIG,
    appCheckSiteKey: import.meta.env.VITE_ZENITH_APPCHECK_SITE_KEY,
  });
  return cached;
}

/**
 * Whether sign-in by email link is offered (spec 13 section 4.1). Off with the real cloud unless the
 * build sets `VITE_ZENITH_EMAIL_LINK=on`, because Firebase's no-cost Spark plan sends at most 5
 * sign-in emails a day for the whole project; the in-memory fake sends none, so it keeps the option.
 */
export function emailLinkEnabledFor(mode: CloudMode, flag: string | undefined): boolean {
  if (mode === "fake") return true;
  if (mode === "firebase") return flag === "on";
  return false;
}

export const emailLinkEnabled = (): boolean =>
  emailLinkEnabledFor(currentCloudConfig().mode, import.meta.env.VITE_ZENITH_EMAIL_LINK);

/** True when any cloud control should show. */
export const cloudEnabled = (): boolean => currentCloudConfig().mode !== "off";

/** The public site (site/mkdocs.yml `site_url`). The one place its host is written. */
const PUBLIC_SITE_URL = "https://libraries.horizon36596.org/zenith/";

function withTrailingSlash(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return PUBLIC_SITE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Where the docs are: the public site, or whatever `VITE_DOCS_URL` names at build time (for
 * example `/docs/` for a build that serves its own copy). Always ends in a slash.
 */
export const DOCS_URL: string = withTrailingSlash(import.meta.env.VITE_DOCS_URL ?? PUBLIC_SITE_URL);

/**
 * A page of the docs, with an optional anchor: `docsLink("editor/#keyboard-reference")`. With no
 * path it is the docs' front page.
 */
export const docsLink = (path = "", base: string = DOCS_URL): string => `${base}${path.replace(/^\/+/, "")}`;

/**
 * The one-page guide a teacher hands a school's Google Workspace admin to approve Zenith (spec 13
 * section 4.1), on the docs site (page `school-admin-guide`).
 */
export const SCHOOL_GUIDE_URL = docsLink("school-admin-guide/");

/** The terms of use on the docs site (page `terms`), which say who may have an account. */
export const TERMS_URL = docsLink("terms/");

/** The command libraries guide on the docs site, linked from Settings. */
export const LIBRARIES_DOC = docsLink("command-libraries/");

/**
 * The public web app, on its own domain (Vercel, deployed from the public repository's main). Links
 * the desktop app hands out point here (sweep D12): its own page is `zenith://app/`, which no one
 * else can open. The same build also stays on the docs site at `/zenith/app/` (build-pages.mjs), but
 * people are sent here.
 */
export const PUBLIC_APP_URL = "https://zenith.horizon36596.org/";

/** True for a page on the web (http or https), false for the desktop app's `zenith://` page. */
export const isWebPage = (pageUrl: string): boolean => /^https?:/i.test(pageUrl.trim());

/**
 * The address a link someone else will open starts from: the page's own on the web, so a test
 * build's links stay on that build, and the public web app in the desktop app.
 */
export const linkPageUrl = (pageUrl: string): string => (isWebPage(pageUrl) ? pageUrl : PUBLIC_APP_URL);
