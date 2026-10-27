/**
 * Settings, Keyboard: every key the editor has, in the shortcut sheet's groups, and a way to change
 * each one. A row is the action and its key as a chip (what it does is the row's hint): a press on the
 * chip waits for the new keys (`capturingKey`, so the editor's own handler runs nothing meanwhile) and
 * Esc cancels, a small x removes the key, and a reset arrow shows once the key is the person's own. An
 * action whose feature is off has no row. A key that another action has is settled there and then,
 * "Move it here" or Cancel, so the stored keymap never holds two overlapping keys. The keys no one can
 * change are listed after, each with its lock and the reason. In the desktop app a Desktop group adds
 * F10, which is fixed, and the Robot menu's keys, which are rows like the rest because the page tells
 * the menu its keys (`project/menuKeysSync.ts`) and read-only with an update note in a desktop app that
 * cannot be told (spec 15 section 8.5). Every check is `app/keymap.ts`; this file only draws it.
 */
import { useEffect, useState } from "react";
import { Lock, RotateCcw, X } from "lucide-react";
import {
  BINDINGS,
  KEY_ONLY,
  assignKey,
  chordOfEvent,
  currentKeymap,
  keyContext,
  keysLeftAfterMove,
  overlappingBindings,
  parseShortcut,
  refusalOf,
  validateBinding,
  writeChord,
  type Binding,
  type BindingGroup,
} from "../app/keymap";
import { RowButton, TextButton } from "../components/primitives";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import { SHEET_GROUPS } from "../help/ShortcutsOverlay";
import { DESKTOP_KEYS, type DesktopKeyId } from "../project/desktopKeys";
import { isDesktop } from "../project/desktop";
import { actionOffBy, actionShown, featureLabel, useFeatures, type FeatureSwitches } from "../state/features";
import { getState, setPrefs, setSetting, setStatus, useSelector } from "../state/store";
import { setCapturingKey } from "../state/ui";
import { Group, Row, useEscapeFirst } from "./parts";
import styles from "./Settings.module.css";

/** The binding's name, saying so when a switch in General hides the action: its key still counts. */
function nameOf(binding: Binding, features: FeatureSwitches): string {
  if (actionShown(binding.id, features)) return binding.label;
  // From the registry, so a switch Settings does not list, such as Full sim, still has its name.
  const feature = actionOffBy(binding.id, features);
  return `${binding.label} (hidden: ${feature === undefined ? "a feature" : featureLabel(feature)} is off)`;
}

const byId = (id: string): Binding | undefined => BINDINGS.find((binding) => binding.id === id);

/** The groups the rows are listed under: the sheet's, then Keys, as the sheet's Keys table. */
const KEYBOARD_GROUPS: readonly { title: string; groups: readonly BindingGroup[] }[] = [...SHEET_GROUPS, { title: "Keys", groups: ["keys"] }];

const reasonFor = (sample: string): string => refusalOf(parseShortcut(sample), keyContext()) ?? "";

/** F10 opens the desktop app's menu, and is the one desktop key that is always fixed (`project/desktopKeys.ts`). */
const MENU_ROW = { id: "menu", does: "Open the menu" } as const satisfies { id: DesktopKeyId; does: string };

/** True on a device with a touch screen and no fine pointer: a phone or a tablet with no keyboard case. */
function useTouchOnly(): boolean {
  const [touchOnly] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches,
  );
  return touchOnly;
}

/*
 * The section's own lines, as values: each says a state (a key taken, a default given way), a
 * warning (keys need a keyboard), or that nothing matches (UI_GUIDE section 9.13). What a control
 * does is in its tooltip.
 */
const PROMPT = "Press the new keys. Esc cancels.";
const TOUCH_NOTE = "Keys need a keyboard. Connect one to use them, or to change them here.";
const RESET_ALL_ASK = "Give every action its default key back?";
const noMatchLine = (filter: string): string => `No action or key matches “${filter}”.`;
const displacedLine = (binding: Binding): string =>
  `${binding.label} has no key now: its new default, ${binding.keys ?? ""}, is already one of your keys. Give it another below.`;
