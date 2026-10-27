/**
 * The keyboard map of UI_GUIDE section 8.2. Every key that has an action runs it through the one
 * action table (`keymap.ts` finds it by the key the person has for it, their own or the default),
 * which is also what the toolbar, the palette and the shortcut sheet read, so a key on the sheet
 * always does what the sheet says. The keys with no action of their own are `KEY_ONLY`. Turn, the
 * playhead's steps and Next panel among them are bindings a person may change (`KEY_BINDINGS`, issue
 * #290), found by the same keymap and run by `KEY_BINDING_HANDLERS`; the arrows and Esc stay fixed,
 * each checked by its handler in `KEY_ONLY_HANDLERS`. Every drag in the editor has a key, which is
 * what makes the canvas operable without a mouse (UI_GUIDE section 9).
 */
import { useEffect } from "react";
import { moveSelection, nudge, rotateHeading } from "./edits";
import { nudgeWaypoint, rotateWaypoint } from "./waypointEdits";
import { getWaypointQuestion } from "./waypointDialog";
import { isBetaNoticeOpen } from "../dialogs/betaNoticeState";
import { isEnabled, labelOf, type ActionDef } from "./actions";
import { actionForKey, fieldKeepsChord, keyBindingForKey, type FixedKeyOnlyId, type KeyBindingId } from "./keymap";
import { editingNumbers } from "../settings/editingNumbers";
import {
  getState,
  selectStep,
  setDialog,
  setPaletteOpen,
  setPlayback,
  setSeverityFilter,
  setStatus,
  setTool,
} from "../state/store";
import { anyMenuOpen, closeMenus, getUi, stopEnvelopeDraw, stopWaypointPlacement } from "../state/ui";
import { closeSharingSheet, getCloud } from "../cloud/store";
import { navigateFromKey } from "./navigation";
import { discardOptimize, optimizeOpen } from "../optimize/state";
import { getRunLength, stepPlayhead } from "../state/playback";

/** True when the keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

/** The elements that act on the keys themselves: pressing, choosing, sliding. */
const CONTROL =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"]';

/**
 * True when the keystroke lands on a button, link or field inside one of the panels. Nudging and
 * turning belong to the canvas, the page body and the panels themselves, so an arrow or R pressed on
 * a control in a panel is that control's, not the selected point's (issue #161). A step row takes
 * the arrows for the list, and the R it consumes, in its own handler (`StepsPanel`).
 */
function onControlInRegion(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(CONTROL);
  return control !== null && control.closest("[data-region]") !== null;
}

/**
 * True when the focused element is a step's row or one of its timeline blocks (`data-step-key`) and
 * that step is the only one selected. Then Enter opens the insert menu and Space plays and pauses,
 * as they do from the canvas. On a row that is not selected they stay the button's own, which
 * selects it (issue #161).
 */
function onOnlySelectedStep(target: EventTarget | null): boolean {
  const owner = target instanceof Element ? target.closest<HTMLElement>("[data-step-key]") : null;
  const id = owner?.dataset["stepKey"];
  if (id === undefined) return false;
  const { selection, multiSteps } = getState();
  return selection.stepId === id && multiSteps.length === 0;
}

/**
 * True on the playback scrubber (`data-scrubber` in Timeline.tsx), which has no text for Space to
 * type into. Any other slider, in the Inspector or a proposal, keeps Space as typing.
 */
const isScrubber = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement && target.type === "range" && target.dataset["scrubber"] !== undefined;

/** F6 walks the landmarks in the order UI_GUIDE section 9 lists them. */
function cycleRegion(): void {
  // A region that is not drawn is skipped: below 1100 px with nothing open the Inspector is hidden,
  // and F6 must not stop on it (0.1.2 UX sweep batch review).
  const regions = [...document.querySelectorAll<HTMLElement>("[data-region]")].filter(
    (region) => region.getClientRects().length > 0,
  );
  const at = regions.findIndex((region) => region.contains(document.activeElement));
  const next = regions[(at + 1) % Math.max(1, regions.length)];
  next?.focus();
}

/**
 * Esc closes the innermost thing that is open. With nothing open it leaves a tool for Select
 * (issue #412), and with Select on it clears the selection.
 */
function escape(): void {
  const state = getState();
  if (getUi().envelopeDraw !== null) stopEnvelopeDraw();
  else if (anyMenuOpen()) closeMenus();
  else if (state.paletteOpen) setPaletteOpen(false);
  else if (state.dialog !== null) setDialog(null);
  else if (getCloud().sheet !== null) closeSharingSheet();
  else if (getUi().placingWaypoint) {
    // The armed placement sits under the menus, the palette and the dialogs, so it goes after them.
    stopWaypointPlacement();
    setStatus("info", "Placing a waypoint cancelled.");
  }
  // The Optimize card is docked, not modal, so it goes after the overlays above: Esc is its Discard.
  else if (optimizeOpen()) discardOptimize();
  else if (state.severityFilter !== null) setSeverityFilter(null);
  // A tool stays on between clicks, so Esc is how to finish with it; the selection stays.
  else if (state.tool !== "select") setTool("select");
  else selectStep(undefined);
}

