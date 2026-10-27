/**
 * The shortcut overlay (`?` or `F1`) in two tabs (issue #414). Keys lists every keyboard shortcut in
 * the action table once, with a note where one key does two things (S and C also work on a selected
 * curve point), the keys that have no action of their own (nudging, turning, stepping the playhead),
 * and in the desktop app the keys its menu owns. Mouse lists every canvas gesture and drag modifier.
 * Every table is whole, so every column starts with its heading. It shows the keys as the person has
 * them (`app/keymap.ts`): an action they left with no key is not listed, and a key of their own carries
 * a small dot. Change keys, beside Full guide in the title row, opens Settings, Keyboard; it sits there
 * rather than on a line of its own because the sheet has no height to spare at 1280 by 720. The sheet
 * itself takes the focus when it opens.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { docsLink } from "../account/config";
import { ACTIONS, actionById, pageShortcutOf, shortcutOf, type ActionGroup } from "../app/actions";
import { bindingKeys, isCustomKey, keyOnlyRows, stepKeys, turnLabel, type KeyOnlyRow } from "../app/keymap";
import { DESKTOP_KEYS, type DesktopKeyId } from "../project/desktopKeys";
import { Modal } from "../dialogs/Modal";
import { actionShown, getFeatures } from "../state/features";
import {
  DEFAULT_EDITING_NUMBERS,
  editingNumbers,
  formatInches,
  formatSeconds,
  type EditingNumbers,
} from "../settings/editingNumbers";
import { setDialog, useEditor } from "../state/store";
import { openSettings } from "../settings/store";
import { CANVAS_HELP } from "../canvas/help";
import { canvasHelp } from "./canvasHelp";
import styles from "./help.module.css";

interface Row {
  keys: string;
  does: string;
  /** The longer sentence, shown on hover, when `does` is only the action's name. */
  more?: string;
  /** Where the same key does a second thing, in a few words: "On a selected curve point: make it smooth." */
  note?: string;
  /** The key is the person's own, set in Settings, Keyboard. */
  custom?: boolean;
  /** A row of two bindings (the playhead's steps): a chip for each, each with its own dot. */
  parts?: readonly { keys: string; custom: boolean }[];
}

/** One key chip, with the small dot on its corner when the key is the person's own. */
function Chip({ keys, custom }: { keys: string; custom: boolean }) {
  return (
    <kbd>
      {keys}
      {/* On the chip's corner, so a key of the person's own adds no width or height to its row. */}
      {custom ? <span className={styles.customDot} role="img" aria-label="your own key" data-testid="shortcut-custom" /> : null}
    </kbd>
  );
}

/** The sheet's groups of actions, which Settings, Keyboard lists its rows under too. */
export const SHEET_GROUPS: readonly { title: string; groups: readonly ActionGroup[] }[] = [
  { title: "Tools", groups: ["tool"] },
  { title: "Editing", groups: ["edit", "insert"] },
  { title: "Project and help", groups: ["project", "help"] },
  { title: "Run and view", groups: ["run", "view"] },
];

function rowsFor(groups: readonly ActionGroup[], seen: Set<string> = new Set<string>()): Row[] {
  const features = getFeatures();
  return ACTIONS.flatMap((action) => {
    const keys = pageShortcutOf(action);
    if (keys === undefined || action.sheetRow === false || !actionShown(action.id, features) || !groups.includes(action.group) || seen.has(keys)) return [];
    seen.add(keys);
    return [{ keys, does: action.label, more: action.does, custom: isCustomKey(action.id) }];
  });
}

/**
 * The desktop app's own keys, which its native menu handles (project/desktopKeys.ts). Only the
 * desktop app has the actions they run, so a browser build gets no rows and no Desktop group.
 */