/** One binding the keys move from: its name, its plain label, and what it keeps (undefined: no key). */
interface Loser {
  name: string;
  plain: string;
  left: string | undefined;
}
const keeps = ({ plain, left }: Loser): string => (left === undefined ? `${plain} will have no key.` : `${plain} keeps ${left}.`);
/**
 * "V is Select's key. Select will have no key." A default such as `? or F1` can take from two
 * bindings at once, and then the line names each of them.
 */
const conflictLine = (keys: string, losers: readonly Loser[]): string => {
  const [only] = losers;
  if (losers.length === 1 && only !== undefined) return `${keys} is ${only.name}'s key. ${keeps(only)}`;
  return `${keys} is taken by ${losers.map((loser) => loser.name).join(" and ")}. ${losers.map(keeps).join(" ")}`;
};
/** The plain labels of the bindings `ids`, for the status line: "Switch theme and Clip ghosts". */
const labelsOf = (ids: readonly string[]): string => ids.map((id) => byId(id)?.label ?? id).join(" and ");

/** A key group no one can change: its name, its keys and the sentence on a long hover. */
interface FixedRow {
  id: string;
  name: string;
  keys: string;
  hint: string;
}

interface Capture {
  id: string;
  /** Why the last keys pressed were refused, while the row still waits for others. */
  refused?: string;
}

interface Conflict {
  id: string;
  keys: string;
  /** The bindings that have the keys now, which give them up on Move it here. */
  others: readonly string[];
  /** Reset, which gives the binding its default back, rather than Change. */
  reset: boolean;
}

