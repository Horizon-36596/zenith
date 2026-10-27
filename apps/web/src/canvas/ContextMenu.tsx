/**
 * The canvas's right-click menu (site/docs/editor.md). The canvas renders it; the
 * items come from the shell's `canvasActions` (the same action table as the shortcuts and the
 * palette, so the three never disagree) followed by the canvas's own few. Each item shows its
 * shortcut, and a disabled item says why, inline under its label and in the shared tooltip.
 *
 * A disabled item is `aria-disabled`, not `disabled`, so it stays focusable: the arrows reach it, and
 * hover or focus shows its reason. Clicking it or pressing Enter on it does nothing.
 *
 * Each row leads with its action's 16 px icon at stroke 1.75, as every menu does (UI_GUIDE 9.10), or
 * a choice's check. Focus moved here by code draws a ring only when a key opened the menu.
 *
 * Keyboard: focus lands on the first enabled item; the arrows move through every item, Enter or
 * Space runs, Esc or Tab closes. A press anywhere outside closes it too.
 *
 * Placement (issue #412): always in window coordinates, `position: fixed` and portalled to the page,
 * so the menu opens where the person clicked, whatever panel it was opened from. Its top is at the
 * pointer, or it flips to end at the pointer when it would leave the window below; a menu taller
 * than the room on either side is kept inside the window and scrolls.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { focusForInput } from "../components/inputModality.js";
import { Tooltip } from "../components/Tooltip.js";
import styles from "./canvas.module.css";
import type { CanvasAction } from "./types.js";

export interface ContextMenuProps {
  /** Where the pointer was, in CSS pixels in the window (`clientX` and `clientY`). */
  xPx: number;
  yPx: number;
  items: readonly CanvasAction[];
  onClose(): void;
  /**
   * Kept so the callers from before issue #412 still compile: every menu is now placed in the
   * window, which is what this used to ask for.
   */
  fixed?: boolean;
  /** Its accessible name and where tests find it; the canvas's own by default. */
  label?: string;
  testId?: string;
}

/** The room kept between the menu and the window's edge, in CSS pixels. */
const EDGE_PX = 4;

export interface MenuPlace {
  left: number;
  top: number;
  /** Set when the menu fits neither below nor above the pointer, so it scrolls inside the window. */
  maxHeightPx?: number;
}

/**
 * Where a menu `widthPx` x `heightPx` opened at the pointer (`xPx`, `yPx`) goes in a window
 * `roomW` x `roomH` (issue #412): its top-left at the pointer, flipped to the pointer's left, or to
 * end just above it, when it would leave the window. When it fits neither below nor above, it is
 * kept inside the window at its full height or the window's, and scrolls.
 */
export function placeMenu(xPx: number, yPx: number, widthPx: number, heightPx: number, roomW: number, roomH: number): MenuPlace {
  const left = xPx + widthPx <= roomW - EDGE_PX ? xPx : Math.max(EDGE_PX, xPx - widthPx);
  if (yPx + heightPx <= roomH - EDGE_PX) return { left, top: yPx };
  if (yPx - heightPx >= EDGE_PX) return { left, top: yPx - heightPx };
  const maxHeightPx = Math.max(roomH - 2 * EDGE_PX, 1);
  const shown = Math.min(heightPx, maxHeightPx);
  return { left, top: Math.max(EDGE_PX, roomH - EDGE_PX - shown), maxHeightPx };
}

export function ContextMenu({
  xPx,
  yPx,
  items,
  onClose,
  label = "Canvas actions",
  testId = "canvas-context-menu",
}: ContextMenuProps): ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<MenuPlace>({ left: xPx, top: yPx });

  // Flip to stay inside the window once the menu's own size is known.
  useLayoutEffect(() => {
    const menu = listRef.current;
    if (menu === null) return;
    // Its whole height with its borders, even while a cap from an earlier place makes it scroll.
    const height = menu.scrollHeight + (menu.offsetHeight - menu.clientHeight);
    setPlace(placeMenu(xPx, yPx, menu.offsetWidth, height, window.innerWidth, window.innerHeight));
  }, [xPx, yPx, items]);

  useEffect(() => {
    const first =
      listRef.current?.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])') ??
      listRef.current?.querySelector<HTMLButtonElement>("button");
    // A right-click opens it with no ring on the first item; Shift F10 or the menu key draws one.
    focusForInput(first);
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

  // Every row keeps the leading column once any row has an icon, so the labels line up (UI_GUIDE 9.10).
  const lead = items.some((item) => item.icon !== undefined);

  const menu = (
    <div
      ref={listRef}
      role="menu"
      aria-label={label}
      className={styles.menu}
      style={{
        left: place.left,
        top: place.top,
        ...(place.maxHeightPx === undefined ? {} : { maxHeight: place.maxHeightPx, overflowY: "auto" as const }),
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      data-testid={testId}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore === true ? <div className={styles.separator} role="separator" /> : null}
          {item.groupLabel === undefined ? null : (
            <div className={styles.groupLabel} role="presentation" data-testid="canvas-menu-group">
              {item.groupLabel}
            </div>
          )}
          {item.enabled && item.hint === undefined ? (
            menuButton(item, onClose, lead)
          ) : item.enabled ? (
            <Tooltip label={item.label} shortcut={item.shortcut} hint={item.hint} side="right">
              {menuButton(item, onClose, lead)}
            </Tooltip>
          ) : (
            <Tooltip label={item.label} shortcut={item.shortcut} hint={item.disabledReason} side="right">
              {menuButton(item, onClose, lead)}
            </Tooltip>
          )}
        </div>
      ))}
    </div>
  );
  return createPortal(menu, document.body);
}

/**
 * One item's button. A plain element, not a component, so the Tooltip's cloned ref and handlers land
 * on the button itself. With `lead`, the row starts with the menu's 16 px leading column: the item's
 * icon, a choice's check, or an empty slot of the same width.
 */
export function menuButton(item: CanvasAction, onClose: () => void, lead: boolean): ReactElement {
  const Icon = item.icon;
  const reason = item.enabled || item.disabledReason === undefined || item.disabledReason === "" ? null : item.disabledReason;
  return (
    <button
      type="button"
      role={item.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={item.checked}
      className={styles.item}
      aria-disabled={item.enabled ? undefined : true}
      data-action={item.id}
      data-has-reason={reason === null ? undefined : "true"}
      data-lead={lead || item.checked !== undefined ? "true" : undefined}
      onClick={() => {
        if (!item.enabled) return;
        onClose();
        item.run();
      }}
    >
      <span className={styles.itemText}>
        <span className={styles.itemLabel}>
          {item.checked !== undefined ? (
            <span className={styles.check} aria-hidden>
              {item.checked ? <Check size={16} strokeWidth={1.75} /> : null}
            </span>
          ) : lead ? (
            <span className={styles.icon} aria-hidden data-testid="canvas-menu-icon">
              {Icon === undefined ? null : <Icon size={16} strokeWidth={1.75} />}
            </span>
          ) : null}
          {item.label}
        </span>
        {reason === null ? null : (
          <span className={styles.reason} data-testid="canvas-menu-reason">
            {reason}
          </span>
        )}
      </span>
      <span className={styles.shortcut}>{item.shortcut ?? ""}</span>
    </button>
  );
}

export default ContextMenu;