export function desktopRows(): Row[] {
  if (!ACTIONS.some((action) => action.menuShortcut !== undefined)) return [];
  // Short names, so each row stays on one line in the sheet's narrow columns.
  const rows: { id: DesktopKeyId; does: string }[] = [
    { id: "menu", does: "Open the menu" },
    { id: "desktop.sim", does: "High-fidelity sim" },
    { id: "desktop.deploy", does: "Deploy autos" },
    { id: "desktop.git", does: "Commit and push" },
  ];
  const features = getFeatures();
  // The Robot keys as the person has them (Settings, Keyboard); one they removed is not listed, and
  // the high-fidelity sim's row goes with the Full sim switch (issue #207), as its menu item does.
  return rows.flatMap((row) => {
    if (!actionShown(row.id, features)) return [];
    const action = actionById(row.id);
    const keys = action === undefined ? DESKTOP_KEYS[row.id] : shortcutOf(action) ?? (row.id === "menu" ? DESKTOP_KEYS.menu : undefined);
    return keys === undefined ? [] : [{ keys, does: row.does, more: action?.does, ...(action !== undefined && isCustomKey(action.id) ? { custom: true } : {}) }];
  });
}

/** What the step row says for the half that has a key, by the person's own scrub step. */
function stepDoes(id: string, numbers: EditingNumbers): string | undefined {
  const by = formatSeconds(numbers.scrubStepS);
  if (id === "keys.stepBack") return `Step the playhead back ${by}.`;
  if (id === "keys.stepForward") return `Step the playhead forward ${by}.`;
  return undefined;
}

/**
 * A key-only row as the person has it (issue #290): Turn, the playhead's two steps and Next panel
 * show their own keys, and a row whose keys were all removed is left out. The two steps stay one row,
 * a chip for each, since the sheet has no height for another.
 */
function ownRow(row: KeyOnlyRow, numbers: EditingNumbers): Row[] {
  if (row.bindings === undefined) return [{ keys: row.keys, does: row.does }];
  if (row.id === "stepTime") {
    const halves = stepKeys();
    const only = halves.length === 1 ? halves[0] : undefined;
    if (halves.length === 0) return [];
    return [
      {
        keys: halves.map((half) => half.keys).join(" "),
        does: only === undefined ? row.does : stepDoes(only.id, numbers) ?? row.does,
        parts: halves.map((half) => ({ keys: half.keys, custom: isCustomKey(half.id) })),
      },
    ];
  }
  const id = row.bindings[0];
  if (id === undefined) return [];
  // Turn's chip names both ways, `R / Shift R`.
  const keys = id === "keys.rotate" ? turnLabel(bindingKeys(id)) : bindingKeys(id);
  return keys === undefined ? [] : [{ keys, does: row.does, custom: isCustomKey(id) }];
}

/**
 * The keys with no action of their own, with the two nudge rows folded into one: the sheet has only
 * a few pixels to spare at 1280 by 720, and Shift F1 took the last of them (issue #237).
 */
export function keyRows(numbers: EditingNumbers = DEFAULT_EDITING_NUMBERS): Row[] {
  const rows = keyOnlyRows(numbers);
  const nudge = rows.find((row) => row.id === "nudge");
  const far = rows.find((row) => row.id === "nudgeFar");
  if (nudge === undefined || far === undefined) return rows.flatMap((row) => ownRow(row, numbers));
  const folded: Row = {
    keys: `${nudge.keys}, ${far.keys}`,
    does: `Move the selected point or waypoint by ${formatInches(numbers.nudgeIn)}, or ${formatInches(numbers.nudgeFarIn)} with Shift.`,
  };
  return rows.flatMap((row) => (row === nudge ? [folded] : row === far ? [] : ownRow(row, numbers)));
}

/**
 * A table of keys with its heading. `long` tables, whose descriptions are sentences, run each
 * sentence on after its key. A table is never split between columns, so each column of the sheet
 * starts with a heading.
 */
