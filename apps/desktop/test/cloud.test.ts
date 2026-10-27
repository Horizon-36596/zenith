import { describe, expect, it } from "vitest";
import {
  APP_CHECK_SOURCES,
  AUTH_WINDOW_WEB_PREFERENCES,
  FIREBASE_CONNECT_ORIGINS,
  appCheckOn,
  GAPI_ORIGIN,
  cloudHostsFrom,
  isAuthHandlerUrl,
  isAuthWindowUrl,
  type CloudHosts,
} from "../src/main/cloud.js";
import { PRODUCTION_CSP, buildCsp, devCsp } from "../src/main/security.js";

const CONFIG = JSON.stringify({
  apiKey: "example-api-key",
  authDomain: "example-project.firebaseapp.com",
  projectId: "example-project",
  appId: "1:0:web:0",
});
const CLOUD: CloudHosts = { authDomain: "example-project.firebaseapp.com", appCheck: false };
const SITE_KEY = "6LcExampleSiteKeyForTests0000000000000000";
/** Written apart so a URL with a user name in it is not mistaken for an email address by the scrub check. */
const AT = "@";
const HANDLER = "https://example-project.firebaseapp.com/__/auth/handler?apiKey=example-api-key&appName=%5BDEFAULT%5D&authType=signInViaPopup&providerId=github.com&v=12.19.0";

/** One directive's sources, in order, from a policy string. */
function directive(policy: string, name: string): string[] {
  const part = policy.split("; ").find((p) => p.startsWith(`${name} `));
  if (part === undefined) throw new Error(`no ${name} in ${policy}`);
  return part.split(" ").slice(1);
}

describe("the Firebase config the build was given", () => {
  it("turns the cloud on by the web app's own rule: an object with apiKey and projectId strings", () => {
    // The same cases, with the same answers, as apps/web's parseFirebaseConfig, so the page and the
    // policy always agree about whether the cloud is on. (The web module reads the page's window and
    // Vite's env, which this node-only package cannot type-check, so the rule is pinned here instead.)
    const on = [CONFIG, JSON.stringify({ apiKey: "k", projectId: "p" })];
    const off = ["", "   ", "not json", "[]", "null", "42", JSON.stringify({ apiKey: "k" }), JSON.stringify({ projectId: "p" }), JSON.stringify({ apiKey: 1, projectId: "p" })];
    for (const json of on) expect(cloudHostsFrom(json), json).not.toBeNull();
    for (const json of off) expect(cloudHostsFrom(json), json).toBeNull();
    expect(cloudHostsFrom(undefined)).toBeNull();
    expect(cloudHostsFrom(null)).toBeNull();
  });

  it("keeps the auth domain only when it is a plain host name", () => {
    expect(cloudHostsFrom(CONFIG)).toEqual(CLOUD);
    const withDomain = (authDomain: unknown) => cloudHostsFrom(JSON.stringify({ apiKey: "k", projectId: "p", authDomain }));
    expect(withDomain("Example-Project.FirebaseApp.com")).toEqual(CLOUD);
    expect(withDomain(undefined)).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain(42)).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain("https://example-project.firebaseapp.com")).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain("example-project.firebaseapp.com/path")).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain("*.firebaseapp.com")).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain("example.com 'unsafe-inline'")).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain("example.com; script-src *")).toEqual({ authDomain: null, appCheck: false });
    expect(withDomain("localhost")).toEqual({ authDomain: null, appCheck: false });
  });
});