/**
 * Runs an action from its key. A chord or function key that cannot run now says why on the status
 * line, since nothing else would show it was heard; a plain key stays quiet.
 */
function runFromKey(action: ActionDef, explain: boolean): void {
  const state = getState();
  // The palette and the shortcut sheet are toggles from the keyboard: the same key shuts them.
  if (action.id === "view.palette" && state.paletteOpen) {
    setPaletteOpen(false);
    return;
  }
  if (action.id === "help.shortcuts" && state.dialog === "shortcuts") {
    setDialog(null);
    return;
  }
  if (!isEnabled(action, state)) {
    const why = action.whyDisabled?.(state);
    if (explain && why !== undefined && why !== "") {
      // A reason that already names the action is its own sentence: no "Propose: Propose needs…".
      const label = labelOf(action, state);
      setStatus("info", why.startsWith(label) ? why : `${label}: ${why}`);
    }
    return;
  }
  void action.run();
}

/** Moves the playhead one scrub step back (-1) or forward (1), kept inside the run. */
function stepTime(direction: -1 | 1): void {
  const state = getState();
  const by = direction * editingNumbers(state.prefs).scrubStepS;
  setPlayback(stepPlayhead(state.playbackS ?? 0, by, getRunLength()));
}

/**
 * What the keys with no action of their own that a person may rebind do (issue #290). `useKeyboard`
 * finds which one a keystroke is by the person's keys (`keyBindingForKey`), so these never look at
 * the key itself; the `Record` makes every `KEY_BINDINGS` entry have one. Each returns false when the
 * keystroke is not its own after all, so it is left to the focused control.
 */
const KEY_BINDING_HANDLERS: Record<KeyBindingId, (event: KeyboardEvent) => boolean> = {
  "keys.rotate": (event) => {
    if (onControlInRegion(event.target)) return false;
    // Shift turns the other way, whatever the key is (`shiftTurns`).
    const direction = event.shiftKey ? -1 : 1;
    // A selected waypoint pin turns itself (issue #134); anything else turns the selected point.
    const pin = getState().selection.waypoint;
    // A held key is one undo step: only its first press writes history (issue #161).
    const options = { history: !event.repeat };
    if (pin !== undefined) rotateWaypoint(pin, direction, options);
    else rotateHeading(direction, options);
    return true;
  },
  // The step is the person's own (`editing.scrubStepS`), and the playhead stays between 0 and the
  // end the scrubber shows (issue #316).
  "keys.stepBack": () => {
    stepTime(-1);
    return true;
  },
  "keys.stepForward": () => {
    stepTime(1);
    return true;
  },
  "keys.cycleRegion": (event) => {
    event.preventDefault();
    cycleRegion();
    return true;
  },
};

/**
 * Runs the rebindable key-only binding `id` for the keystroke. True when it took the keystroke. A
 * key it takes is the page's, not the browser's, as an action's is: a custom Turn on Home or PgDn
 * must not scroll the panel as well.
 */
function runKeyBinding(id: KeyBindingId, event: KeyboardEvent): boolean {
  const taken = KEY_BINDING_HANDLERS[id](event);
  if (taken) event.preventDefault();
  return taken;
}

/** The fixed keys with no action of their own; the `Record` makes every fixed `KEY_ONLY` row have one. */
const KEY_ONLY_HANDLERS: Record<FixedKeyOnlyId, (event: KeyboardEvent) => boolean> = {
  nudge: (event) => arrow(event, false),
  nudgeFar: (event) => arrow(event, true),
  reorder: (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    event.preventDefault();
    moveSelection(event.key === "ArrowUp" ? -1 : 1);
    return true;
  },
  // Alt + Left and Alt + Right go back and forward between screens (navigation.ts), from anywhere
  // but a field, so they also leave a dialog or a sheet the way they came.
  screens: (event) => navigateFromKey(event),
  escape: (event) => {
    if (event.key !== "Escape") return false;
    escape();
    return true;
  },
};

/** Arrow keys nudge the selected point; Shift for the far step. Alt is `reorder`'s. */
function arrow(event: KeyboardEvent, far: boolean): boolean {
  if (event.altKey || event.shiftKey !== far) return false;
  const move: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };
  const by = move[event.key];
  if (by === undefined) return false;
  if (onControlInRegion(event.target)) return false;
  event.preventDefault();
  const pin = getState().selection.waypoint;
  const options = { history: !event.repeat };
  if (pin !== undefined) nudgeWaypoint(pin, by[0], by[1], far, options);
  else nudge(by[0], by[1], far, options);
  return true;
}

