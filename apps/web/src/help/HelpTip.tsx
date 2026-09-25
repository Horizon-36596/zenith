/**
 * The `?` beside every region title and inspector section header (site/docs/editor.md, UI_GUIDE
 * section 9.3). Hover opens it after `--help-delay`, focus opens it at once, and a click pins it
 * open until a second click, Escape or a click elsewhere. The text is the
 * `PANEL_HELP` entry, and when the full tour has a stop for this panel a "Show me" link starts it
 * there.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PANEL_HELP, type PanelHelpId } from "./content";
import { startFullTour, stopFor } from "../tour/store";
import { getState } from "../state/store";
import { claim, focusFromKeyboard, release } from "../components/tooltipGate";
import styles from "./help.module.css";

/** `--help-delay`, read once: the ? opens faster than a tooltip because the user is asking. */
const HELP_DELAY_MS = 150;
const OFFSET_PX = 8;

export function HelpTip({ id, side = "bottom" }: { id: PanelHelpId; side?: "bottom" | "left" }) {
  const entry = PANEL_HELP[id];
  const popId = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const stop = stopFor(id);

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
      if (event.key === "Escape") close();
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
          if (focusFromKeyboard(event.currentTarget)) show();
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
              {stop === undefined || getState().auto === null ? null : (
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
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
