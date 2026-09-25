/**
 * The command palette of UI_GUIDE section 8.7: every toolbar action, every insert-step kind, every
 * command in `robot.json`'s registry, every named waypoint and every auto in the project. It is the
 * only place a rare action needs to live.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, FileText, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ACTIONS, isEnabled, shortcutOf } from "../app/actions";
import { addCommandStep } from "../app/edits";
import { openAutoNamed } from "../app/projectActions";
import { setPaletteOpen, setStatus, useEditor } from "../state/store";
import { matchesQuery } from "./match";
import styles from "./CommandPalette.module.css";

interface Entry {
  id: string;
  label: string;
  group: string;
  keywords?: readonly string[];
  shortcut?: string;
  icon: LucideIcon;
  disabled?: boolean;
  run: () => void;
}

const GROUP_ORDER = [
  "Tools",
  "Run",
  "Edit",
  "Insert",
  "Commands",
  "Autos",
  "Waypoints",
  "View",
  "Project",
];

const GROUP_OF: Record<string, string> = {
  tool: "Tools",
  run: "Run",
  edit: "Edit",
  insert: "Insert",
  view: "View",
  project: "Project",
};

export function CommandPalette() {
  const state = useEditor();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const entries = useMemo((): Entry[] => {
    const list: Entry[] = ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      group: GROUP_OF[action.group] ?? "Project",
      keywords: action.keywords,
      shortcut: shortcutOf(action),
      icon: action.icon,
      disabled: !isEnabled(action, state),
      run: () => {
        void action.run();
      },
    }));

    for (const spec of state.project?.robot.commands ?? []) {
      list.push({
        id: `command:${spec.name}`,
        label: `Insert ${spec.name}`,
        group: "Commands",
        icon: Zap,
        disabled: state.auto === null,
        run: () => {
          addCommandStep(spec);
        },
      });
    }

    for (const fileName of state.project?.autoFiles ?? []) {
      list.push({
        id: `auto:${fileName}`,
        label: `Open ${fileName}`,
        group: "Autos",
        icon: FileText,
        run: () => {
          void openAutoNamed(fileName);
        },
      });
    }

    for (const [name, waypoint] of Object.entries(state.project?.waypoints?.waypoints ?? {})) {
      list.push({
        id: `waypoint:${name}`,
        label: `${name} · ${waypoint.xIn.toFixed(1)}, ${waypoint.yIn.toFixed(1)} in`,
        group: "Waypoints",
        icon: MapPin,
        run: () => {
          setStatus("info", `${name}: ${waypoint.provenance ?? "NEEDS MEASUREMENT"}`);
        },
      });
    }

    return list;
  }, [state]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = needle === "" ? entries : entries.filter((entry) => matchesQuery(entry, needle));
    return [...found].sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    );
  }, [entries, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (entry: Entry | undefined): void => {
    if (entry === undefined || entry.disabled === true) return;
    setPaletteOpen(false);
    entry.run();
  };

  let lastGroup = "";

  return (
    <div
      className={styles.scrim}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className={styles.palette} role="dialog" aria-modal aria-label="Command palette">
        <input
          ref={inputRef}
          className={styles.input}
          placeholder="Type an action, a command, a waypoint or an auto"
          value={query}
          data-testid="palette-input"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(matches.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[active]);
            } else if (event.key === "Escape") {
              setPaletteOpen(false);
            }
            event.stopPropagation();
          }}
        />
        <div className={styles.results} role="listbox" data-testid="palette-results">
          {matches.length === 0 ? (
            <p className={styles.none}>Nothing matches that.</p>
          ) : (
            matches.map((entry, index) => {
              const header = entry.group === lastGroup ? null : entry.group;
              lastGroup = entry.group;
              const Icon = entry.icon;
              return (
                <div key={entry.id}>
                  {header === null ? null : <p className={styles.group}>{header}</p>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={index === active ? styles.rowActive : styles.row}
                    disabled={entry.disabled}
                    data-testid={`palette-item-${entry.id}`}
                    onPointerEnter={() => {
                      setActive(index);
                    }}
                    onClick={() => {
                      choose(entry);
                    }}
                  >
                    <Icon size={16} strokeWidth={1.5} aria-hidden />
                    <span className={styles.label}>{highlight(entry.label, query)}</span>
                    {entry.shortcut === undefined ? null : (
                      <kbd className={styles.shortcut}>{entry.shortcut}</kbd>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** Matched substrings read brighter and heavier than the rest of the label (UI_GUIDE 8.7). */
function highlight(label: string, query: string) {
  const needle = query.trim();
  if (needle === "") return label;
  const at = label.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className={styles.match}>{label.slice(at, at + needle.length)}</mark>
      {label.slice(at + needle.length)}
    </>
  );
}
