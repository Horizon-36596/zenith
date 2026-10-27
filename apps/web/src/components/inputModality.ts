/**
 * Whether the person's last input was a key or a pointer (UI_GUIDE sections 9.4 and 11). A focus
 * ring and a focus-opened tooltip answer the keyboard only: after a click, a right-click, a drag or
 * a drop, focus that code moves draws no ring and opens no tooltip, and a page that has had no
 * input yet shows neither on the control it focuses as it opens.
 *
 * Chrome's own `:focus-visible` guess draws a ring on some focus that code moves after a pointer
 * press, such as a menu focusing its first item as a right-click opens it, so code that moves focus
 * goes through `focusForInput`, which says which it was with `focusVisible`.
 */

export type InputKind = "keyboard" | "pointer";

let last: InputKind | null = null;

/** The kind of the last input, or null before the first one. */
export function lastInput(): InputKind | null {
  return last;
}

/** Records an input. The listeners below call it; tests call it to set the state they need. */
export function noteInput(kind: InputKind | null): void {
  last = kind;
}

/** Keys that only change what another key or a click does; pressed alone, they move nothing. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

/** Whether a key press counts as keyboard use. A modifier pressed alone, as for Ctrl click, does not. */
export function isKeyboardUse(event: Pick<KeyboardEvent, "key">): boolean {
  return !MODIFIER_KEYS.has(event.key);
}

// On the window in the capture phase, so the record is made before any other handler of the same
// input runs, including the window capture listeners of menus and shortcuts.
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (isKeyboardUse(event)) noteInput("keyboard");
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    () => {
      noteInput("pointer");
    },
    true,
  );
}

/** `FocusOptions` with Chrome's `focusVisible`, which the DOM types do not have yet. */
type FocusVisibleOptions = FocusOptions & { focusVisible?: boolean };

/** The options for a focus that code moves now: a ring only when the last input was a key. */
export function focusOptions(options: FocusOptions = {}, input: InputKind | null = lastInput()): FocusVisibleOptions {
  return { ...options, focusVisible: input === "keyboard" };
}

/**
 * Moves focus to `element` for the person's last input: with a ring after a key press, and with
 * none after a pointer press or before any input. Use it wherever code moves focus.
 */
export function focusForInput(element: HTMLElement | null | undefined, options?: FocusOptions): void {
  element?.focus(focusOptions(options));
}
