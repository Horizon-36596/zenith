/**
 * A right-click menu of actions from the one action table (`app/actions.ts`), so a menu item, its
 * toolbar button, its palette row and its shortcut always do the same thing and say the same
 * thing. Placed at the pointer and kept inside the viewport; Escape, a click outside, or choosing
 * an item closes it. A disabled item stays focusable and its tooltip says why.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actionById, isEnabled, shortcutOf, tooltipHint } from "../app/actions";
import { useEditor } from "../state/store";
import { Tooltip } from "./Tooltip";
import styles from "./ActionMenu.module.css";

export interface MenuEntry {
  /** An action id from `ACTIONS`, or a local item. */
  id: string;
  /** For a local item: its label, what it does, and what it runs. */
  label?: string;
  does?: string;
  run?: () => void;
  separatorBefore?: boolean;
}

export function ActionMenu({
  xPx,
  yPx,
  entries,
  onClose,
  label,
  testId,
}: {
  xPx: number;
  yPx: number;
  entries: readonly MenuEntry[];
  onClose: () => void;
  label: string;
  testId?: string;
}) {
  const state = useEditor();
  const root = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (box === undefined) return;
    setPlaced({
      left: Math.max(4, Math.min(xPx, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(yPx, window.innerHeight - box.height - 4)),
    });
  }, [xPx, yPx]);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={root}
      className={styles.menu}
      role="menu"
      aria-label={label}
      data-testid={testId}
      style={placed === null ? { left: xPx, top: yPx, visibility: "hidden" } : placed}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
          const at = items.indexOf(document.activeElement as HTMLElement);
          const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
          next?.focus();
          event.preventDefault();
        }
        event.stopPropagation();
      }}
    >
      {entries.map((entry) => {
        const action = actionById(entry.id);
        const text = action?.label ?? entry.label ?? entry.id;
        const enabled = action === undefined ? true : isEnabled(action, state);
        const hint = action === undefined ? entry.does : tooltipHint(action, state);
        const shortcut = action === undefined ? undefined : shortcutOf(action);
        const Icon = action?.icon;
        return (
          <div key={entry.id}>
            {entry.separatorBefore === true ? <div className={styles.separator} role="separator" /> : null}
            <Tooltip label={text} hint={hint} side="right">
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                aria-disabled={!enabled}
                data-testid={`menu-${entry.id}`}
                onClick={() => {
                  if (!enabled) return;
                  onClose();
                  if (action !== undefined) void action.run();
                  else entry.run?.();
                }}
              >
                <span className={styles.icon}>
                  {Icon === undefined ? null : <Icon size={14} strokeWidth={1.5} aria-hidden />}
                </span>
                <span className={styles.label}>{text}</span>
                {shortcut === undefined ? null : <kbd className={styles.shortcut}>{shortcut}</kbd>}
              </button>
            </Tooltip>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
