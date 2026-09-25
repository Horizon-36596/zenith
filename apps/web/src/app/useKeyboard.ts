/**
 * The keyboard map of UI_GUIDE section 8.2. Every key that has an action runs it through the one
 * action table (`keymap.ts` finds it by its written shortcut), which is also what the toolbar, the
 * palette and the shortcut sheet read, so a key on the sheet always does what the sheet says. The
 * keys with no action of their own are `KEY_ONLY`, each run by the handler named here. Every drag in
 * the editor has a key, which is what makes the canvas operable without a mouse (UI_GUIDE section 9).
 */
import { useEffect } from "react";
import { moveSelection, nudge, rotateHeading } from "./edits";
import { isEnabled, type ActionDef } from "./actions";
import { EDIT_CHORDS, actionForKey, type KeyOnlyId } from "./keymap";
import { SCRUB_STEP_S } from "./shortcuts";
import {
  getState,
  selectStep,
  setDialog,
  setPaletteOpen,
  setPlayback,
  setPlaying,
  setSeverityFilter,
  setStatus,
} from "../state/store";
import { anyMenuOpen, closeMenus } from "../state/ui";

/** True when the keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

/** F6 walks the landmarks in the order UI_GUIDE section 9 lists them. */
function cycleRegion(): void {
  const regions = [...document.querySelectorAll<HTMLElement>("[data-region]")];
  const at = regions.findIndex((region) => region.contains(document.activeElement));
  const next = regions[(at + 1) % Math.max(1, regions.length)];
  next?.focus();
}

/** Esc closes the innermost thing that is open, and with nothing open clears the selection. */
function escape(): void {
  const state = getState();
  if (anyMenuOpen()) closeMenus();
  else if (state.paletteOpen) setPaletteOpen(false);
  else if (state.dialog !== null) setDialog(null);
  else if (state.severityFilter !== null) setSeverityFilter(null);
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
    if (explain && why !== undefined && why !== "") setStatus("info", `${action.label}: ${why}`);
    return;
  }
  void action.run();
}

/** The keys with no action of their own; the `Record` makes every `KEY_ONLY` row have one. */
const KEY_ONLY_HANDLERS: Record<KeyOnlyId, (event: KeyboardEvent) => boolean> = {
  nudge: (event) => arrow(event, false),
  nudgeFar: (event) => arrow(event, true),
  rotate: (event) => {
    if (event.key !== "r" && event.key !== "R") return false;
    rotateHeading(event.shiftKey ? -1 : 1);
    return true;
  },
  reorder: (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    event.preventDefault();
    moveSelection(event.key === "ArrowUp" ? -1 : 1);
    return true;
  },
  stepTime: (event) => {
    if (event.key !== "," && event.key !== ".") return false;
    const at = getState().playbackS ?? 0;
    setPlayback(event.key === "," ? Math.max(0, at - SCRUB_STEP_S) : at + SCRUB_STEP_S);
    return true;
  },
  cycleRegion: (event) => {
    if (event.key !== "F6") return false;
    event.preventDefault();
    cycleRegion();
    return true;
  },
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
  event.preventDefault();
  nudge(by[0], by[1], far);
  return true;
}

export function useKeyboard(): void {
  useEffect(() => {
    // Space plays and pauses, but the canvas also pans while Space is held and the field dragged.
    // So Space toggles playback when it is released, and only when no pointer went down meanwhile.
    let spaceHeld = false;
    let spaceUsed = false;

    const onKeyDown = (event: KeyboardEvent): void => {
      const state = getState();
      // The unsaved-changes question takes every key: its own buttons, Tab, and Escape (which the
      // dialog turns into Cancel). Nothing behind it may run, or close the dialog it sits on.
      if (state.unsavedPrompt !== null) return;
      const typing = isTyping(event.target);
      const chord = event.ctrlKey || event.metaKey;
      const overlay = state.paletteOpen || state.dialog !== null || anyMenuOpen();

      // Esc in a field leaves the field and nothing more (QA-15); in the palette's search, a
      // dialog's field or a menu's filter it still closes that overlay.
      if (event.key === "Escape" && typing && !overlay) {
        (event.target as HTMLElement).blur();
        return;
      }

      const action = actionForKey(event);

      // Ctrl and Alt chords never fall through to the plain keys (QA-14): Ctrl C copies, Ctrl A
      // selects all, and neither picks a tool. A chord runs only its own action, if it has one.
      if (chord || (event.altKey && !event.key.startsWith("Arrow"))) {
        if (action === undefined) return;
        if (typing && EDIT_CHORDS.has(action.id)) return;
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
        KEY_ONLY_HANDLERS.cycleRegion(event);
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
        // Enter and Space on a focused button press that button, as they always do.
        const onButton =
          event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement;
        if (action.id === "view.play") {
          if (event.target instanceof HTMLButtonElement) return;
          event.preventDefault();
          if (!event.repeat) {
            spaceHeld = true;
            spaceUsed = false;
          }
          return;
        }
        if (event.key === "Enter" && onButton) return;
        if (event.key === "?" || event.key === "Enter" || event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
        }
        runFromKey(action, false);
        return;
      }

      for (const handler of Object.values(KEY_ONLY_HANDLERS)) {
        if (handler(event)) return;
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== " " || !spaceHeld) return;
      spaceHeld = false;
      if (spaceUsed) return;
      const state = getState();
      if (state.auto !== null) setPlaying(!state.playing);
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
