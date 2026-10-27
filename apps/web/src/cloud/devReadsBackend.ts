/**
 * The page's read counter (`reads.ts`), in a development build only. `backendFactory.ts` imports
 * this module behind `import.meta.env.DEV`, so a production bundle carries none of it: there the
 * backends are the cloud package's own classes, and nothing counts.
 *
 * Here the backends are the cloud package's two classes with their document store wrapped, so every
 * get and list the client makes is counted against the screen the app shows at that moment. The
 * counts are on `window.__zenithReads` for tests and the console, and in the Settings window's
 * Developer section and the Sign-in sheet (`DevReads.tsx`).
 */
import { FirebaseBackend, MemoryBackend, type DocStore } from "@horizon36596/zenith-cloud";
import { account } from "../account/store";
import { getSettings } from "../settings/store";
import { ReadCounter, countingStore, screenLabel, type ReadsSnapshot } from "./reads";
import { getCloud } from "./store";

/** The screen the app shows now, from the address and the sheets that are open. */
function currentScreen(): string {
  return screenLabel({
    hash: typeof window === "undefined" ? "" : window.location.hash,
    sharingSheet: getCloud().sheet,
    accountPanel: account.getState().panel,
    settingsOpen: getSettings().open,
  });
}

/** The page's one counter. */
export const pageReads = new ReadCounter(currentScreen);

/** What `window.__zenithReads` offers: the counts so far, and a fresh start. */
export interface ZenithReadsHandle {
  snapshot(): ReadsSnapshot;
  reset(): void;
}

declare global {
  interface Window {
    /** Development builds only: the cloud reads this page has made, by screen. */
    __zenithReads?: ZenithReadsHandle;
  }
}

if (typeof window !== "undefined") {
  window.__zenithReads = { snapshot: () => pageReads.snapshot(), reset: () => pageReads.reset() };
}

const wrapped = new WeakMap<DocStore, DocStore>();

/** One counting wrapper per store, so the Firebase backend's store, which it replaces on reconnect, is wrapped once each. */
function counted(store: DocStore): DocStore {
  const existing = wrapped.get(store);
  if (existing !== undefined) return existing;
  const next = countingStore(store, pageReads);
  wrapped.set(store, next);
  return next;
}

/** The fake cloud (`?cloud=fake`), counting its reads. */
export class CountingMemoryBackend extends MemoryBackend {
  protected override store(): DocStore {
    return counted(super.store());
  }
}

/** The real cloud, counting its reads. */
export class CountingFirebaseBackend extends FirebaseBackend {
  protected override store(): DocStore {
    return counted(super.store());
  }
}