export function useKeyboard(): void {
  useEffect(() => {
    // Space plays and pauses, but the canvas also pans while Space is held and the field dragged.
    // So Space toggles playback when it is released, and only when no pointer went down meanwhile.
    let spaceHeld = false;
    let spaceUsed = false;

    const onKeyDown = (event: KeyboardEvent): void => {
      // Settings, Keyboard is waiting for a binding's new keys: the keystroke is that, and nothing else.
      if (getUi().capturingKey) return;
      const state = getState();
      // The unsaved-changes question takes every key: its own buttons, Tab, and Escape (which the
      // dialog turns into Cancel). Nothing behind it may run, or close the dialog it sits on.
      if (state.unsavedPrompt !== null) return;
      // So does the beta notice on a first load: its Got it, Tab, and Escape, which closes it.
      if (isBetaNoticeOpen()) return;
      // The waypoint question (Delete waypoint, Rename, Save as waypoint) is as modal: Ctrl+Z, the
      // action keys and a held Del must not run behind it, or its list of followers goes stale.
      // Escape still reaches the dialog, which turns it into Cancel.
      if (event.key !== "Escape" && getWaypointQuestion() !== null) return;
      if (KEY_ONLY_HANDLERS.screens(event)) return;
      // The playback scrubber is a range input with no text for Space to type, so Space plays from it.
      const typing = isTyping(event.target) && !(event.key === " " && isScrubber(event.target));
      const chord = event.ctrlKey || event.metaKey;
      const overlay = state.paletteOpen || state.dialog !== null || anyMenuOpen();

      // Esc in a field leaves the field and nothing more (QA-15); in the palette's search, a
      // dialog's field or a menu's filter it still closes that overlay.
      if (event.key === "Escape" && typing && !overlay) {
        (event.target as HTMLElement).blur();
        return;
      }

      const action = actionForKey(event);
      // Turn, the playhead's steps and Next panel, by the person's keys (issue #290). The keymap never
      // gives one keystroke to two bindings, so at most one of `action` and `own` is set.
      const own = action === undefined ? keyBindingForKey(event) : undefined;

      // Ctrl and Alt chords never fall through to the plain keys (QA-14): Ctrl C copies, Ctrl A
      // selects all, and neither picks a tool. A chord runs only its own binding, if it has one.
      if (chord || (event.altKey && !event.key.startsWith("Arrow"))) {
        if (own !== undefined) {
          runKeyBinding(own, event);
          return;
        }
        if (action === undefined) return;
        // Ctrl Z in a text field undoes the typing; from a select, which has no undo, the routine's.
        if (typing && fieldKeepsChord(action.id, (event.target as HTMLElement).tagName)) return;
        event.preventDefault();
        runFromKey(action, true);
        return;
      }

      // The function keys work from anywhere, even inside a field or a dialog.
      if (/^F\d+$/.test(event.key)) {
        if (action !== undefined) {
          event.preventDefault();
          runFromKey(action, true);
          return;
        }
        if (own !== undefined) runKeyBinding(own, event);
        return;
      }

      if (event.key === "Escape") {
        KEY_ONLY_HANDLERS.escape(event);
        return;
      }

      if (typing || state.paletteOpen || state.dialog !== null) return;
      // A key the canvas or an open menu already handled (S and C on a curve point, arrows in a
      // menu) stops there.
      if (event.defaultPrevented || anyMenuOpen()) return;

      if (action !== undefined) {
        // Enter and Space on a focused button press that button, as they always do, and on a
        // disclosure's summary they open or close it.
        const onSummary = event.target instanceof HTMLElement && event.target.tagName === "SUMMARY";
        const onButton =
          event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement || onSummary;
        // On a step row or timeline block that is the only selected step, Enter and Space are the
        // app's; anywhere else on a button they are the button's.
        const owned = onOnlySelectedStep(event.target);
        if (action.id === "view.play") {
          if ((event.target instanceof HTMLButtonElement || onSummary) && !owned) return;
          event.preventDefault();
          if (!event.repeat) {
            spaceHeld = true;
            spaceUsed = false;
          }
          return;
        }
        if (event.key === "Enter" && onButton && !owned) return;
        // The key is the action's, not the browser's: a custom PgDn, Home or End must not scroll the
        // panel too, and a custom / or ' must not open Firefox's quick find.
        event.preventDefault();
        runFromKey(action, false);
        return;
      }

      if (own !== undefined && runKeyBinding(own, event)) return;

      for (const handler of Object.values(KEY_ONLY_HANDLERS)) {
        if (handler(event)) return;
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (getUi().capturingKey) return;
      if (event.key !== " " || !spaceHeld) return;
      spaceHeld = false;
      if (spaceUsed) return;
      // A button's own press on Space starts when the key is released; here Space is the app's.
      event.preventDefault();
      const action = actionForKey(event);
      if (action?.id === "view.play") runFromKey(action, false);
    };
    const onPointerDown = (): void => {
      if (spaceHeld) spaceUsed = true;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
}