describe("the Content-Security-Policy", () => {
  it("is as strict as before the cloud when the build has no Firebase config", () => {
    const off = buildCsp({ devOrigin: null, cloud: cloudHostsFrom("") });
    expect(off).toBe(PRODUCTION_CSP);
    expect(directive(off, "script-src")).toEqual(["'self'"]);
    expect(directive(off, "connect-src")).toEqual(["'self'", "https://api.github.com"]);
    expect(directive(off, "frame-src")).toEqual(["'none'"]);
    expect(off).not.toContain("googleapis");
    expect(off).not.toContain("firebaseapp");
  });

  it("adds exactly the cloud's REST hosts in the built app, which signs in through the browser", () => {
    const on = buildCsp({ devOrigin: null, cloud: CLOUD });
    expect(directive(on, "connect-src")).toEqual([
      "'self'",
      "https://api.github.com",
      "https://identitytoolkit.googleapis.com",
      "https://securetoken.googleapis.com",
      "https://firestore.googleapis.com",
    ]);
    // No popup in the built app (ADR 0011), so no script loader and no frame.
    expect(directive(on, "script-src")).toEqual(["'self'"]);
    expect(directive(on, "frame-src")).toEqual(["'none'"]);
    expect(on).not.toContain(GAPI_ORIGIN);
    expect(on).not.toContain("firebaseapp");
    // Everything else is the strict policy, unchanged.
    for (const name of ["default-src", "style-src", "img-src", "font-src", "worker-src", "object-src", "base-uri", "form-action", "frame-ancestors"]) {
      expect(directive(on, name), name).toEqual(directive(PRODUCTION_CSP, name));
    }
    expect(on).not.toContain("*");
    expect(on).not.toContain("'unsafe-eval'");
  });

  it("opens the data hosts but no frame or remote script when the config names no auth domain", () => {
    const policy = buildCsp({ devOrigin: null, cloud: { authDomain: null, appCheck: false } });
    expect(directive(policy, "connect-src")).toEqual(["'self'", "https://api.github.com", ...FIREBASE_CONNECT_ORIGINS]);
    expect(directive(policy, "script-src")).toEqual(["'self'"]);
    expect(directive(policy, "frame-src")).toEqual(["'none'"]);
  });

  it("keeps the popup's script loader and frame in a development run only, whose page is on localhost", () => {
    const dev = devCsp("http://localhost:5190");
    expect(directive(dev, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(dev, "connect-src")).toEqual(["'self'", "https://api.github.com", "ws://localhost:5190"]);
    expect(directive(dev, "frame-src")).toEqual(["'none'"]);
    const devCloud = devCsp("http://localhost:5190", CLOUD);
    expect(directive(devCloud, "script-src")).toEqual(["'self'", "'unsafe-inline'", GAPI_ORIGIN]);
    expect(directive(devCloud, "connect-src")).toEqual(["'self'", "https://api.github.com", ...FIREBASE_CONNECT_ORIGINS, "ws://localhost:5190"]);
    expect(directive(devCloud, "frame-src")).toEqual(["https://example-project.firebaseapp.com"]);
  });
});

describe("App Check's hosts in the policy", () => {
  it("turn on by the web app's own rule for the site key: not blank, no white space", () => {
    expect(appCheckOn(SITE_KEY)).toBe(true);
    expect(appCheckOn(`  ${SITE_KEY}  `)).toBe(true);
    for (const key of [undefined, null, "", "   ", "two words", "key\nnext"]) expect(appCheckOn(key), String(key)).toBe(false);
    expect(cloudHostsFrom(CONFIG, SITE_KEY)).toEqual({ ...CLOUD, appCheck: true });
    expect(cloudHostsFrom(CONFIG, "")).toEqual(CLOUD);
    expect(cloudHostsFrom(CONFIG)).toEqual(CLOUD);
    // A site key with no Firebase config leaves the cloud, and so App Check, off.
    expect(cloudHostsFrom("", SITE_KEY)).toBeNull();
  });

  it("are not let through without a site key, in the built app or a development run", () => {
    for (const policy of [buildCsp({ devOrigin: null, cloud: CLOUD }), devCsp("http://localhost:5190", CLOUD)]) {
      expect(policy).not.toContain("recaptcha");
      expect(policy).not.toContain("gstatic");
      expect(policy).not.toContain("firebaseappcheck");
      expect(policy).not.toContain("www.google.com");
    }
  });

  it("add exactly reCAPTCHA Enterprise's script, frame and calls and App Check's exchange with a site key", () => {
    const on = buildCsp({ devOrigin: null, cloud: { ...CLOUD, appCheck: true } });
    expect(directive(on, "script-src")).toEqual(["'self'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"]);
    expect(directive(on, "frame-src")).toEqual(["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"]);
    expect(directive(on, "connect-src")).toEqual([
      "'self'",
      "https://api.github.com",
      ...FIREBASE_CONNECT_ORIGINS,
      "https://www.google.com/recaptcha/",
      "https://content-firebaseappcheck.googleapis.com",
    ]);
    // Each www.google.com source is limited to the reCAPTCHA path; no bare host is let through.
    for (const name of ["script-src", "frame-src", "connect-src"]) {
      for (const source of directive(on, name)) {
        if (source.includes("google.com") || source.includes("gstatic.com")) expect(source, `${name} ${source}`).toMatch(/\/recaptcha\/$/);
      }
    }
    // Still no popup pieces in the built app, and everything else is the strict policy.
    expect(on).not.toContain(GAPI_ORIGIN);
    expect(on).not.toContain("firebaseapp.com");
    for (const name of ["default-src", "style-src", "img-src", "font-src", "worker-src", "object-src", "base-uri", "form-action", "frame-ancestors"]) {
      expect(directive(on, name), name).toEqual(directive(PRODUCTION_CSP, name));
    }
    expect(on).not.toContain("*");
    expect(on).not.toContain("'unsafe-eval'");
  });

  it("sit beside the popup's pieces in a development run", () => {
    const dev = devCsp("http://localhost:5190", { ...CLOUD, appCheck: true });
    expect(directive(dev, "script-src")).toEqual(["'self'", "'unsafe-inline'", GAPI_ORIGIN, ...APP_CHECK_SOURCES.script]);
    expect(directive(dev, "frame-src")).toEqual(["https://example-project.firebaseapp.com", ...APP_CHECK_SOURCES.frame]);
    expect(directive(dev, "connect-src")).toEqual([
      "'self'",
      "https://api.github.com",
      ...FIREBASE_CONNECT_ORIGINS,
      ...APP_CHECK_SOURCES.connect,
      "ws://localhost:5190",
    ]);
  });

  it("match the hosts the pinned App Check SDK names in its source", async () => {
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // firebase 12.19.0, the cloud package's pin, resolves @firebase/app-check; its bundle holds both
    // addresses as constants.
    const cloudPackage = fileURLToPath(new URL("../../../packages/cloud/package.json", import.meta.url));
    const firebaseDir = dirname(createRequire(cloudPackage).resolve("firebase/package.json"));
    const appCheckEntry = createRequire(`${firebaseDir}/package.json`).resolve("@firebase/app-check");
    const source = readFileSync(appCheckEntry, "utf8");
    expect(source).toContain("'https://content-firebaseappcheck.googleapis.com/v1'");
    expect(source).toContain("'https://www.google.com/recaptcha/enterprise.js'");
  });
});

describe("the sign-in window, which only a development run opens", () => {
  it("opens only for Firebase Auth's handler on the configured auth domain", () => {
    expect(isAuthHandlerUrl(HANDLER, CLOUD)).toBe(true);
    expect(isAuthHandlerUrl("https://example-project.firebaseapp.com/__/auth/handler", CLOUD)).toBe(true);
  });

  it("stays shut with no cloud, or with a cloud that names no auth domain", () => {
    expect(isAuthHandlerUrl(HANDLER, null)).toBe(false);
    expect(isAuthHandlerUrl(HANDLER, cloudHostsFrom(""))).toBe(false);
    expect(isAuthHandlerUrl(HANDLER, { authDomain: null, appCheck: false })).toBe(false);
  });

  it("refuses other paths, other origins and look-alike hosts", () => {
    const refused = [
      // Another page on the auth domain.
      "https://example-project.firebaseapp.com/",
      "https://example-project.firebaseapp.com/__/auth/iframe",
      "https://example-project.firebaseapp.com/__/auth/handler/../../evil",
      // Not https, another port, or with credentials in the address.
      "http://example-project.firebaseapp.com/__/auth/handler",
      "https://example-project.firebaseapp.com:8443/__/auth/handler",
      `https://user:pass${AT}example-project.firebaseapp.com/__/auth/handler`,
      // Look-alike hosts.
      "https://evil-firebaseapp.com/__/auth/handler",
      "https://example-project-firebaseapp.com/__/auth/handler",
      "https://example-project.firebaseapp.com.evil.com/__/auth/handler",
      "https://evil.example-project.firebaseapp.com/__/auth/handler",
      `https://example-project.firebaseapp.com${AT}evil.com/__/auth/handler`,
      "https://other-project.firebaseapp.com/__/auth/handler",
      "https://evil.com/__/auth/handler?authDomain=example-project.firebaseapp.com",
      // Other schemes and nonsense.
      "javascript:alert(1)",
      "file:///C:/Windows/win.ini",
      "zenith://app/__/auth/handler",
      "not a url",
    ];
    for (const url of refused) expect(isAuthHandlerUrl(url, CLOUD), url).toBe(false);
  });

  it("may show the auth domain and the providers' sign-in pages, and nothing else", () => {
    const allowed = [
      HANDLER,
      "https://github.com/login/oauth/authorize?client_id=x",
      "https://github.com/login",
      "https://github.com/sessions/two-factor",
      "https://accounts.google.com/o/oauth2/auth?client_id=x",
      "https://accounts.youtube.com/accounts/SetSID",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://login.live.com/oauth20_authorize.srf",
      "https://account.live.com/",
    ];
    for (const url of allowed) expect(isAuthWindowUrl(url, CLOUD), url).toBe(true);
    const refused = [
      "https://evil-firebaseapp.com/",
      "https://github.com.evil.com/login",
      "https://evilgithub.com/login",
      "https://gist.github.com/",
      "https://raw.githubusercontent.com/x",
      "https://accounts.google.com.evil.com/",
      "https://www.google.com/",
      "https://evil.microsoftonline.com/",
      "http://github.com/login",
      "https://github.com:444/login",
      `https://user${AT}github.com/login`,
      "zenith://app/",
    ];
    for (const url of refused) expect(isAuthWindowUrl(url, CLOUD), url).toBe(false);
    expect(isAuthWindowUrl("https://github.com/login", null)).toBe(false);
    expect(isAuthWindowUrl("https://github.com/login", { authDomain: null, appCheck: false })).toBe(false);
  });

  it("gets no preload and no Node, with context isolation and the sandbox on", () => {
    expect(AUTH_WINDOW_WEB_PREFERENCES).not.toHaveProperty("preload");
    expect(AUTH_WINDOW_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
});
