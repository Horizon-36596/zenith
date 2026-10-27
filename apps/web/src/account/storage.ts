/**
 * The few values the account UI keeps on this device, behind a two-method interface so the state
 * logic runs in node against an in-memory stand-in. The browser's `localStorage` can refuse reads
 * and writes (private windows, blocked site data); every call here survives that and simply keeps
 * nothing.
 */
export interface DeviceStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** `window.localStorage`, or nothing at all where there is no window (node, tests). */
export function browserStorage(): DeviceStorage {
  return webStorage(() => window.localStorage);
}

/**
 * `window.sessionStorage`: kept for this tab only, and gone when it closes. For what a visitor who
 * is not signed in, or is on a shared computer, should not leave behind (the link shares opened here).
 */
export function browserSessionStorage(): DeviceStorage {
  return webStorage(() => window.sessionStorage);
}

function webStorage(pick: () => Storage): DeviceStorage {
  const store = (): Storage | null => {
    try {
      return typeof window === "undefined" ? null : pick();
    } catch {
      return null;
    }
  };
  return {
    get: (key) => {
      try {
        return store()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        store()?.setItem(key, value);
      } catch {
        // Blocked site data: the value is simply not kept.
      }
    },
    remove: (key) => {
      try {
        store()?.removeItem(key);
      } catch {
        // As above.
      }
    },
  };
}

/** A map in memory, for tests. */
export function memoryStorage(
  initial: Record<string, string> = {},
): DeviceStorage & { dump(): Record<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    dump: () => Object.fromEntries(values),
  };
}

/** Every key the account UI writes or clears, in one place, so none is written by accident elsewhere. */
export const KEYS = {
  /**
   * The removed age screen's answer, on devices that gave one before 2026-10-02. Nothing reads or
   * writes it now; the account model deletes it at start-up so it is not left behind.
   */
  retiredAgeScreen: "zenith.ageScreen",
  /** "on" when the person said this is a shared computer: no offline copy of team data. */
  sharedComputer: "zenith.cloudSharedComputer",
  /** The address a sign-in link was sent to, so the link can be completed when it is opened. */
  signInEmail: "zenith.signInEmail",
  /** The team whose library and settings are shown. */
  team: "zenith.account.team",
  /**
   * The prefix, followed by an account's uid, of the teams this device last saw that account in, each
   * with its number and name, so the Teams sheet can name one it was taken off (`noteTeams` in
   * model.ts). Not written on a shared computer.
   */
  teamsSeenPrefix: "zenith.account.teamsSeen.",
  /** The prefix of the library revision each local auto was last published or opened as. */
  basePrefix: "zenith.library.base.",
  /**
   * The received shares kept for offline use and the link shares opened here: each one's id, the
   * team label and a link's secret (`cloud/keptShares.ts`). The share itself is in the cloud's
   * offline cache. In `localStorage` only while someone is signed in on their own device; otherwise
   * in `sessionStorage`, gone with the tab (`keptSharesStorage`).
   */
  keptShares: "zenith.cloud.keptShares",
  /**
   * The prefix, followed by a team id, of the ids of that team's stopped shares this device shared
   * again, so the Sharing page stops listing them (`cloud/stoppedSharesModel.ts`). Ids only.
   */
  sharedAgainPrefix: "zenith.cloud.sharedAgain.",
} as const;
