/**
 * Makes the page's `CloudBackend`. The cloud package, and the Firebase SDK inside it, is imported
 * here and only here, dynamically, so a page with the cloud off never downloads either.
 *
 * A development build makes the same two backends with their reads counted by screen
 * (`cloud/devReadsBackend.ts`, spec 13 section 7.2). The import sits behind `import.meta.env.DEV`, so a
 * production bundle has neither the counter nor the subclasses.
 *
 * Keys (spec 14): the real cloud keeps this device's private keys in IndexedDB, and the team keys it
 * has seen (its trust-on-first-use pins) in `localStorage`, so both last between visits. On a shared
 * computer both stay in memory and are gone when the page closes, as the offline cache is. The fake
 * cloud forgets everything on reload, so its keys and pins are in memory too.
 *
 * The page asks for `persistence` from the device choice made at sign-in (`SharedComputerChoice`):
 * "This is a shared computer" makes it false, and the Firebase backend is then made without its
 * IndexedDB cache, with device keys in memory (the cloud package's default without persistence) and
 * pins in memory. A choice changed while signed out makes a new backend (`AccountModel.setSharedComputer`).
 */
import type { CloudBackend } from "@horizon36596/zenith-cloud";
import type { CloudConfig } from "./config";

const made = new Map<string, CloudBackend>();

/**
 * The fake cloud's pins (trust on first use), one store per simulated device, in memory. A
 * development build lists them on `window.__zenithFakePins`, so an end-to-end test can play a server
 * that swaps a partner team's key: nothing else reaches them, and a production build has no list.
 */
class FakePins {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

declare global {
  interface Window {
    /** Development builds with the fake cloud only: every simulated device's pins. */
    __zenithFakePins?: FakePins[];
  }
}

function fakePins(): FakePins {
  const pins = new FakePins();
  if (import.meta.env.DEV && typeof window !== "undefined") window.__zenithFakePins = [...(window.__zenithFakePins ?? []), pins];
  return pins;
}

/** The page's `localStorage`, or null where reading it throws (storage turned off for the site). */
function pageStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function createPageBackend(config: CloudConfig, options: { persistence: boolean }): Promise<CloudBackend> {
  const cloud = await import("@horizon36596/zenith-cloud");
  if (config.mode === "fake" || config.firebase === null) {
    // One in-memory cloud per page: it forgets everything on reload, and nothing leaves the page.
    const existing = made.get("fake");
    if (existing !== undefined) return existing;
    // Written as one condition on import.meta.env.DEV so a production build folds it away entirely.
    // `&beta=closed` starts the development fake with the private beta closed, as a real project
    // starts, to try the private-beta screen and the Beta access view.
    const closed = import.meta.env.DEV && new URLSearchParams(window.location.search).get("beta") === "closed";
    const options = closed
      ? { trust: fakePins(), database: new cloud.MemoryDatabase({ betaGate: "closed" }) }
      : { trust: fakePins() };
    const backend = import.meta.env.DEV
      ? new (await import("../cloud/devReadsBackend")).CountingMemoryBackend(options)
      : new cloud.MemoryBackend(options);
    made.set("fake", backend);
    return backend;
  }
  // A Firebase app can be initialised once per name, so the shared-computer choice (no IndexedDB
  // cache, ADR 0009 section 8) gets an app of its own, and each is kept once made.
  const key = options.persistence ? "firebase" : "firebase-shared";
  const existing = made.get(key);
  if (existing !== undefined) return existing;
  const pins = options.persistence ? pageStorage() : null;
  const firebaseOptions = {
    config: config.firebase,
    persistence: options.persistence,
    ...(options.persistence ? {} : { appName: "zenith-shared-computer" }),
    // Device keys default to IndexedDB with persistence on and to memory without it.
    trust: pins === null ? new cloud.MemoryTrustStore() : new cloud.StorageTrustStore(pins),
    // App Check only when the build set a site key (VITE_ZENITH_APPCHECK_SITE_KEY); off otherwise.
    ...(config.appCheck === null ? {} : { appCheck: config.appCheck }),
  };
  const backend = import.meta.env.DEV
    ? new (await import("../cloud/devReadsBackend")).CountingFirebaseBackend(firebaseOptions)
    : new cloud.FirebaseBackend(firebaseOptions);
  made.set(key, backend);
  return backend;
}

/**
 * The fake cloud only: another simulated device on the same in-memory cloud as `from`, with device
 * keys and pins of its own, so one page can play a member's second device (`AccountModel.switchFakeDevice`).
 */
export async function createFakeDevice(from: CloudBackend): Promise<CloudBackend> {
  const cloud = await import("@horizon36596/zenith-cloud");
  if (!(from instanceof cloud.MemoryBackend)) throw new Error("Only the fake cloud has more than one device on a page.");
  const options = { database: from.database, trust: fakePins() };
  return import.meta.env.DEV ? new (await import("../cloud/devReadsBackend")).CountingMemoryBackend(options) : new cloud.MemoryBackend(options);
}
