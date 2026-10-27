/**
 * The `?` beside every region title and inspector section header (site/docs/editor.md, UI_GUIDE
 * section 9.3). Hover opens it after `--help-delay`, focus opens it at once, and a click pins it
 * open until a second click, Escape or a click elsewhere. The text is the
 * `PANEL_HELP` entry, and when the full tour has a stop for this panel a "Show me" link starts it
 * there. A pinned tip whose entry has a `docs` value also shows "Read more", a link to that page and
 * heading of the docs site (UI_GUIDE section 9.3).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";
import { panelHelp, type HelpEntry, type PanelHelpId } from "./content";
import { docsLink } from "../account/config";
import { useFeature } from "../state/features";
import { startFullTour, stopFor } from "../tour/store";
import { getState } from "../state/store";
import { claim, focusFromKeyboard, release } from "../components/tooltipGate";
import styles from "./help.module.css";

/** `--help-delay`, read once: the ? opens faster than a tooltip because the user is asking. */
const HELP_DELAY_MS = 150;
const OFFSET_PX = 8;

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The elements Tab visits inside `root`, in document order (positive tabindex is not used here). */
function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
  );
}

/**
 * Where Tab goes while a tip is pinned. The bubble is portaled to the end of the body, so the
 * browser's own order would skip its links: Tab from the ? enters the bubble, Shift Tab from its
 * first link returns to the ?, and Tab from its last link goes on to whatever follows the ?.
 * Null leaves the key to the browser.
 */
function pinnedTabTarget(
  back: boolean,
  focused: Element | null,
  button: HTMLElement,
  bubble: HTMLElement,
): HTMLElement | null {
  const inside = tabbables(bubble);
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (first === undefined || last === undefined) return null;
  if (focused === button) return back ? null : first;
  if (back && focused === first) return button;
  if (!back && focused === last) {
    const page = tabbables(document.body).filter((element) => !bubble.contains(element));
    return page[page.indexOf(button) + 1] ?? null;
  }
  return null;
}

export function HelpTip({ id, side = "bottom" }: { id: PanelHelpId; side?: "bottom" | "left" }) {
  const entry: HelpEntry = panelHelp(id, useFeature("fullSim"));
  const popId = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  /** True while Escape hands focus back to the ?, so that focus does not reopen the tip. */
  const refocusing = useRef(false);
  const stop = stopFor(id);
  // The hover bubble is a tooltip and cannot hold a link, so only a pinned one offers the docs.
  const showMe = stop !== undefined && getState().auto !== null;
  const docs = pinned ? entry.docs : undefined;

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const token = useRef(Symbol("help-tip"));
  const close = useCallback(() => {
    cancel();
    release(token.current);
    setOpen(false);
    setPinned(false);
  }, [cancel]);
  useEffect(
    () => () => {
      release(token.current);
    },
    [],
  );

  /** Opens this tip, closing whichever other tooltip is open (`tooltipGate.ts`). */
  const show = useCallback(() => {
    claim(close, token.current);
    setOpen(true);
  }, [close]);

  useLayoutEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    const anchor = button.current?.getBoundingClientRect();
    const box = bubble.current?.getBoundingClientRect();
    if (anchor === undefined || box === undefined) return;
    let left = side === "left" ? anchor.right - box.width : anchor.left;
    let top = anchor.bottom + OFFSET_PX;
    if (top + box.height > window.innerHeight - 8) top = anchor.top - box.height - OFFSET_PX;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    top = Math.max(8, top);
    setPlaced({ left, top });
  }, [open, side]);

  // A pinned tip closes on Escape or a press anywhere else.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (button.current?.contains(target) === true || bubble.current?.contains(target) === true) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      const inBubble = bubble.current?.contains(document.activeElement) === true;
      if (event.key === "Escape") {
        close();
        // Focus inside the bubble would be lost with it, so it goes back to the ?.
        if (inBubble) {
          refocusing.current = true;
          button.current?.focus();
          refocusing.current = false;
        }
        return;
      }
      if (event.key !== "Tab" || button.current === null || bubble.current === null) return;
      const target = pinnedTabTarget(event.shiftKey, document.activeElement, button.current, bubble.current);
      if (target === null) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [pinned, close]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.tip}
        aria-label={`What is ${entry.title}?`}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        data-testid={`help-${id}`}
        data-help={id}
        onPointerEnter={() => {
          cancel();
          timer.current = window.setTimeout(show, HELP_DELAY_MS);
        }}
        onPointerLeave={() => {
          cancel();
          if (!pinned) {
            release(token.current);
            setOpen(false);
          }
        }}
        onFocus={(event) => {
          // Keyboard focus only: a click opens it through onClick, and a focus moved in code none.
          if (!refocusing.current && focusFromKeyboard(event.currentTarget)) show();
        }}
        onBlur={(event) => {
          if (!pinned && !(bubble.current?.contains(event.relatedTarget as Node) ?? false)) {
            release(token.current);
            setOpen(false);
          }
        }}
        onClick={(event) => {
          // The ? sits inside a section header that is itself a button; it must not toggle it.
          event.stopPropagation();
          if (pinned) close();
          else {
            setPinned(true);
            show();
          }
        }}
      >
        ?
      </button>
      {open
        ? createPortal(
            <div
              ref={bubble}
              id={popId}
              role="tooltip"
              className={styles.bubble}
              data-testid="help-bubble"
              data-state={placed === null ? "measuring" : "open"}
              data-pinned={pinned ? "true" : undefined}
              style={placed === null ? { left: 0, top: 0, visibility: "hidden" } : placed}
            >
              <span className={styles.title}>{entry.title}</span>
              <span className={styles.body}>{entry.body}</span>
              {showMe || docs !== undefined ? (
                <span className={styles.links}>
                  {showMe && stop !== undefined ? (
                    <button
                      type="button"
                      className={styles.showMe}
                      onClick={() => {
                        close();
                        startFullTour(stop);
                      }}
                    >
                      Show me
                    </button>
                  ) : null}
                  {docs !== undefined ? (
                    <a
                      className={styles.showMe}
                      href={docsLink(docs)}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="help-read-more"
                    >
                      Read more
                      <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
                    </a>
                  ) : null}
                </span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
