/**
 * The rules every tooltip in the app shares (UI_GUIDE section 9.4): at most one is open at a time,
 * so a new one closes the one before it, and focus opens one only when the focus came from the
 * keyboard. `Tooltip` and the `?` help tip (`HelpTip`) both go through here. So do the timings, the
 * row hints' long hover (issue #237), which tooltip Shift F1 opens, and where a touch hold opens one.
 */
import { lastInput, type InputKind } from "./inputModality";

/** Whether a tooltip opens at the ordinary delay, or is a row hint that waits for a long hover. */
export type TooltipDelay = "normal" | "long";

/** How long the pointer rests on a control before its tooltip opens. CARRIED OVER from Tooltip.tsx. */
export const OPEN_DELAY_MS = 400;
/** Within this long of one tooltip closing, the next opens at once, so a sweep reads each in turn. */
export const SKIP_DELAY_MS = 100;
/**
 * A row hint's long hover, when the `--hint-delay` token cannot be read. SET BY HAND at twice
 * `OPEN_DELAY_MS`: a row is where the pointer rests while someone reads, so 400 ms would pop text.
 */
export const HINT_DELAY_MS = 2 * OPEN_DELAY_MS;

/** A CSS time such as `800ms` or `0.8s`, in milliseconds, or undefined when it is not one. */
export function cssMs(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)(ms|s)\s*$/.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}

/** How long to wait before opening, given how long ago the last tooltip closed. */
export function openDelayMs(delay: TooltipDelay, sinceCloseMs: number, hintDelayMs: number): number {
  if (sinceCloseMs < SKIP_DELAY_MS) return 0;
  return delay === "long" ? hintDelayMs : OPEN_DELAY_MS;
}

/** Starts the hover wait, and returns what cancels it (a leave, a press, a focus). */
export function startHoverWait(
  delay: TooltipDelay,
  open: () => void,
  options: { sinceCloseMs: number; hintDelayMs: number },
): () => void {
  const timer = setTimeout(open, openDelayMs(delay, options.sinceCloseMs, options.hintDelayMs));
  return () => {
    clearTimeout(timer);
  };
}

/** Rows that drag (a step row). A finger held on one is starting a drag, not asking what it is. */
export const DRAG_ROW_SELECTOR = '[data-drag-row], [draggable="true"]';

/** Whether a 450 ms touch hold on `trigger` opens its tooltip. A row hint in a row that drags does not. */
export function holdOpens(delay: TooltipDelay, trigger: Pick<Element, "closest"> | null): boolean {
  if (delay !== "long" || trigger === null) return true;
  return trigger.closest(DRAG_ROW_SELECTOR) === null;
}

/** What Shift F1 opens, by the element it explains. */
type Explain = () => void;
/** A row hint explains every control in its row, ahead of a control's own tooltip. */
export type ExplainerKind = "row" | "own";

const explainers: Record<ExplainerKind, Map<Element, Explain>> = { row: new Map(), own: new Map() };

/**
 * Says what Shift F1 opens when focus is on `element` or inside it. Returns what forgets it again,
 * which leaves alone a registration another tooltip has made for the same element since.
 */
export function registerExplainer(element: Element, explain: Explain, kind: ExplainerKind): () => void {
  const map = explainers[kind];
  map.set(element, explain);
  return () => {
    if (map.get(element) === explain) map.delete(element);
  };
}

/** Focus in these is choosing something else to do; Shift F1 there has nothing of its own to explain. */
const NOT_EXPLAINED = '[role="menu"], [aria-label="Command palette"]';

function nearest(kind: ExplainerKind, from: Element): Explain | undefined {
  for (let at: Element | null = from; at !== null; at = at.parentElement) {
    const explain = explainers[kind].get(at);
    if (explain !== undefined) return explain;
  }
  return undefined;
}

/**
 * Shift F1, "What's this": opens the full hint of the focused element. That is the hint of the row
 * it sits in when the row has one, and otherwise its own tooltip or the nearest one around it.
 * Returns whether anything opened.
 */
export function explainFocused(focused: Element | null): boolean {
  if (focused === null || focused.closest(NOT_EXPLAINED) !== null) return false;
  const explain = nearest("row", focused) ?? nearest("own", focused);
  if (explain === undefined) return false;
  explain();
  return true;
}

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
 * Whether a focus on `element` should open its tooltip: only when the last input was a key press
 * (`inputModality.ts`) and the browser draws a focus ring for it (`:focus-visible`), which is
 * keyboard focus. A menu that focuses its first item as a right-click opens it, a sheet that hands
 * focus back as a click closes it, a dropped marker's picker and a page focusing its first control
 * as it opens all fail the first test, so none pops a tooltip nobody asked for. A browser that
 * cannot answer the second counts as keyboard focus.
 */
export function focusFromKeyboard(
  element: { matches(selector: string): boolean } | null,
  input: InputKind | null = lastInput(),
): boolean {
  if (element === null || input !== "keyboard") return false;
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** Input types a person types into; a checkbox, radio, range, colour or button input is not one. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/**
 * Whether a tooltip's trigger is a field a person types into, from the element the tooltip wraps:
 * a `textarea`, a text-like `input`, or anything `contentEditable`. Such a field never opens its
 * tooltip on focus, and not on hover while it has focus either: a browser draws a focus ring on a
 * text field even after a click, so the old rule popped the bubble the moment someone started typing
 * and it covered the field's own buttons and error line. Its words stay with screen readers through
 * a hidden description instead.
 */
export function takesText(element: { type: unknown; props: unknown }): boolean {
  const props = (element.props ?? {}) as { type?: unknown; contentEditable?: unknown };
  if (props.contentEditable === true || props.contentEditable === "true") return true;
  if (element.type === "textarea") return true;
  if (element.type !== "input") return false;
  const type = typeof props.type === "string" ? props.type.toLowerCase() : "";
  return TEXT_INPUT_TYPES.has(type);
}
