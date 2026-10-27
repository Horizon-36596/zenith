/**
 * The one tooltip component. Every interactive element that is not a labelled text button wraps its
 * trigger in it (UI_GUIDE section 8.2): 400 ms to open, 100 ms inside a group once one has opened,
 * instant on keyboard focus, instant close on leave or pointer down, and `aria-describedby` rather
 * than a replacement for `aria-label`. Only keyboard focus opens one, never a focus a menu or the
 * tour moves in code, and opening one closes any other (`tooltipGate.ts`). A field a person types
 * into opens its tooltip on hover only, and only while it does not have focus (`takesText`), so the
 * bubble never sits over the field's own buttons and errors while someone is typing.
 *
 * Touch has no hover, so it has its own rule (UI_GUIDE section 9.4): a hold of 450 ms opens the
 * tooltip, a tap on an `aria-disabled` control opens its reason, and either stays until the next
 * press or 4 s. The hold's context menu and the click that follows it are swallowed, so a long
 * press explains a button without pressing it.
 *
 * A row hint (issue #237) is the same component with `delay="long"`: a row's label opens it after
 * `--hint-delay` of hover, 800 ms, and a pointer down anywhere closes it. Its touch hold is left to a
 * row that drags. Shift F1 opens the focused element's tooltip, or its row's hint, even in a text
 * field, and Esc or a press anywhere closes it (`explainFocused` in `tooltipGate.ts`).
 */
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  HINT_DELAY_MS,
  claim,
  cssMs,
  focusFromKeyboard,
  holdOpens,
  registerExplainer,
  release,
  startHoverWait,
  takesText,
  type TooltipDelay,
} from "./tooltipGate";
import { joinIds, useRowHintId } from "./rowHintContext";
import styles from "./Tooltip.module.css";

const OFFSET_PX = 8;
/** How long a finger must stay down to open the tooltip, how far it may drift, and how long it stays open. */
const HOLD_MS = 450;
const HOLD_SLOP_PX = 8;
const TOUCH_OPEN_MS = 4000;
/** How long after a hold's lift a click or context menu is still the hold's own. */
const SWALLOW_MS = 700;

/** When a tooltip last closed, so the next one in the same sweep opens at the skip delay. */
let lastClosedAt = 0;

/** The `--hint-delay` token (tokens.css), so the beta can tune the long hover in one place. */
function hintDelayMs(): number {
  if (typeof document === "undefined") return HINT_DELAY_MS;
  return cssMs(getComputedStyle(document.documentElement).getPropertyValue("--hint-delay")) ?? HINT_DELAY_MS;
}

export interface TooltipProps {
  /** The action, in sentence case. `Add path`. */
  label: string;
  /** The shortcut, shown in mono at the right of the first line. `P`. */
  shortcut?: string;
  /**
   * A second line: why the control is disabled, or the keyboard equivalent of a drag. A list draws
   * one short paragraph per entry, as a finding code's meaning and its fix (UI_GUIDE section 9.7).
   */
  hint?: string | readonly string[];
  side?: "top" | "bottom" | "right" | "left";
  /** `long` for a row hint, which opens after `--hint-delay` of hover. Every other tooltip is `normal`. */
  delay?: TooltipDelay;
  /**
   * The element Shift F1 explains with this tooltip, when it is not the trigger: a row hint explains
   * its row's controls. Without it, Shift F1 on the trigger opens this tooltip.
   */
  explains?: RefObject<HTMLElement | null>;
  children: ReactElement;
}

interface Placed {
  left: number;
  top: number;
}

