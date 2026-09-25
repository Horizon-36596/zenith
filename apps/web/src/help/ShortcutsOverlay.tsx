/**
 * The shortcut overlay (`?` or `F1`): every keyboard shortcut in the action table, the keys that
 * have no action of their own (nudging, turning, stepping the playhead), and every canvas gesture
 * and drag modifier, grouped so it reads top to bottom (site/docs/editor.md).
 */
import { ACTIONS, shortcutOf, type ActionGroup } from "../app/actions";
import { KEY_ONLY } from "../app/keymap";
import { Modal } from "../dialogs/Modal";
import { setDialog } from "../state/store";
import { canvasHelp } from "./canvasHelp";
import styles from "./help.module.css";

interface Row {
  keys: string;
  does: string;
  /** The longer sentence, shown on hover, when `does` is only the action's name. */
  more?: string;
}

const GROUPS: { title: string; groups: readonly ActionGroup[] }[] = [
  { title: "Tools", groups: ["tool"] },
  { title: "Editing", groups: ["edit", "insert"] },
  { title: "Project and help", groups: ["project", "help"] },
  { title: "Run and view", groups: ["run", "view"] },
];

function rowsFor(groups: readonly ActionGroup[]): Row[] {
  const seen = new Set<string>();
  return ACTIONS.flatMap((action) => {
    const keys = shortcutOf(action);
    if (keys === undefined || !groups.includes(action.group) || seen.has(keys)) return [];
    seen.add(keys);
    return [{ keys, does: action.label, more: action.does }];
  });
}

/**
 * `long` tables, whose descriptions are sentences (the keys with no action, the field gestures),
 * run each sentence on after its key and may continue into the next column.
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
              <kbd>{row.keys}</kbd>
            </dt>
            <dd className={styles.keyDoes}>{row.does}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutsOverlay() {
  const gestures = canvasHelp().map((row) => ({ keys: row.gesture, does: row.does }));
  return (
    <Modal
      title="Shortcuts and gestures"
      testId="shortcuts-overlay"
      width={1240}
      tall
      onClose={() => {
        setDialog(null);
      }}
    >
      <div className={styles.keysGrid}>
        {GROUPS.map((group) => (
          <Table key={group.title} title={group.title} rows={rowsFor(group.groups)} />
        ))}
        <Table title="Keys" rows={KEY_ONLY} long />
        <Table title="On the field" rows={gestures} testId="shortcuts-canvas" long />
      </div>
    </Modal>
  );
}