function Table({
  title,
  rows,
  testId,
  long = false,
}: {
  title: string;
  rows: readonly Row[];
  testId?: string;
  long?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className={styles.keysSection} data-testid={testId} data-long={long ? "" : undefined}>
      <h3 className={styles.keysTitle}>{title}</h3>
      <dl className={styles.keys}>
        {rows.map((row) => (
          <div className={styles.keyRow} key={`${row.keys}:${row.does}`} title={row.more}>
            <dt className={styles.keyCap}>
              {row.parts === undefined ? (
                <Chip keys={row.keys} custom={row.custom === true} />
              ) : (
                row.parts.map((part, index) => (
                  <span key={part.keys}>
                    {index === 0 ? null : " "}
                    <Chip keys={part.keys} custom={part.custom} />
                  </span>
                ))
              )}
            </dt>
            <dd className={styles.keyDoes}>
              {row.does}
              {row.note === undefined ? null : <span className={styles.keyNote}> {row.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Whether the person gave a key to an action that has none by default (`EXTRA_BINDABLE`), which
 * adds its row to the sheet: then the rows close up so the sheet still fits.
 */
function extraRowsShown(): boolean {
  const features = getFeatures();
  return ACTIONS.some((action) => action.shortcut === undefined && actionShown(action.id, features) && pageShortcutOf(action) !== undefined);
}

/**
 * The canvas gestures that are one key, which the Keys tab lists with the other keys: S and C act on
 * a selected curve point, F zooms, and Esc is already a key row. The Mouse tab keeps the rest.
 */
const isKeyGesture = (gesture: string): boolean => /^(Esc|[A-Z])$/.test(gesture);

/** The note a key's row carries where the same key does a second thing on the canvas. */
function canvasKeyNotes(): ReadonlyMap<string, string> {
  return new Map([
    ["S", "On a selected curve point: make it smooth."],
    ["C", "On a selected curve point: make it a corner."],
  ]);
}

/** Every key on the Keys tab, in its tables: each key once, with a note where it has a second meaning. */
export function sheetTables(numbers: EditingNumbers): { title: string; rows: Row[]; long?: boolean; testId?: string }[] {
  const seen = new Set<string>();
  const notes = canvasKeyNotes();
  const tables = SHEET_GROUPS.map((group) => ({
    title: group.title,
    rows: rowsFor(group.groups, seen).map((row) => {
      const note = notes.get(row.keys);
      return note === undefined ? row : { ...row, note };
    }),
  }));
  // Rename waypoint has no row of its own in the action table, to save the sheet height; its key is a
  // row of Editing here, where the Mouse tab's "double-click a pin" no longer says it (issue #414).
  const rename = actionById("waypoint.rename");
  const renameKeys = rename !== undefined && actionShown(rename.id, getFeatures()) ? pageShortcutOf(rename) : undefined;
  if (rename !== undefined && renameKeys !== undefined && !seen.has(renameKeys)) {
    seen.add(renameKeys);
    tables.find((table) => table.title === "Editing")?.rows.push({ keys: renameKeys, does: "Rename waypoint", more: rename.does });
  }
  // A key the canvas gives a meaning that no action has, such as F, is a row of its own.
  const extra: Row[] = canvasHelp()
    .filter((row) => isKeyGesture(row.gesture) && row.gesture !== "Esc" && !notes.has(row.gesture) && !seen.has(row.gesture))
    .map((row) => ({ keys: row.gesture, does: row.does }));
  // "Other keys", not "Keys": the tab itself is Keys (0.1.2 UX sweep, W1-11).
  return [...tables, { title: "Other keys", rows: [...keyRows(numbers), ...extra], long: true }, { title: "Desktop", rows: desktopRows(), testId: "shortcuts-desktop" }];
}

/** The titles the Mouse tab's tables take, by gesture id (`canvas/help.ts`). A gesture in none is under More. */
const MOUSE_GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: "Select", ids: ["select", "addToSelection", "marquee"] },
  { title: "Move and turn", ids: ["groupDrag", "startPose", "headingHandle", "rangeBoundary", "envelopeEdit", "wallSnap"] },
  { title: "While dragging", ids: ["invertSnap", "noQuantise", "axis", "heading45", "breakMirror"] },
  { title: "Add and change", ids: ["addPoint", "splitPath", "pathMenu", "contextMenu", "measure"] },
  { title: "Look around", ids: ["pan", "zoom", "fit", "hover"] },
];

/** The Mouse tab's tables: the canvas's gestures and drag modifiers, grouped, none of them a lone key. */
export function mouseTables(): { title: string; rows: Row[] }[] {
  const listed = new Set(MOUSE_GROUPS.flatMap((group) => group.ids));
  const gestures = CANVAS_HELP.filter((entry) => !isKeyGesture(entry.gesture));
  const tables = MOUSE_GROUPS.map((group) => ({
    title: group.title,
    rows: group.ids.flatMap((id) => {
      const entry = gestures.find((one) => one.id === id);
      return entry === undefined ? [] : [{ keys: entry.gesture, does: entry.action }];
    }),
  }));
  const more = gestures.filter((entry) => !listed.has(entry.id)).map((entry) => ({ keys: entry.gesture, does: entry.action }));
  return more.length === 0 ? tables : [...tables, { title: "More", rows: more }];
}

type SheetTab = "keys" | "mouse";

const TABS: readonly { id: SheetTab; label: string }[] = [
  { id: "keys", label: "Keys" },
  { id: "mouse", label: "Mouse" },
];

export function ShortcutsOverlay() {
  const numbers = editingNumbers(useEditor().prefs);
  const [tab, setTab] = useState<SheetTab>("keys");
  const sheet = useRef<HTMLDivElement | null>(null);
  // The sheet takes the focus, not the Change keys link: the dialog focuses the first control it
  // finds, which is a link in the title row, so this runs after it has (issue #414).
  useEffect(() => {
    queueMicrotask(() => {
      sheet.current?.focus({ preventScroll: true });
    });
  }, []);
  return (
    <Modal
      title="Shortcuts and gestures"
      testId="shortcuts-overlay"
      width={1240}
      tall
      closeButton
      titleAside={
        <span className={styles.sheetLinks}>
          <button
            type="button"
            className={styles.sheetLink}
            data-testid="shortcuts-change-keys"
            onClick={() => {
              setDialog(null);
              openSettings("keyboard");
            }}
          >
            Change keys
          </button>
          <a
          className={styles.guideLink}
          href={docsLink("editor/#keyboard-reference")}
          target="_blank"
          rel="noreferrer"
          data-testid="shortcuts-guide-link"
        >
          Full guide
          <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
        </a>
        </span>
      }
      onClose={() => {
        setDialog(null);
      }}
    >
      <div ref={sheet} className={styles.sheet} tabIndex={-1} data-testid="shortcuts-sheet">
        <div
          className={styles.sheetTabs}
          role="tablist"
          aria-label="Shortcuts"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            const next = tab === "keys" ? "mouse" : "keys";
            setTab(next);
            requestAnimationFrame(() => {
              sheet.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
            });
          }}
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`shortcuts-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`shortcuts-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={styles.sheetTab}
              data-tab={id}
              data-testid={`shortcuts-tab-${id}`}
              onClick={() => {
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "keys" ? (
          <div
            className={styles.keysGrid}
            role="tabpanel"
            id="shortcuts-panel-keys"
            aria-labelledby="shortcuts-tab-keys"
            data-dense={extraRowsShown() ? "" : undefined}
            data-testid="shortcuts-keys"
          >
            {sheetTables(numbers).map((table) => (
              <Table key={table.title} title={table.title} rows={table.rows} testId={table.testId} long={table.long === true} />
            ))}
          </div>
        ) : (
          <div
            className={styles.keysGrid}
            role="tabpanel"
            id="shortcuts-panel-mouse"
            aria-labelledby="shortcuts-tab-mouse"
            data-wide=""
            data-testid="shortcuts-canvas"
          >
            {mouseTables().map((table) => (
              <Table key={table.title} title={table.title} rows={table.rows} long />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
