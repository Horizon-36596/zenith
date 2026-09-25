/**
 * The rules every tooltip in the app shares (UI_GUIDE section 9.4): at most one is open at a time,
 * so a new one closes the one before it, and focus opens one only when the focus came from the
 * keyboard. `Tooltip` and the `?` help tip (`HelpTip`) both go through here.
 */

/** Closes whichever tooltip is open now. */
type Close = () => void;

let current: { token: symbol; close: Close } | null = null;

/**
 * Marks a tooltip as the open one and closes the one that was open before it, if that was another.
 * Returns the token to hand back to `release` when this one closes.
 */
export function claim(close: Close, token: symbol = Symbol("tooltip")): symbol {
  const previous = current;
  current = { token, close };
  if (previous !== null && previous.token !== token) previous.close();
  return token;
}

/** This tooltip closed; forget it, unless another has already taken over. */
export function release(token: symbol): void {
  if (current?.token === token) current = null;
}

/** Whether any tooltip is marked open, for tests. */
export const anyOpen = (): boolean => current !== null;

/**
 * Whether a focus on `element` should open its tooltip: only when the browser would draw a focus
 * ring for it (`:focus-visible`), which is keyboard focus. A menu that focuses its first item as it
 * opens under a click, or a card that takes focus for the tour, does not match, so neither pops a
 * tooltip nobody asked for. A browser that cannot answer counts as keyboard focus.
 */
export function focusFromKeyboard(element: { matches(selector: string): boolean } | null): boolean {
  if (element === null) return false;
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
