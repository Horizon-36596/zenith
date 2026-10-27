/**
 * Back and forward between screens (issue #83), as pure logic: the list of places visited, which one
 * is current, and which input means which direction. `navigation.ts` wires it to the stores, the
 * mouse, the keyboard and the desktop app; nothing here touches the DOM or the clock, so every rule
 * is tested in `screenHistory.test.ts`.
 *
 * A place is where the person is, never what they did: which auto is open and which page or sheet
 * is showing. Selection, tools and edits are not places, so going back never undoes anything; undo
 * stays Ctrl Z.
 */

import type { AccountPanel } from "../account/model";
import type { ReceivedShare } from "../cloud/types";
import type { SettingsSection } from "../settings/sections";
import type { DialogKind } from "../state/store";

export type NavDirection = "back" | "forward";

/**
 * The dialogs that are places to look at: the shortcut sheet (help), the auto settings,
 * and the open dialog. The others (commit, propose, report a bug, import commands, simulate, GitHub
 * sign-in) are tasks with a form, which going back should close, not open again empty.
 */
export const SCREEN_DIALOGS: ReadonlySet<DialogKind> = new Set<DialogKind>(["shortcuts", "meta", "open"]);

/** Which sharing sheet is open, with what it needs to open the same way again. */
export type SharingPlace =
  | { sheet: "share" }
  | { sheet: "sharing"; autoId: string | null }
  | { sheet: "viewer"; share: ReceivedShare };

/** One screen: the auto that is open, and the page, sheet or dialog showing over it. */
export interface Place {
  /** The open auto's file name in the open project, or null with none. */
  file: string | null;
  /** A dialog from `SCREEN_DIALOGS`, or null. */
  dialog: DialogKind;
  /** The open account sheet: sign in, teams, library or outbox. */
  account: AccountPanel;
  /** The Settings window's section while it is open, or null when it is closed; each section is a screen. */
  settings: SettingsSection | null;
  sharing: SharingPlace | null;
  /** The Horizon admins' page at `#/admin`. */
  admin: boolean;
}

export const NOWHERE: Place = { file: null, dialog: null, account: null, settings: null, sharing: null, admin: false };

function sameSharing(a: SharingPlace | null, b: SharingPlace | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.sheet !== b.sheet) return false;
  if (a.sheet === "sharing" && b.sheet === "sharing") return a.autoId === b.autoId;
  if (a.sheet === "viewer" && b.sheet === "viewer") return a.share.id === b.share.id;
  return true;
}

export function samePlace(a: Place, b: Place): boolean {
  return (
    a.file === b.file &&
    a.dialog === b.dialog &&
    a.account === b.account &&
    a.settings === b.settings &&
    a.admin === b.admin &&
    sameSharing(a.sharing, b.sharing)
  );
}

/** What has to change to go from `from` to `to`, in the order it is done. */
export interface RestorePlan {
  /** The auto to open first, through the usual unsaved-changes question, or null to keep this one. */
  openFile: string | null;
  dialog: { to: DialogKind } | null;
  sharing: { to: SharingPlace | null } | null;
  account: { to: AccountPanel } | null;
  settings: { to: SettingsSection | null } | null;
  admin: { to: boolean } | null;
}

/**
 * The steps from one place to another. The auto comes first, so a Cancel at the unsaved-changes
 * question stops the whole step before any sheet moves. A place with no auto never closes the open
 * one: there is no "close the auto" in the editor, and going back must not lose anything.
 */
export function restorePlan(from: Place, to: Place): RestorePlan {
  return {
    openFile: to.file !== null && to.file !== from.file ? to.file : null,
    dialog: to.dialog === from.dialog ? null : { to: to.dialog },
    sharing: sameSharing(from.sharing, to.sharing) ? null : { to: to.sharing },
    account: to.account === from.account ? null : { to: to.account },
    settings: to.settings === from.settings ? null : { to: to.settings },
    admin: to.admin === from.admin ? null : { to: to.admin },
  };
}

/** How many places are kept. The oldest goes first, as in a browser that has been open all day. */
export const HISTORY_LIMIT = 100;

/**
 * The places visited, oldest first, and the one shown now. Visiting a place after going back drops
 * the places that were ahead of it, as a browser does.
 */
export class ScreenHistory<P> {
  private entries: P[];
  private index: number;

  constructor(
    first: P,
    private readonly same: (a: P, b: P) => boolean,
    private readonly limit = HISTORY_LIMIT,
  ) {
    this.entries = [first];
    this.index = 0;
  }

  get current(): P {
    return this.entries[this.index] as P;
  }

  canGo(direction: NavDirection): boolean {
    return direction === "back" ? this.index > 0 : this.index < this.entries.length - 1;
  }

  /** The place one step in `direction`, or null at that end. */
  peek(direction: NavDirection): P | null {
    if (!this.canGo(direction)) return null;
    return this.entries[this.index + (direction === "back" ? -1 : 1)] as P;
  }

  /** Moves one step in `direction` and returns the place there, or null at that end. */
  go(direction: NavDirection): P | null {
    const next = this.peek(direction);
    if (next === null) return null;
    this.index += direction === "back" ? -1 : 1;
    return next;
  }

  /** Records a new place. The same place as the current one adds nothing. */
  visit(place: P): void {
    if (this.same(place, this.current)) return;
    this.entries = [...this.entries.slice(0, this.index + 1), place];
    if (this.entries.length > this.limit) this.entries = this.entries.slice(this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  /** Corrects the current place without adding one: what a restore actually reached. */
  replace(place: P): void {
    this.entries[this.index] = place;
  }

  /** Forgets every place and starts again from `place`. */
  reset(place: P): void {
    this.entries = [place];
    this.index = 0;
  }

  /** How many places are kept, for tests. */
  get size(): number {
    return this.entries.length;
  }
}

/** Where a back or forward came from. */
export type NavSource = "mouse" | "key" | "appCommand";

/**
 * How long after one input a different input for the same direction is taken as the same press.
 * In the desktop app on Windows one press of a mouse's side button can arrive twice, as a mouse
 * button in the page and as the window's `app-command`; this keeps it to one step.
 */
export const SAME_PRESS_MS = 500;

/**
 * Lets each press through once. Two presses from the same source always count, so a quick double
 * click of the back button goes back two places. Alt + arrows never arrive twice, so they always
 * count and never hold back a mouse button.
 */
export class NavInputGate {
  private last: { source: NavSource; direction: NavDirection; atMs: number } | null = null;

  accept(source: NavSource, direction: NavDirection, nowMs: number): boolean {
    if (source === "key") return true;
    const last = this.last;
    if (
      last !== null &&
      last.source !== source &&
      last.direction === direction &&
      nowMs - last.atMs >= 0 &&
      nowMs - last.atMs < SAME_PRESS_MS
    ) {
      return false;
    }
    this.last = { source, direction, atMs: nowMs };
    return true;
  }
}

/** The mouse's side buttons as `MouseEvent.button` numbers them: 3 is back, 4 is forward. */
export function mouseButtonDirection(button: number): NavDirection | null {
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}

/** The parts of a keystroke that decide whether it is Alt + Left or Alt + Right. */
export interface NavKeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Alt + Left goes back and Alt + Right goes forward, as in a browser. Any other modifier is not this. */
export function keyDirection(event: NavKeyLike): NavDirection | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}