export function Tooltip({ label, shortcut, hint, side = "bottom", delay = "normal", explains, children }: TooltipProps) {
  const id = useId();
  const describedId = useId();
  const rowHintId = useRowHintId();
  const textEntry = takesText(children);
  const hints: readonly string[] = hint === undefined ? [] : typeof hint === "string" ? [hint] : hint;
  const [open, setOpen] = useState(false);
  /** Opened by Shift F1: Esc, a press anywhere, or focus moving away closes it. */
  const [explicit, setExplicit] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const cancelWait = useRef<(() => void) | null>(null);
  const token = useRef(Symbol("tooltip"));
  /** The touch hold waiting to fire, and where the finger went down. */
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const touchClose = useRef<number | null>(null);
  const openedByTouch = useRef(false);
  /** Set when a hold opened the tooltip; the click and context menu it ends with are not the person's. */
  const swallowUntil = useRef(0);
  /**
   * Set when a mouse entered the trigger and has not moved on it yet. The hover wait starts on the
   * first move, so a control that appears under a still pointer, like a window's Close button that
   * opens where its toolbar button was clicked, pops no tooltip (0.1.2 UX sweep, W1-17).
   */
  const enteredStill = useRef(false);

  const cancel = useCallback(() => {
    if (cancelWait.current !== null) {
      cancelWait.current();
      cancelWait.current = null;
    }
  }, []);

  const cancelHold = useCallback(() => {
    if (hold.current !== null) {
      window.clearTimeout(hold.current.timer);
      hold.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancel();
    cancelHold();
    if (touchClose.current !== null) {
      window.clearTimeout(touchClose.current);
      touchClose.current = null;
    }
    openedByTouch.current = false;
    setExplicit(false);
    release(token.current);
    setOpen((wasOpen) => {
      if (wasOpen) lastClosedAt = Date.now();
      return false;
    });
  }, [cancel, cancelHold]);

  /** Opens this one, closing whichever other tooltip is open. */
  const show = useCallback(() => {
    claim(close, token.current);
    setOpen(true);
  }, [close]);

  /** Opens this one for a finger: it stays until the next press or 4 s. */
  const showForTouch = useCallback(() => {
    show();
    openedByTouch.current = true;
    if (touchClose.current !== null) window.clearTimeout(touchClose.current);
    touchClose.current = window.setTimeout(close, TOUCH_OPEN_MS);
  }, [show, close]);

  const openOnFocus = useCallback(
    (event: { currentTarget: Element }) => {
      cancel();
      if (textEntry) close();
      else if (focusFromKeyboard(event.currentTarget)) show();
    },
    [cancel, close, show, textEntry],
  );

  const openSoon = useCallback(() => {
    cancel();
    if (textEntry && triggerRef.current !== null && triggerRef.current === document.activeElement) return;
    cancelWait.current = startHoverWait(delay, show, {
      sinceCloseMs: Date.now() - lastClosedAt,
      hintDelayMs: delay === "long" ? hintDelayMs() : HINT_DELAY_MS,
    });
  }, [cancel, show, textEntry, delay]);

  /** Shift F1: opens at once, whatever has focus, a text field included. */
  const explain = useCallback(() => {
    cancel();
    show();
    setExplicit(true);
  }, [cancel, show]);

  // Shift F1 finds this tooltip from the element it explains. Registered after every render, so a
  // trigger that is swapped for another element is found by its new one.
  useEffect(() => {
    const target = explains?.current ?? triggerRef.current;
    if (target === null) return;
    return registerExplainer(target, explain, explains === undefined ? "own" : "row");
  });

  useEffect(
    () => () => {
      cancel();
      cancelHold();
      if (touchClose.current !== null) window.clearTimeout(touchClose.current);
      release(token.current);
    },
    [cancel, cancelHold],
  );

  // A tooltip a finger opened, a row hint, and one Shift F1 opened close on the next press anywhere.
  useEffect(() => {
    if (!open || !(openedByTouch.current || delay === "long" || explicit)) return;
    document.addEventListener("pointerdown", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
    };
  }, [open, close, delay, explicit]);

  // One Shift F1 opened closes on Esc, which then does nothing else, and when focus leaves what it explains.
  useEffect(() => {
    if (!open || !explicit) return;
    const explained = explains?.current ?? triggerRef.current;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onFocus = (event: FocusEvent): void => {
      if (explained === null || !(event.target instanceof Node) || !explained.contains(event.target)) close();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
    };
  }, [open, explicit, explains, close]);

  // Position against the trigger once the bubble has a size, flipping to stay in the viewport.
  useEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (trigger === null || bubble === null) return;
    const anchor = trigger.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    let top =
      side === "top"
        ? anchor.top - box.height - OFFSET_PX
        : side === "bottom"
          ? anchor.bottom + OFFSET_PX
          : anchor.top + (anchor.height - box.height) / 2;
    let left =
      side === "left"
        ? anchor.left - box.width - OFFSET_PX
        : side === "right"
          ? anchor.right + OFFSET_PX
          : anchor.left + (anchor.width - box.width) / 2;
    // A side tooltip on a control in a field row sits beside the whole row, not just the control, so
    // it never covers the row's label: a marker's Command picker, focused when the marker is dropped,
    // opened its bubble over the Command and State labels (W2-20). With no room beside the row, it
    // goes under the row instead.
    const row = side === "left" || side === "right" ? trigger.closest("[data-field-row]") : null;
    if (row !== null) {
      const rowBox = row.getBoundingClientRect();
      left = side === "left" ? rowBox.left - box.width - OFFSET_PX : rowBox.right + OFFSET_PX;
      if (left < 4 || left + box.width > window.innerWidth - 4) {
        left = anchor.left + (anchor.width - box.width) / 2;
        top = rowBox.bottom + OFFSET_PX;
      }
    }
    if (top + box.height > window.innerHeight - 4) top = (row?.getBoundingClientRect() ?? anchor).top - box.height - OFFSET_PX;
    if (top < 4) top = anchor.bottom + OFFSET_PX;
    left = Math.max(4, Math.min(left, window.innerWidth - box.width - 4));
    setPlaced({ left, top });
  }, [open, side]);

  // The trigger's own focus and pointer handlers run first, then the tooltip's: an input that
  // commits its value on blur, or starts a drag on pointer down, must keep doing so inside a tooltip.
  const own = children.props as Record<string, unknown>;
  const alongside =
    (name: string, mine: (event: never) => void) =>
    (event: never): void => {
      const theirs = own[name];
      if (typeof theirs === "function") (theirs as (event: never) => void)(event);
      mine(event);
    };

  const isTouch = (event: { pointerType?: string }): boolean => event.pointerType === "touch";

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const given = (children as { ref?: unknown }).ref;
      if (typeof given === "function") (given as (value: HTMLElement | null) => void)(node);
      else if (given !== null && typeof given === "object") {
        (given as { current: HTMLElement | null }).current = node;
      }
    },
    // A control in a row with a hint is described by the hint too (rowHint.tsx), and keeps its own.
    "aria-describedby": joinIds(
      own["aria-describedby"] as string | undefined,
      rowHintId,
      textEntry ? describedId : open ? id : undefined,
    ),
    onPointerEnter: alongside("onPointerEnter", (event: { pointerType?: string }) => {
      // A finger has no hover; its tooltip comes from a hold or a tap, below.
      if (!isTouch(event)) enteredStill.current = true;
    }),
    // The lift's own pointerleave must not close a tooltip the hold just opened.
    onPointerLeave: alongside("onPointerLeave", (event: { pointerType?: string }) => {
      if (isTouch(event)) return;
      enteredStill.current = false;
      close();
    }),
    onPointerDown: alongside("onPointerDown", (event: { pointerType?: string; clientX: number; clientY: number }) => {
      close();
      enteredStill.current = false;
      if (!isTouch(event) || textEntry || !holdOpens(delay, triggerRef.current)) return;
      hold.current = {
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          hold.current = null;
          swallowUntil.current = Number.POSITIVE_INFINITY;
          showForTouch();
        }, HOLD_MS),
      };
    }),
    onPointerMove: alongside("onPointerMove", (event: { pointerType?: string; clientX: number; clientY: number }) => {
      if (!isTouch(event) && enteredStill.current) {
        enteredStill.current = false;
        openSoon();
        return;
      }
      const start = hold.current;
      if (start === null || !isTouch(event)) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > HOLD_SLOP_PX) cancelHold();
    }),
    onPointerUp: alongside("onPointerUp", (event: { pointerType?: string }) => {
      if (!isTouch(event)) return;
      const pending = hold.current !== null;
      cancelHold();
      // After a hold the click may still arrive; give it a short window and then forget it.
      if (swallowUntil.current === Number.POSITIVE_INFINITY) swallowUntil.current = Date.now() + SWALLOW_MS;
      // A tap on a control that is disabled has nothing else to do, so it opens its reason.
      if (pending && triggerRef.current?.getAttribute("aria-disabled") === "true") showForTouch();
    }),
    onPointerCancel: alongside("onPointerCancel", (event: { pointerType?: string }) => {
      if (!isTouch(event)) return;
      cancelHold();
      if (swallowUntil.current === Number.POSITIVE_INFINITY) swallowUntil.current = Date.now() + SWALLOW_MS;
    }),
    onContextMenu: (event: { preventDefault(): void }) => {
      // The long press's own context menu: it would cover the tooltip and select the button's label.
      if (Date.now() < swallowUntil.current || hold.current !== null) event.preventDefault();
      const theirs = own["onContextMenu"];
      if (typeof theirs === "function") (theirs as (event: never) => void)(event as never);
    },
    // Runs before the trigger's own click handler, which never hears of a click a hold ended with.
    onClickCapture: (event: { preventDefault(): void; stopPropagation(): void }) => {
      if (Date.now() < swallowUntil.current) {
        swallowUntil.current = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const theirs = own["onClickCapture"];
      if (typeof theirs === "function") (theirs as (event: never) => void)(event as never);
    },
    onFocus: alongside("onFocus", openOnFocus),
    onBlur: alongside("onBlur", close),
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {/* A render with no DOM (renderToString in the unit tests) has no body to put it in. */}
      {textEntry && typeof document !== "undefined"
        ? createPortal(
            <span id={describedId} className="visually-hidden">
              {hints.length === 0 ? label : `${label}. ${hints.join(" ")}`}
            </span>,
            document.body,
          )
        : null}
      {open
        ? createPortal(
            <div
              id={id}
              ref={bubbleRef}
              role="tooltip"
              className={styles.bubble}
              data-state={placed === null ? "measuring" : "open"}
              style={
                placed === null
                  ? { visibility: "hidden", left: 0, top: 0 }
                  : { left: `${String(placed.left)}px`, top: `${String(placed.top)}px` }
              }
            >
              <span className={styles.line}>
                <span className={styles.label}>{label}</span>
                {shortcut === undefined ? null : <kbd className={styles.shortcut}>{shortcut}</kbd>}
              </span>
              {hints.map((paragraph, at) => (
                <span key={at} className={styles.hint}>
                  {paragraph}
                </span>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
