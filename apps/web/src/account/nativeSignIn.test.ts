/**
 * Which way the page signs in (ADR 0011): the popup in a browser and with the fake cloud, the desktop
 * app's browser sign-in in the desktop app, and nothing, with a reason, for a provider the desktop
 * build has no client for. Delete my account signs the account in again the same way.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryBackend, type NativeCredential, type SignInProvider } from "@horizon36596/zenith-cloud";
import type { CloudMode } from "./config";
import { AccountModel } from "./model";
import {
  POPUP_ROUTES,
  accountSignInProvider,
  chooseSignInRoutes,
  type DesktopSignInProgress,
  type DesktopSignInProviders,
  type NativeSignInPort,
} from "./nativeSignIn";
import { memoryStorage } from "./storage";

const BUILT = "zenith://app/";
const DEV = "http://localhost:5190/";
const ALL_ON: DesktopSignInProviders = {
  github: { available: true, reason: null },
  microsoft: { available: true, reason: null },
  google: { available: true, reason: null },
};
const NO_GOOGLE: DesktopSignInProviders = {
  ...ALL_ON,
  google: { available: false, reason: "This build of the desktop app has no Google desktop client, so Google sign-in is off." },
};

describe("chooseSignInRoutes", () => {
  it("uses the popup in a browser, where there is no desktop bridge", () => {
    expect(chooseSignInRoutes({ mode: "firebase", native: null, pageUrl: "https://zenith.horizon36596.org/" })).toEqual(
      POPUP_ROUTES,
    );
  });

  it("uses the popup with the fake cloud, even in the desktop app", () => {
    expect(chooseSignInRoutes({ mode: "fake", native: ALL_ON, pageUrl: BUILT })).toEqual(POPUP_ROUTES);
  });

  it("uses the system browser in the desktop app for every provider the build has a client for", () => {
    expect(chooseSignInRoutes({ mode: "firebase", native: ALL_ON, pageUrl: BUILT })).toEqual({
      github: { kind: "native" },
      microsoft: { kind: "native" },
      google: { kind: "native" },
    });
  });

  it("hides a provider with no client in the built app, with the desktop app's reason", () => {
    const routes = chooseSignInRoutes({ mode: "firebase", native: NO_GOOGLE, pageUrl: BUILT });
    expect(routes.github).toEqual({ kind: "native" });
    expect(routes.google).toEqual({ kind: "unavailable", reason: NO_GOOGLE.google.reason });
  });

  it("falls back to the popup for such a provider in a development run, whose page is on localhost", () => {
    const routes = chooseSignInRoutes({ mode: "firebase", native: NO_GOOGLE, pageUrl: DEV });
    expect(routes.github).toEqual({ kind: "native" });
    expect(routes.google).toEqual({ kind: "popup" });
  });
});

/** A fake desktop bridge: records calls and answers with a credential per provider. */
function fakePort(providers: DesktopSignInProviders, progress?: DesktopSignInProgress) {
  const listeners = new Set<(p: DesktopSignInProgress) => void>();
  const started: SignInProvider[] = [];
  let cancels = 0;
  let release: (() => void) | null = null;
  const port: NativeSignInPort = {
    providers: async () => providers,
    start: async (provider) => {
      started.push(provider);
      if (progress !== undefined) for (const listener of listeners) listener(progress);
      if (release === null) await new Promise<void>((resolve) => (release = resolve));
      const credential: NativeCredential =
        provider === "github"
          ? { provider, accessToken: "gh-token" }
          : provider === "microsoft"
            ? { provider, idToken: "ms-id", rawNonce: "raw" }
            : { provider, idToken: "google-id" };
      return credential;
    },
    cancel: async () => {
      cancels += 1;
    },
    onProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    started,
    cancels: () => cancels,
    listeners: () => listeners.size,
    finish: () => {
      if (release !== null) release();
      else release = () => undefined;
    },
  };
}

function model(mode: CloudMode, pageUrl: string, port: NativeSignInPort | null) {
  const backend = new MemoryBackend();
  const native = vi.spyOn(backend, "signInWithNativeCredential");
  const popup = vi.spyOn(backend, "signInWithProvider");
  const account = new AccountModel({
    mode,
    storage: memoryStorage(),
    now: () => Date.UTC(2026, 8, 27),
    pageUrl: () => pageUrl,
    createBackend: async () => backend,
    nativeSignIn: port,
  });
  return { account, backend, native, popup };
}

/** Starts the model, which reads the desktop app's sign-in routes. */
async function ready(account: AccountModel): Promise<void> {
  await account.start();
}

