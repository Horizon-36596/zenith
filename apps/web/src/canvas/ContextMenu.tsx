/**
 * The canvas's right-click menu (site/docs/editor.md). The canvas renders it; the
 * items come from the shell's `canvasActions` (the same action table as the shortcuts and the
 * palette, so the three never disagree) followed by the canvas's own few. Each item shows its
 * shortcut, and a disabled item says why in the shared tooltip.
 *
 * A disabled item is `aria-disabled`, not `disabled`, so it stays focusable: the arrows reach it, and
 * hover or focus shows its reason. Clicking it or pressing Enter on it does nothing.
 *
 * Keyboard: focus lands on the first enabled item; the arrows move through every item, Enter or
 * Space runs, Esc or Tab closes. A press anywhere outside closes it too.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Tooltip } from "../components/Tooltip.js";
import styles from "./canvas.module.css";
import type { CanvasAction } from "./types.js";

export interface ContextMenuProps {
  /** Where the pointer was, in CSS pixels inside the canvas host. */
  xPx: number;
  yPx: number;
  items: readonly CanvasAction[];
  onClose(): void;
}

export function ContextMenu({ xPx, yPx, items, onClose }: ContextMenuProps): ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState({ left: xPx, top: yPx });

  // Flip to stay inside the canvas host, once the menu's own size is known.
  useLayoutEffect(() => {
    const menu = listRef.current;
    const host = menu?.offsetParent as HTMLElement | null;
    if (menu === null || host === null) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = xPx + width > host.clientWidth - 4 ? Math.max(4, xPx - width) : xPx;
    const top = yPx + height > host.clientHeight - 4 ? Math.max(4, yPx - height) : yPx;
    setPlace({ left, top });
  }, [xPx, yPx, items]);

  useEffect(() => {
    const first =
      listRef.current?.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])') ??
      listRef.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (listRef.current !== null && !listRef.current.contains(event.target as Node)) onClose();
    };
    const onBlur = (): void => {
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  const move = (direction: 1 | -1): void => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.findIndex((button) => button === document.activeElement);
    const next = buttons[(at + direction + buttons.length) % buttons.length];
    next?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The menu owns the keyboard while it is open, so nothing leaks to the shell's shortcuts.
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  };

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label="Canvas actions"
      className={styles.menu}
      style={{ left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      data-testid="canvas-context-menu"
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore === true ? <div className={styles.separator} role="separator" /> : null}
          {item.enabled ? (
            menuButton(item, onClose)
          ) : (
            <Tooltip label={item.label} shortcut={item.shortcut} hint={item.disabledReason} side="right">
              {menuButton(item, onClose)}
            </Tooltip>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One item's button. A plain element, not a component, so the Tooltip's cloned ref and handlers land
 * on the button itself.
 */
function menuButton(item: CanvasAction, onClose: () => void): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.item}
      aria-disabled={item.enabled ? undefined : true}
      data-action={item.id}
      onClick={() => {
        if (!item.enabled) return;
        onClose();
        item.run();
      }}
    >
      <span>{item.label}</span>
      <span className={styles.shortcut}>{item.shortcut ?? ""}</span>
    </button>
  );
}

export default ContextMenu;
