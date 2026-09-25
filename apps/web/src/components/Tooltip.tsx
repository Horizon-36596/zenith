/**
 * The one tooltip component. Every interactive element that is not a labelled text button wraps its
 * trigger in it (UI_GUIDE section 8.2): 400 ms to open, 100 ms inside a group once one has opened,
 * instant on keyboard focus, instant close on leave or pointer down, and `aria-describedby` rather
 * than a replacement for `aria-label`. Only keyboard focus opens one, never a focus a menu or the
 * tour moves in code, and opening one closes any other (`tooltipGate.ts`).
 */
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { claim, focusFromKeyboard, release } from "./tooltipGate";
import styles from "./Tooltip.module.css";

const OPEN_DELAY_MS = 400;
const SKIP_DELAY_MS = 100;
const OFFSET_PX = 8;

/** When a tooltip last closed, so the next one in the same sweep opens at the skip delay. */
let lastClosedAt = 0;

export interface TooltipProps {
  /** The action, in sentence case. `Add path`. */
  label: string;
  /** The shortcut, shown in mono at the right of the first line. `P`. */
  shortcut?: string;
  /** A second line: why the control is disabled, or the keyboard equivalent of a drag. */
  hint?: string;
  side?: "top" | "bottom" | "right" | "left";
  children: ReactElement;
}

interface Placed {
  left: number;
  top: number;
}

export function Tooltip({ label, shortcut, hint, side = "bottom", children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const token = useRef(Symbol("tooltip"));

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancel();
    release(token.current);
    setOpen((wasOpen) => {
      if (wasOpen) lastClosedAt = Date.now();
      return false;
    });
  }, [cancel]);

  /** Opens this one, closing whichever other tooltip is open. */
  const show = useCallback(() => {
    claim(close, token.current);
    setOpen(true);
  }, [close]);

  const openOnFocus = useCallback(
    (event: { currentTarget: Element }) => {
      cancel();
      if (focusFromKeyboard(event.currentTarget)) show();
    },
    [cancel, show],
  );

  const openSoon = useCallback(() => {
    cancel();
    const delay = Date.now() - lastClosedAt < SKIP_DELAY_MS ? 0 : OPEN_DELAY_MS;
    timer.current = window.setTimeout(show, delay);
  }, [cancel, show]);

  useEffect(
    () => () => {
      cancel();
      release(token.current);
    },
    [cancel],
  );

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
    if (top + box.height > window.innerHeight - 4) top = anchor.top - box.height - OFFSET_PX;
    if (top < 4) top = anchor.bottom + OFFSET_PX;
    left = Math.max(4, Math.min(left, window.innerWidth - box.width - 4));
    setPlaced({ left, top });
  }, [open, side]);

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const given = (children as { ref?: unknown }).ref;
      if (typeof given === "function") (given as (value: HTMLElement | null) => void)(node);
      else if (given !== null && typeof given === "object") {
        (given as { current: HTMLElement | null }).current = node;
      }
    },
    "aria-describedby": open ? id : undefined,
    onPointerEnter: openSoon,
    onPointerLeave: close,
    onPointerDown: close,
    onFocus: openOnFocus,
    onBlur: close,
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
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
              {hint === undefined ? null : <span className={styles.hint}>{hint}</span>}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
