/**
 * A right-click menu of actions from the one action table (`app/actions.ts`), so a menu item, its
 * toolbar button, its palette row and its shortcut always do the same thing and say the same
 * thing. Placed at the pointer and kept inside the viewport; Escape, a click outside, or choosing
 * an item closes it. A disabled item stays focusable and its tooltip says why. The provenance chip
 * opens the same menu with local entries to pick a label from (`ProvenancePicker`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { actionById, isEnabled, labelOf, shortcutOf, tooltipHint } from "../app/actions";
import { actionShown } from "../state/features";
import { useEditor } from "../state/store";
import { Tooltip } from "./Tooltip";
import { usePopoverLayer } from "./popoverLayer";
import { focusForInput } from "./inputModality";
import styles from "./ActionMenu.module.css";

/** Every entry of the menu, plain or one of a set of choices. */
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

export interface MenuEntry {
  /** An action id from `ACTIONS`, or a local item. */
  id: string;
  /** For a local item: its label, what it does, and what it runs. */
  label?: string;
  does?: string;
  run?: () => void;
  /** For a local item: its icon, and why it cannot run now (it then shows disabled and says so). */
  icon?: LucideIcon;
  whyDisabled?: string | null;
  separatorBefore?: boolean;
  /**
   * Set on every entry of a menu that picks one value: the chosen one is true. Such an entry is a
   * `menuitemradio` and shows a check in its icon column.
   */
  checked?: boolean;
  /**
   * Set on an action whose toolbar button shows a state (a tool, Snap, Extend this chain): the entry
   * is a `menuitemcheckbox`, checked while the action is active, with a check in its icon column, so
   * the toolbar's More menu says what its buttons would (0.1.2 UX sweep batch review).
   */
  toggle?: boolean;
  /** An entry that deletes: it comes last, after a separator, in the error tone (UI_GUIDE 9.10). */
  danger?: boolean;
}

export function ActionMenu({
  xPx,
  yPx,
  entries,
  onClose,
  label,
  testId,
  children,
}: {
  xPx: number;
  yPx: number;
  entries: readonly MenuEntry[];
  onClose: () => void;
  label: string;
  testId?: string;
  /** Anything shown above the entries, such as a field the entries read when chosen. */
  children?: ReactNode;
}) {
  const state = useEditor();
  const layer = usePopoverLayer();
  const root = useRef<HTMLDivElement | null>(null);
  // What had focus as the menu opened, read while rendering before the menu takes focus, so that
  // closing it from the keyboard gives focus back there for every caller (issue #313).
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  const closeFromKeyboard = (): void => {
    const opener = openerRef.current ?? null;
    onClose();
    if (opener !== null && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
  };
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (box === undefined) return;
    setPlaced({
      left: Math.max(4, Math.min(xPx, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(yPx, window.innerHeight - box.height - 4)),
    });
  }, [xPx, yPx]);

  // Focus waits until the menu is placed: before that it is `visibility: hidden`, and a hidden
  // element cannot take focus, so a menu opened from the keyboard would leave focus behind it.
  const shown = placed !== null;
  useEffect(() => {
    if (!shown) return;
    const items = root.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [];
    focusForInput([...items].find((item) => item.getAttribute("aria-checked") === "true") ?? items[0]);
  }, [shown]);

  useEffect(() => {
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
          closeFromKeyboard();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
          const at = items.indexOf(document.activeElement as HTMLElement);
          const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
          next?.focus();
          event.preventDefault();
        } else if (event.key === "Tab") {
          // Tab past either end leaves the menu, as a menu should: it closes, and focus goes back to
          // what opened it rather than on into the page behind a modal.
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button, input")];
          const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
          if (edge === undefined || document.activeElement === edge) {
            event.preventDefault();
            closeFromKeyboard();
          }
        }
        event.stopPropagation();
      }}
    >
      {children}
      {entries.filter((entry) => actionShown(entry.id, state.prefs.features)).map((entry) => {
        const action = actionById(entry.id);
        // An entry's own label and reason win over its action's: the step menu counts the steps an
        // item acts on, and says why steps cannot be wrapped together (issue #411).
        const text = entry.label ?? (action === undefined ? entry.id : labelOf(action, state));
        const localWhy = entry.whyDisabled ?? null;
        const actionOn = action === undefined || isEnabled(action, state);
        const enabled = actionOn && localWhy === null;
        const hint =
          action !== undefined && (!actionOn || localWhy === null)
            ? tooltipHint(action, state)
            : localWhy === null
              ? entry.does
              : `Unavailable: ${localWhy}`;
        const shortcut = action === undefined ? undefined : shortcutOf(action);
        const Icon = action?.icon ?? entry.icon;
        const toggle = entry.toggle === true && action?.active !== undefined;
        const checked = toggle ? action.active?.(state) === true : entry.checked;
        return (
          <div key={entry.id}>
            {entry.separatorBefore === true ? <div className={styles.separator} role="separator" /> : null}
            <Tooltip label={text} hint={hint} side="right">
              <button
                type="button"
                role={toggle ? "menuitemcheckbox" : checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={checked}
                className={styles.item}
                aria-disabled={!enabled}
                data-danger={entry.danger === true ? "true" : undefined}
                data-testid={`menu-${entry.id}`}
                onClick={() => {
                  if (!enabled) return;
                  onClose();
                  if (action !== undefined) void action.run();
                  else entry.run?.();
                }}
              >
                <span className={styles.icon}>
                  {checked === true ? (
                    <Check size={16} strokeWidth={1.75} aria-hidden />
                  ) : Icon === undefined ? null : (
                    <Icon size={16} strokeWidth={1.75} aria-hidden />
                  )}
                </span>
                <span className={styles.label}>{text}</span>
                {action?.external === true ? (
                  <ExternalLink className={styles.external} size={12} strokeWidth={1.75} role="img" aria-label="Opens in a new tab" data-testid="external-mark" />
                ) : null}
                {shortcut === undefined ? null : <kbd className={styles.shortcut}>{shortcut}</kbd>}
              </button>
            </Tooltip>
          </div>
        );
      })}
    </div>,
    layer,
  );
}