describe("AccountModel.signInWith", () => {
  it("signs in through the desktop app and hands the credential to signInWithNativeCredential", async () => {
    const fake = fakePort(ALL_ON, { provider: "github", kind: "code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresInS: 900 });
    const { account, native, popup } = model("firebase", BUILT, fake.port);
    await ready(account);
    const signingIn = account.signInWith("github");
    await vi.waitFor(() => {
      expect(account.getState().nativeProgress).toMatchObject({ kind: "code", userCode: "WDJB-MJHT" });
    });
    fake.finish();
    await signingIn;
    expect(fake.started).toEqual(["github"]);
    expect(native).toHaveBeenCalledWith({ provider: "github", accessToken: "gh-token" });
    expect(popup).not.toHaveBeenCalled();
    expect(account.getState().user?.providerIds).toEqual(["github.com"]);
    // The progress listener is gone and the code is no longer shown.
    expect(account.getState().nativeProgress).toBeNull();
    expect(fake.listeners()).toBe(0);
  });

  it("uses the popup in a browser", async () => {
    const { account, native, popup } = model("firebase", "https://zenith.horizon36596.org/", null);
    await ready(account);
    await account.signInWith("google");
    expect(popup).toHaveBeenCalledWith("google");
    expect(native).not.toHaveBeenCalled();
  });

  it("uses the popup with the fake cloud in the desktop app", async () => {
    const fake = fakePort(ALL_ON);
    const { account, native, popup } = model("fake", BUILT, fake.port);
    await ready(account);
    await account.signInWith("microsoft");
    expect(popup).toHaveBeenCalledWith("microsoft");
    expect(native).not.toHaveBeenCalled();
    expect(fake.started).toEqual([]);
  });

  it("refuses a provider the desktop build has no client for, with its reason, and never opens a popup", async () => {
    const fake = fakePort(NO_GOOGLE);
    const { account, native, popup } = model("firebase", BUILT, fake.port);
    await ready(account);
    expect(account.getState().signInRoutes.google.kind).toBe("unavailable");
    await account.signInWith("google");
    expect(account.getState().error).toBe(NO_GOOGLE.google.reason);
    expect(popup).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(account.getState().user).toBeNull();
  });

  it("passes Cancel on to the desktop app", async () => {
    const fake = fakePort(ALL_ON);
    const { account } = model("firebase", BUILT, fake.port);
    await account.cancelSignIn();
    expect(fake.cancels()).toBe(1);
  });
});

describe("accountSignInProvider", () => {
  it("is the first of the account's sign-in methods that is one of the three, as the backend picks it", () => {
    expect(accountSignInProvider(["github.com"])).toBe("github");
    expect(accountSignInProvider(["emailLink", "microsoft.com", "google.com"])).toBe("microsoft");
    expect(accountSignInProvider(["google.com"])).toBe("google");
    expect(accountSignInProvider(["emailLink"])).toBeNull();
  });
});

describe("AccountModel.deleteAccount signs in again the way signing in goes", () => {
  /** Signs in with `provider` as the model would, then makes the sign-in stale, as Firebase's always is. */
  async function signedIn(account: AccountModel, backend: MemoryBackend, provider: SignInProvider, finish?: () => void) {
    await ready(account);
    const signingIn = account.signInWith(provider);
    finish?.();
    await signingIn;
    backend.setSignInStale();
  }

  it("runs the desktop sign-in for the account's own provider, showing GitHub's code, and deletes", async () => {
    const fake = fakePort(ALL_ON, { provider: "github", kind: "code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresInS: 900 });
    const { account, backend, popup } = model("firebase", BUILT, fake.port);
    fake.finish();
    await signedIn(account, backend, "github");
    const deletes = vi.spyOn(backend, "deleteAccount");
    const progress: unknown[] = [];
    account.subscribe(() => progress.push(account.getState().nativeProgress));
    expect(await account.deleteAccount()).toBe(true);
    expect(fake.started).toEqual(["github", "github"]);
    expect(deletes.mock.calls[0]?.[0]?.reauthenticate).toBeTypeOf("function");
    expect(progress).toContainEqual(expect.objectContaining({ kind: "code", userCode: "WDJB-MJHT" }));
    expect(account.getState().nativeProgress).toBeNull();
    expect(popup).not.toHaveBeenCalled();
    expect(backend.currentUser()).toBeNull();
    expect(account.getState().user).toBeNull();
  });

  it("uses the popup in a browser", async () => {
    const { account, backend } = model("firebase", "https://zenith.horizon36596.org/", null);
    await signedIn(account, backend, "google");
    const deletes = vi.spyOn(backend, "deleteAccount");
    expect(await account.deleteAccount()).toBe(true);
    expect(deletes).toHaveBeenCalledWith({});
    expect(backend.reauthentications).toBe(1);
  });

  it("uses the popup for a provider with no client in a development run, as signing in does", async () => {
    const fake = fakePort(NO_GOOGLE);
    const { account, backend } = model("firebase", DEV, fake.port);
    await signedIn(account, backend, "google");
    const deletes = vi.spyOn(backend, "deleteAccount");
    expect(await account.deleteAccount()).toBe(true);
    expect(deletes).toHaveBeenCalledWith({});
    expect(fake.started).toEqual([]);
  });

  it("deletes nothing when the desktop sign-in is cancelled, and says so", async () => {
    const fake = fakePort(ALL_ON);
    const { account, backend } = model("firebase", BUILT, fake.port);
    fake.finish();
    await signedIn(account, backend, "microsoft");
    fake.port.start = async () => {
      throw new Error("Sign-in was cancelled.");
    };
    expect(await account.deleteAccount()).toBe(false);
    expect(account.getState().error).toMatch(/Nothing was deleted/);
    expect(backend.currentUser()?.providerIds).toEqual(["microsoft.com"]);
    expect(account.getState().user).not.toBeNull();
  });

  it("deletes nothing for a provider the desktop build has no client for, and says why", async () => {
    const fake = fakePort(NO_GOOGLE);
    const { account, backend } = model("firebase", BUILT, fake.port);
    // A Google account whose session this computer kept, in a build that has no Google client.
    backend.signInAs("memory-google-user", { providerIds: ["google.com"] });
    await ready(account);
    backend.setSignInStale();
    const deletes = vi.spyOn(backend, "deleteAccount");
    expect(await account.deleteAccount()).toBe(false);
    expect(account.getState().error).toBe(
      `${NO_GOOGLE.google.reason ?? ""} Nothing was deleted: deleting your account needs you to sign in again with it first, so delete it from Zenith in a web browser instead.`,
    );
    expect(deletes).not.toHaveBeenCalled();
    expect(fake.started).toEqual([]);
    expect(backend.currentUser()?.providerIds).toEqual(["google.com"]);
  });
});