export function KeyboardPane() {
  const overrides = useSelector((state) => state.prefs.keys);
  const features = useFeatures();
  const keymap = currentKeymap();
  const [filter, setFilter] = useState("");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [said, setSaid] = useState("");
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const touchOnly = useTouchOnly();

  // Esc answers an open prompt first: the key that clashes, or Reset all keys, and then the window (issue #414).
  useEscapeFirst(conflict !== null || confirmResetAll, () => {
    if (conflict !== null) setSaid(`Cancelled. ${byId(conflict.id)?.label ?? "It"} keeps its key.`);
    setConflict(null);
    setConfirmResetAll(false);
  });

  // A default that came in with a later version and was already one of the person's keys: said once.
  const [displaced] = useState(() => {
    const seen = getState().prefs.keysDisplacedSeen;
    return currentKeymap().displaced.filter((id) => !seen.includes(id));
  });
  useEffect(() => {
    if (displaced.length === 0) return;
    setPrefs({ keysDisplacedSeen: [...new Set([...getState().prefs.keysDisplacedSeen, ...displaced])] });
  }, [displaced]);

  // A key that changed is said on the status bar, as every other setting's change is (UI_GUIDE
  // 9.15); the hidden line keeps only the prompts, so a screen reader hears each line once.
  const done = (line: string): void => {
    setSaid("");
    setStatus("ok", line);
  };

  const commit = (id: string, keys: string | null | undefined): void => {
    setSetting("keys.bindings", assignKey(BINDINGS, getState().prefs.keys, id, keys, keyContext()));
  };

  // While a row waits for keys, every keystroke is its, before anything else on the page sees it.
  const capturing = capture?.id ?? null;
  useEffect(() => {
    if (capturing === null) return;
    const binding = byId(capturing);
    if (binding === undefined) return;
    setCapturingKey(true);
    const stop = (): void => {
      setCapture(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        stop();
        setSaid(`Cancelled. ${binding.label} keeps its key.`);
        return;
      }
      const chord = chordOfEvent(event);
      if (chord === "modifier") return;
      if (chord === undefined) {
        setCapture({ id: binding.id, refused: "That key cannot be a shortcut. Press other keys, or Esc to cancel." });
        setSaid("That key cannot be a shortcut. Press other keys, or Esc to cancel.");
        return;
      }
      const keys = writeChord(chord);
      const check = validateBinding(binding.id, keys, currentKeymap(), BINDINGS, keyContext());
      if (check.kind === "refused") {
        const line = `${keys}: ${check.reason} Press other keys, or Esc to cancel.`;
        setCapture({ id: binding.id, refused: line });
        setSaid(line);
        return;
      }
      stop();
      if (check.kind === "conflict") {
        // Every binding the keys take from, as Move it here takes them all: Turn's key takes its Shift twin too.
        const found = overlappingBindings(currentKeymap(), binding.id, check.keys);
        const others = found.length === 0 ? [check.other] : found;
        setConflict({ id: binding.id, keys: check.keys, others, reset: false });
        const holder = others.length === 1 ? `is ${labelsOf(others)}'s key` : `is taken by ${labelsOf(others)}`;
        setSaid(`${check.keys} ${holder}. Move it here, or Cancel.`);
        return;
      }
      commit(binding.id, check.keys);
      done(`${binding.label}: ${check.keys}.`);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    // A click anywhere else gives up waiting, as Esc does.
    const onPointerDown = (): void => {
      stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      setCapturingKey(false);
    };
  }, [capturing]);

  const change = (binding: Binding): void => {
    setConflict(null);
    setConfirmResetAll(false);
    setCapture({ id: binding.id });
    setSaid(`Press the new keys for ${binding.label}. Esc cancels.`);
  };

  const reset = (binding: Binding): void => {
    setCapture(null);
    const others = binding.keys === undefined ? [] : overlappingBindings(keymap, binding.id, binding.keys);
    if (binding.keys !== undefined && others.length > 0) {
      setConflict({ id: binding.id, keys: binding.keys, others, reset: true });
      const holder = others.length === 1 ? `is ${labelsOf(others)}'s key now` : `is taken by ${labelsOf(others)} now`;
      setSaid(`${binding.keys} ${holder}. Move it here, or Cancel.`);
      return;
    }
    setConflict(null);
    commit(binding.id, undefined);
    done(binding.keys === undefined ? `${binding.label} has no key again.` : `${binding.label}: ${binding.keys} again.`);
  };

  const needle = filter.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]): boolean =>
    needle === "" || texts.some((text) => text !== undefined && text.toLowerCase().includes(needle));

  // The desktop menu's keys have a group of their own, below (`desktopBindings`).
  // A feature that is switched off has no rows: its keys still count, and a key that clashes with one
  // names it, but the list is of what the person has (issue #414).
  const bindable = BINDINGS.filter(
    (binding) => binding.fixed === undefined && binding.desktop !== true && actionShown(binding.id, features),
  );
  const groups = KEYBOARD_GROUPS.map((group) => ({
    title: group.title,
    rows: bindable.filter(
      (binding) => group.groups.includes(binding.group) && matches(binding.label, binding.does, keymap.bindings.get(binding.id)?.keys),
    ),
  })).filter((group) => group.rows.length > 0);

  // The keys no one can change, one row for each group of keys (issue #414).
  const nudge = KEY_ONLY.find((row) => row.id === "nudge");
  const fixedRows: readonly FixedRow[] = [
    ...BINDINGS.filter((binding) => binding.fixed !== undefined && binding.desktop !== true).map((binding) => ({
      id: binding.id,
      name: binding.label,
      keys: binding.keys ?? "",
      hint: binding.fixed ?? "",
    })),
    {
      id: "nudge",
      name: "Arrow keys",
      keys: nudge?.keys ?? "← ↑ → ↓",
      hint: "Nudge the selected point or waypoint, or walk the step list. Shift nudges further.",
    },
    {
      id: "reorder",
      name: "Alt + arrows",
      keys: "Alt + ↑ ↓ ← →",
      hint: "Up and down move the selected step in the list; left and right go back or forward a screen.",
    },
    { id: "escape", name: "Escape", keys: "Esc", hint: `Cancel a drag, close a menu, clear the selection, or leave the tour. ${reasonFor("Esc")}` },
    { id: "tab", name: "Move focus", keys: "Tab, Shift Tab", hint: `Move focus to the next or previous control. ${reasonFor("Tab")}` },
    {
      id: "gestures",
      name: "Drag modifiers",
      keys: "Ctrl, Shift, Alt",
      hint: "They change a drag on the field, so they are not keys of their own. The mouse's side buttons go back and forward a screen.",
    },
  ].filter((row) => matches(row.name, row.keys, row.hint));

  // F10 is always fixed. The Robot keys are rows like any other when this desktop app takes the
  // menu keys message, and read-only with the update note when it is too old to.
  const menuRow = isDesktop() && matches(MENU_ROW.does, DESKTOP_KEYS.menu) ? MENU_ROW : null;
  const desktopBindings = isDesktop()
    ? BINDINGS.filter(
        (binding) => binding.desktop === true && actionShown(binding.id, features) && matches(binding.label, binding.does, keymap.bindings.get(binding.id)?.keys, binding.keys),
      )
    : [];
  const customCount = Object.keys(overrides).length;
  const nothing = groups.length === 0 && fixedRows.length === 0 && menuRow === null && desktopBindings.length === 0;

  /**
   * One binding's row (issue #414): the action and its key as a chip. A press on the chip waits for
   * the new key, a small × takes the key away, and once the key is the person's own a reset arrow
   * gives the default back. What the action does is the row's hint, on a long hover.
   */
  const bindingRow = (binding: Binding) => {
    const resolved = keymap.bindings.get(binding.id);
    const keys = resolved?.keys;
    const custom = resolved?.custom === true;
    const waiting = capture?.id === binding.id;
    const settling = conflict?.id === binding.id ? conflict : null;
    const name = nameOf(binding, features);
    return (
      <Row
        key={binding.id}
        label={name}
        hint={binding.does}
        testId={`keyboard-row-${binding.id}`}
        below={
          waiting ? (
            <p className={styles.note} data-testid="keyboard-prompt">
              {capture.refused ?? PROMPT}
            </p>
          ) : settling !== null ? (
            <ConflictLine
              conflict={settling}
              features={features}
              onMove={() => {
                commit(settling.id, settling.reset ? undefined : settling.keys);
                setConflict(null);
                done(`${binding.label}: ${settling.keys}.`);
              }}
              onCancel={() => {
                setConflict(null);
                setSaid(`Cancelled. ${binding.label} keeps its key.`);
              }}
            />
          ) : undefined
        }
      >
        <span className={styles.inline}>
          <Tooltip label={`${binding.label}: change the key`} hint={waiting ? "Press the new keys. Esc cancels." : "Press the new keys for it. Esc cancels."}>
            <button
              type="button"
              className={styles.keyButton}
              aria-pressed={waiting}
              data-testid={`keyboard-change-${binding.id}`}
              onClick={() => {
                if (waiting) setCapture(null);
                else change(binding);
              }}
            >
              {waiting ? (
                <span className={styles.valueDefault}>Press keys…</span>
              ) : keys === undefined ? (
                <span className={styles.valueDefault} data-testid={`keyboard-key-${binding.id}`}>
                  No key
                </span>
              ) : (
                <kbd className={styles.keyChip} data-custom={custom ? "" : undefined} data-testid={`keyboard-key-${binding.id}`}>
                  {keys}
                </kbd>
              )}
            </button>
          </Tooltip>
          {keys === undefined ? null : (
            <RowButton
              icon={X}
              label="Remove key"
              hint={`Leave ${binding.label} with no key.`}
              testId={`keyboard-remove-${binding.id}`}
              onClick={() => {
                setCapture(null);
                setConflict(null);
                commit(binding.id, null);
                done(`${binding.label} has no key now.`);
              }}
            />
          )}
          {custom ? (
            <RowButton
              icon={RotateCcw}
              label="Reset"
              hint={binding.keys === undefined ? `Leave ${binding.label} with no key, as it starts.` : `Give ${binding.label} its default key back: ${binding.keys}.`}
              testId={`keyboard-reset-${binding.id}`}
              onClick={() => {
                reset(binding);
              }}
            />
          ) : null}
        </span>
      </Row>
    );
  };

  return (
    <>
      {touchOnly ? (
        <p className={styles.paneNote} data-testid="keyboard-touch-note">
          {TOUCH_NOTE}
        </p>
      ) : null}
      {displaced.map((id) => {
        const binding = byId(id);
        return binding === undefined ? null : (
          <p key={id} className={styles.paneNote} data-testid="keyboard-displaced">
            {displacedLine(binding)}
          </p>
        );
      })}
      <div className={styles.keyboardTools}>
        <label className={styles.keyboardFilter}>
          <span className={styles.rowLabel}>Filter</span>
          <input
            type="search"
            className={styles.keyboardFilterInput}
            value={filter}
            placeholder="An action or a key"
            data-testid="keyboard-filter"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </label>
        {confirmResetAll ? (
          <ConfirmRow
            inline
            testId="keyboard-reset-all-ask"
            confirmTestId="keyboard-reset-all-confirm"
            cancelTestId="keyboard-reset-all-cancel"
            sentence={RESET_ALL_ASK}
            verb="Reset all keys"
            onConfirm={() => {
              setSetting("keys.bindings", {});
              setConfirmResetAll(false);
              setConflict(null);
              done("Every action has its default key again.");
            }}
            onCancel={() => {
              setConfirmResetAll(false);
            }}
          />
        ) : (
          <TextButton
            icon={RotateCcw}
            label="Reset all keys"
            hint="Give every action its default key back. Asks first."
            disabled={customCount === 0}
            whyDisabled="Every key is already its default."
            testId="keyboard-reset-all"
            onClick={() => {
              setCapture(null);
              setConfirmResetAll(true);
            }}
          />
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="keyboard-said">
        {said}
      </p>
      {groups.map((group) => (
        <Group key={group.title} title={group.title} compact testId={`keyboard-group-${group.title}`}>
          {group.rows.map(bindingRow)}
        </Group>
      ))}
      {fixedRows.length === 0 ? null : (
        <Group title="Fixed keys" compact testId="keyboard-group-fixed">
          {fixedRows.map((row) => (
            <Row key={row.id} label={row.name} hint={row.hint} testId={`keyboard-fixed-${row.id}`}>
              <span className={styles.inline}>
                <kbd className={styles.keyChip}>{row.keys}</kbd>
                <Lock size={16} strokeWidth={1.75} role="img" aria-label="Fixed" />
              </span>
            </Row>
          ))}
        </Group>
      )}
      {menuRow === null && desktopBindings.length === 0 ? null : (
        <Group title="Desktop" compact testId="keyboard-group-desktop">
          {menuRow === null ? null : (
            <Row label={menuRow.does} description={reasonFor("F10")} testId={`keyboard-desktop-${menuRow.id}`}>
              <span className={styles.inline}>
                <kbd className={styles.keyChip}>{DESKTOP_KEYS.menu}</kbd>
                <Lock size={16} strokeWidth={1.75} role="img" aria-label="Fixed" />
              </span>
            </Row>
          )}
          {desktopBindings.map((binding) =>
            binding.fixed === undefined ? (
              bindingRow(binding)
            ) : (
              <Row key={binding.id} label={binding.label} description={binding.fixed} testId={`keyboard-desktop-${binding.id}`}>
                <span className={styles.inline}>
                  <kbd className={styles.keyChip} data-testid={`keyboard-key-${binding.id}`}>
                    {keymap.bindings.get(binding.id)?.keys ?? binding.keys}
                  </kbd>
                  <Lock size={16} strokeWidth={1.75} role="img" aria-label="Fixed" />
                </span>
              </Row>
            ),
          )}
        </Group>
      )}
      {nothing ? (
        <p className={styles.paneNote} data-testid="keyboard-no-match">
          {noMatchLine(filter.trim())}
        </p>
      ) : null}
    </>
  );
}

/** "Ctrl E is Validate's key. Move it here (Validate will have no key) / Cancel". */
function ConflictLine({
  conflict,
  features,
  onMove,
  onCancel,
}: {
  conflict: Conflict;
  features: FeatureSwitches;
  onMove: () => void;
  onCancel: () => void;
}) {
  const keymap = currentKeymap();
  const losers = conflict.others.map((id): Loser => {
    const other = byId(id);
    return {
      name: other === undefined ? id : nameOf(other, features),
      plain: other?.label ?? id,
      left: keysLeftAfterMove(keymap, id, conflict.keys, conflict.id),
    };
  });
  return (
    <div className={styles.confirm} data-testid="keyboard-conflict">
      <span className={styles.note}>{conflictLine(conflict.keys, losers)}</span>
      <span className={styles.inline}>
        <TextButton label="Move it here" hint={`Give ${conflict.keys} to this action instead.`} testId="keyboard-move" onClick={onMove} />
        <TextButton label="Cancel" hint="Keep the keys as they are." testId="keyboard-cancel" onClick={onCancel} />
      </span>
    </div>
  );
}
