/**
 * Remembered folds for the Inspector's sections (issue #239, UI_GUIDE section 9.3). A section with a
 * `foldId`, a kind-level id such as `path.heading` or `step.more`, is open or folded as the person
 * last left that kind of section, in `prefs.inspectorFolds`, and falls back to its own default.
 * Only a click on its header writes the memory. A forced open, the tour's reveal, a selected point
 * or `openFoldForNow`, opens it for now and writes nothing, so the person's choice survives the tour. The tour's
 * reveal lasts while its stop points at the section: the next stop's reveal, or the end of the tour,
 * puts the section back as the memory has it.
 *
 * The ids in use (issue #431): `path.paths`, `path.controls` (closed by default), `path.heading`,
 * `path.speed`, `path.markers`, `command`, `wait`, `transfer`, `transfer.counts` (closed),
 * `parallel`, `group.steps`, `branch`, `marker`, `envelope`, `rejoin`, `step.more` (Advanced,
 * closed), `step.notes` (closed), `routine.start`, `waypoint.pin` and `waypoint.list`.
 */
import { getState, setPrefs } from "../state/store";
import { TOUR_REVEAL_EVENT } from "../tour/signals";

/**
 * Whether a hold still holds a section open. `holder` names what holds it, such as the selected
 * point, or is undefined when nothing does; `releasedFor` is the holder a header click let go of. A
 * click lets go of that one holder only, so a new one, such as another point selected in the same
 * path, holds the section open again.
 */
export function stillHeld(holder: string | undefined, releasedFor: string | undefined): boolean {
  return holder !== undefined && holder !== releasedFor;
}

/** Whether a section shows its body: a forced open wins, then the memory, then its default. */
export function foldShown({
  remembered,
  defaultOpen,
  revealed = false,
  forced = false,
}: {
  /** The person's last choice for this kind of section, if they made one. */
  remembered: boolean | undefined;
  defaultOpen: boolean;
  /** The tour has just pointed at this section, or `openFoldForNow` opened it. */
  revealed?: boolean;
  /** Something selected inside it, such as a point, holds it open. */
  forced?: boolean;
}): boolean {
  return revealed || forced || (remembered ?? defaultOpen);
}

/** Writes the person's choice for one kind of section, keeping every other entry. */
export function rememberFold(foldId: string, open: boolean): void {
  const folds = getState().prefs.inspectorFolds;
  if (folds[foldId] === open) return;
  setPrefs({ inspectorFolds: { ...folds, [foldId]: open } });
}

/**
 * The event `openFoldForNow` dispatches on `window`, with a `foldId` as its detail: the section of
 * that kind opens for now, as the tour's reveal does, and the memory is left as it was.
 */
export const FOLD_OPEN_EVENT = "zenith:fold-open";

/**
 * Opens the section of kind `foldId` for now without writing the memory, as a forced open does: for a
 * control that leads into a folded section, such as the heading pencil of a selected point. The
 * section stays open until a click on its header, or until the step it shows changes.
 */
export function openFoldForNow(foldId: string, { untilMounted = false }: { untilMounted?: boolean } = {}): void {
  if (untilMounted) pendingOpens.add(foldId);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(FOLD_OPEN_EVENT, { detail: foldId }));
}

/**
 * The opens `openFoldForNow` made with `untilMounted` that no listener has taken yet. A piecewise
 * range's rows are drawn only once Heading opens, in a later render than the pencil's click that asks
 * for both, so the range reads its open when it mounts instead of from the event it missed. Reading
 * leaves it in place, so a mount effect React runs twice reads the same answer; the caller that
 * asked forgets it with `forgetPendingFold` once its field is drawn or it gives up.
 */
const pendingOpens = new Set<string>();

/** Whether an open for `foldId` is waiting for its section to mount. */
export function foldPending(foldId: string): boolean {
  return pendingOpens.has(foldId);
}

/** Forgets a waiting open for `foldId`, so it never opens a section mounted later. */
export function forgetPendingFold(foldId: string): void {
  pendingOpens.delete(foldId);
}

/**
 * The id `openFoldForNow` opens one piecewise range's rows by, as a selected end's heading pencil
 * does for the range that decides it. A range's rows are not remembered: they fold again with a new
 * step.
 */
export const rangeFoldId = (index: number): string => `path.heading.range.${String(index)}`;

/** The listener a section of kind `foldId` puts on `window` for `openFoldForNow`. */
export function foldOpenListener(foldId: string, onOpen: () => void): (event: Event) => void {
  return (event: Event) => {
    if (event.type === FOLD_OPEN_EVENT && (event as CustomEvent<string>).detail === foldId) onOpen();
  };
}

/**
 * The listener a section with tour anchor `help` puts on `window` for the tour's reveal. Every reveal
 * calls `onReveal`: with true when the tour is about to point at that anchor, and with false when it
 * points at another one or stops pointing (a `null` detail), so a reveal never outlives its stop.
 * It touches nothing else.
 */
export function revealListener(help: string, onReveal: (shown: boolean) => void): (event: Event) => void {
  return (event: Event) => {
    if (event.type !== TOUR_REVEAL_EVENT) return;
    onReveal((event as CustomEvent<string | null>).detail === help);
  };
}
