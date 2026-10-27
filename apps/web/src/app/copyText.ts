/**
 * The one way Zenith copies text (UI_GUIDE 9.9, 9.15). A copy answers in two places: the button
 * reads "Copied" where it is, and the status line says "Copied the link." When the browser will not
 * copy, it fails one way too: the text is selected where it shows, the button reads "Press Ctrl C",
 * and the status line says the same with what was not copied. Every Copy button goes through
 * `copyText` or `useCopy`, so none answers in a sentence of its own.
 */
import { useEffect, useRef, useState } from "react";
import { setStatus } from "../state/store";

/**
 * How long the button keeps its answer: as long as the status line it goes with, which clears an
 * ok line after 6 s (UI_GUIDE 9.15). SET BY HAND to match it.
 */
export const COPY_ANSWER_MS = 6000;

export type CopyState = "idle" | "copied" | "failed";

/** What the button reads after a copy, in place of its own words. */
export const COPIED_LABEL = "Copied";
export const COPY_FAILED_LABEL = "Press Ctrl C";

/** "Copied the link.", or with the text when it shows nowhere else: "Copied the position of park: {...}" */
export const copiedWords = (what: string, shown?: string): string => (shown === undefined ? `Copied ${what}.` : `Copied ${what}: ${shown}`);

/**
 * "This browser did not let Zenith copy the link. It is selected: press Ctrl C to copy it." When
 * nothing could be selected, `shown` is the text itself, so the line still holds what was wanted.
 */
export function copyFailedWords(what: string, selected: boolean, shown?: string): string {
  const head = `This browser did not let Zenith copy ${what}.`;
  if (selected) return `${head} It is selected: press Ctrl C to copy it.`;
  return shown === undefined ? `${head} Select it and press Ctrl C.` : `${head} It is ${shown}`;
}

/** Selects the text of `element` (all of a field's value), so Ctrl C copies it. True when it could. */
export function selectText(element: Element | null | undefined): boolean {
  if (element === null || element === undefined) return false;
  try {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus({ preventScroll: true });
      element.select();
      return true;
    }
    const selection = window.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

export interface CopyOptions {
  /** Where the text shows, to select it when the copy fails. */
  select?: Element | null;
  /** The text as the status lines should give it, when it shows nowhere on screen to select. */
  shown?: string;
}

/**
 * Copies `text`, and says so on the status line: "Copied <what>." or the failure line. `what` is the
 * thing named the way a sentence needs it: "the link", "the sim command". Resolves true when copied.
 */
export async function copyText(what: string, text: string, options: CopyOptions = {}): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) throw new Error("no clipboard");
    await clipboard.writeText(text);
    setStatus("ok", copiedWords(what, options.shown));
    return true;
  } catch {
    const selected = selectText(options.select);
    setStatus("error", copyFailedWords(what, selected, selected ? undefined : options.shown));
    return false;
  }
}

/**
 * `copyText` for a button: `state` is its answer, which goes back to idle after `COPY_ANSWER_MS`,
 * and `label(words)` is what the button reads now.
 */
export function useCopy(): {
  state: CopyState;
  copy: (what: string, text: string, options?: CopyOptions) => Promise<boolean>;
  label: (words: string) => string;
} {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (what: string, text: string, options?: CopyOptions): Promise<boolean> => {
    const ok = await copyText(what, text, options);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setState("idle");
    }, COPY_ANSWER_MS);
    return ok;
  };
  const label = (words: string): string => (state === "copied" ? COPIED_LABEL : state === "failed" ? COPY_FAILED_LABEL : words);
  return { state, copy, label };
}
