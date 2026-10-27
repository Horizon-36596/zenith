/**
 * "What's this" as a one-shot mode (UX review, S14), for the Help menu and the palette, where focus
 * is on the item that was chosen and so there is nothing focused to explain. The cursor becomes a
 * question mark, the status line says what to do, and the next click explains what it lands on,
 * through the same explainers Shift F1 uses (`tooltipGate.ts`), instead of pressing it. Esc leaves
 * the mode, and so does a click on something with nothing to explain, which says so.
 */
import { explainFocused } from "./tooltipGate";

/** The attribute on `<html>` while the mode is on; `base.css` turns the cursor into a question mark by it. */
export const WHATS_THIS_ATTRIBUTE = "data-whats-this";

export const WHATS_THIS_ON = "What's this: click a control or a row to see what it does. Esc cancels.";
export const WHATS_THIS_OFF = "What's this cancelled.";
export const WHATS_THIS_NOTHING = "That has no explanation. What's this is off.";

/** What the mode says on the status line, given by the caller so this file needs no store. */
export type Say = (message: string) => void;

let stop: (() => void) | null = null;

/** Whether the mode is on now. */
export const whatsThisActive = (): boolean => stop !== null;

/** Ends the mode without a word, if it is on. */
export function endWhatsThis(): void {
  stop?.();
}

/**
 * Starts the mode. It begins listening on the next turn, so the click or key that chose the menu
 * item is not taken as the click to explain.
 */
export function startWhatsThis(say: Say): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  endWhatsThis();
  const root = document.documentElement;
  let swallowClick = false;
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onPointerDown = (event: PointerEvent): void => {
    swallow(event);
    // The press is the question: its mouse down, up and click do nothing else.
    swallowClick = true;
    const target = event.target instanceof Element ? event.target : null;
    finish();
    if (target === null || !explainFocused(target)) say(WHATS_THIS_NOTHING);
  };
  const onFollowing = (event: Event): void => {
    if (!swallowClick) return;
    swallow(event);
    if (event.type === "click") swallowClick = false;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    swallow(event);
    finish();
    say(WHATS_THIS_OFF);
  };
  const following = ["mousedown", "mouseup", "click"] as const;
  const timer = window.setTimeout(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
  for (const type of following) window.addEventListener(type, onFollowing, true);
  root.setAttribute(WHATS_THIS_ATTRIBUTE, "");
  const finish = (): void => {
    window.clearTimeout(timer);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKey, true);
    root.removeAttribute(WHATS_THIS_ATTRIBUTE);
    stop = null;
    // The rest of the press that asked is still on its way; it is let through once it has passed.
    window.setTimeout(() => {
      for (const type of following) window.removeEventListener(type, onFollowing, true);
    }, 1000);
  };
  stop = finish;
  say(WHATS_THIS_ON);
}
