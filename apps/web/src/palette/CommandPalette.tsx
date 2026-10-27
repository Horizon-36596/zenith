/**
 * The command palette of UI_GUIDE section 8.7: every toolbar action, every insert-step kind, every
 * command in `robot.json`'s registry, every named waypoint, every step of the open auto and every
 * auto in the project. It is the only place a rare action needs to live.
 *
 * An action a switch in Settings, General hides still answers a search: it is listed last, greyed,
 * under "Off in your settings", and choosing it opens Settings at that switch. It never runs the
 * action.
 *
 * Which row Enter runs is the person's choice, never the pointer's or a summary's (issue #410): the
 * first row is active when it opens, a pointer that is only resting over the list does not take it,
 * only a real move does, results are ordered by how well the label matches before they are grouped,
 * a row that cannot run says why on a second line and the arrow keys step over it. The first row is
 * active even when it cannot run, and Enter on it says why and keeps the palette open (UX review, S18).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Flag, Footprints, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { walkSteps } from "@horizon36596/zenith-core";
import { ACTIONS, isEnabled, labelOf, shortcutOf } from "../app/actions";
import { addCommandStep } from "../app/edits";
import { openAutoNamed } from "../app/projectActions";
import { recentActions } from "../app/recentActions";
import { actionOffBy, featureLabel, featureListed, settingId, type Feature } from "../state/features";
import { openSettingsAt } from "../settings/store";
import { selectStep, setPaletteOpen, setSelection, setStatus, useEditor } from "../state/store";
import { provenanceLabel } from "../components/primitives";
import { firstActive, matchTier, stepActive, type MatchTier } from "./match";
import styles from "./CommandPalette.module.css";

interface Entry {
  id: string;
  label: string;
  group: string;
  keywords?: readonly string[];
  /** A robot command's summary: shown whole under the label, and matched after everything else. */
  summary?: string;
  shortcut?: string;
  /** A second line shown whole under the label: a robot command's summary from `robot.json`. */
  detail?: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** Why a disabled row cannot run, on its second line. */
  reason?: string;
  /** The switch that hides this action now: the row is greyed and last, and opens Settings at it. */
  offBy?: Feature;
  run: () => void;
}

/** One row on screen: its entry and how well it matched. */
interface Row {
  entry: Entry;
  tier: MatchTier;
}

/** The header over the actions the feature switches hide. */
const OFF_GROUP = "Off in your settings";

/** The header over the last few actions run, shown before anything is typed. */
const RECENT_GROUP = "Recent";

const STEPS_GROUP = "Steps";

/** How many recent actions lead the empty list. SET BY HAND: enough to repeat a thing, not a second list. */
const RECENT_SHOWN = 4;

/** The palette's own opener, which would always be the latest action and so never worth listing. */
const NOT_RECENT = new Set(["view.palette"]);

const GROUP_ORDER = [
  "Tools",
  "Run",
  "Edit",
  "Insert",
  "Commands",
  STEPS_GROUP,
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
  // What the person picked with the arrows or a real pointer move, and for which query: a new query
  // starts again from its own first row, with no effect to run after the render that shows it.
  const [picked, setPicked] = useState<{ query: string; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo((): Entry[] => {
    const { features } = state.prefs;
    // An action the feature switches in Settings, General hide (`state/features.ts`) never runs from
    // here; it is kept, marked with the switch, for the greyed rows at the end. With a pin selected, "Delete waypoint…" is the waypoint's own row; Delete step's row would say the same.
    // An action a switch Settings does not list keeps hidden (Full sim, issue #207) is left out, as there is no switch to open.
    const list: Entry[] = ACTIONS.filter((action) => !(action.id === "edit.delete" && state.selection.waypoint !== undefined))
      .filter((action) => {
        const offBy = actionOffBy(action.id, features);
        return offBy === undefined || featureListed(offBy);
      })
      .map(
      (action): Entry => {
        const offBy = actionOffBy(action.id, features);
        const label = labelOf(action, state);
        const common = { label, group: GROUP_OF[action.group] ?? "Project", keywords: action.keywords, icon: action.icon };
        if (offBy !== undefined) {
          return {
            ...common,
            id: `off:${action.id}`,
            detail: `Off in your settings. Opens ${featureLabel(offBy)} in Settings, General.`,
            offBy,
            run: () => {
              openSettingsAt(settingId(offBy));
            },
          };
        }
        const enabled = isEnabled(action, state);
        return {
          ...common,
          id: action.id,
          shortcut: shortcutOf(action),
          disabled: !enabled,
          ...(enabled ? {} : { reason: action.whyDisabled?.(state) || "Not available right now." }),
          run: () => {
            void action.run();
          },
        };
      },
    );

    for (const spec of features.commands ? (state.project?.robot.commands ?? []) : []) {
      list.push({
        id: `command:${spec.name}`,
        label: `Insert ${spec.name}`,
        group: "Commands",
        ...(spec.summary === undefined ? {} : { detail: spec.summary, summary: spec.summary }),
        icon: Zap,
        disabled: state.auto === null,
        ...(state.auto === null ? { reason: "Open an auto first." } : {}),
        run: () => {
          addCommandStep(spec);
        },
      });
    }

    // Steps are found by typing, as there can be dozens, so the empty list leaves them out.
    for (const step of state.auto === null ? [] : walkSteps(state.auto.steps)) {
      list.push({
        id: `step:${step.id}`,
        label: `Go to ${step.id}`,
        group: STEPS_GROUP,
        icon: Footprints,
        run: () => {
          selectStep(step.id);
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
      const where = `${waypoint.xIn.toFixed(1)}, ${waypoint.yIn.toFixed(1)} in`;
      list.push({
        id: `waypoint:${name}`,
        label: `${name} · ${where}`,
        group: "Waypoints",
        icon: Flag,
        run: () => {
          // Selects its pin, which the inspector then shows and the field lets you drag (issue #134),
          // and says so: the status names the pin and where it is, not its label in capitals.
          if (state.auto !== null) {
            setSelection({ waypoint: name });
            setStatus("info", `Selected waypoint ${name} (${where})`);
          } else {
            // The provenance in sentence case, as the chip shows it, never the raw word (UX review, X19).
            setStatus("info", `${name} (${where}): ${provenanceLabel(waypoint.provenance ?? "NEEDS MEASUREMENT")}`);
          }
        },
      });
    }

    return list;
  }, [state]);

  const rows = useMemo((): Row[] => {
    const needle = query.trim().toLowerCase();
    const groupRank = (entry: Entry): number => GROUP_ORDER.indexOf(entry.group);
    if (needle === "") {
      // Nothing typed: the last few actions that can run lead, then every action by group. A switched-off
      // action and a step show only for a search.
      const all = entries.filter((entry) => entry.offBy === undefined && entry.group !== STEPS_GROUP);
      const recent: Row[] = [];
      for (const id of [...recentActions()].reverse()) {
        const entry = all.find((candidate) => candidate.id === id);
        if (entry === undefined || entry.disabled === true || NOT_RECENT.has(id) || recent.some((row) => row.entry.id === `recent:${id}`)) continue;
        recent.push({ entry: { ...entry, id: `recent:${id}`, group: RECENT_GROUP }, tier: 0 });
        if (recent.length === RECENT_SHOWN) break;
      }
      const rest = [...all].sort((a, b) => groupRank(a) - groupRank(b)).map((entry): Row => ({ entry, tier: 0 }));
      return [...recent, ...rest];
    }
    // How well the label matches comes before the group, so a whole-word match is not buried under a
    // keyword match in an earlier group. A switched-off action comes after every other match.
    const found: Row[] = [];
    for (const entry of entries) {
      const tier = matchTier(entry, needle);
      if (tier !== null) found.push({ entry, tier });
    }
    const rank = (row: Row): number => (row.entry.offBy === undefined ? 0 : 10000) + row.tier * 100 + groupRank(row.entry);
    return found.sort((a, b) => rank(a) - rank(b));
  }, [entries, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The row Enter runs: what the person picked for this query if it is still listed, else the first
  // row that can run and is not a summary-only match, or none.
  const pickedIndex = picked !== null && picked.query === query ? rows.findIndex((row) => row.entry.id === picked.id) : -1;
  const active = pickedIndex >= 0 ? pickedIndex : firstActive(rows.map((row) => ({ tier: row.tier, disabled: row.entry.disabled })));

  // The arrows keep the active row in view. A scroll the list makes by itself never moves the active
  // row, because only a real pointer move does (`onPointerMove` below).
  useEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (entry: Entry | undefined): void => {
    if (entry === undefined) return;
    // A row that cannot run keeps the palette open and says why on the status line too, in the shape
    // a blocked shortcut uses ("Optimize path: Select a path step first."), so Enter is never silent.
    if (entry.disabled === true) {
      const why = entry.reason ?? "Not available right now.";
      setStatus("info", why.startsWith(entry.label) ? why : `${entry.label}: ${why}`);
      return;
    }
    setPaletteOpen(false);
    entry.run();
  };

  const move = (direction: 1 | -1): void => {
    const next = stepActive(
      rows.map((row) => ({ tier: row.tier, disabled: row.entry.disabled })),
      active,
      direction,
    );
    const row = rows[next];
    if (row !== undefined && next !== active) setPicked({ query, id: row.entry.id });
    // From no active row, the arrow that goes up has nowhere to go; down finds the first that can run.
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
          placeholder="Type an action, a step, a waypoint or an auto"
          value={query}
          data-testid="palette-input"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(rows[active]?.entry);
            } else if (event.key === "Escape") {
              setPaletteOpen(false);
            }
            event.stopPropagation();
          }}
        />
        <div className={styles.results} role="listbox" data-testid="palette-results" ref={resultsRef}>
          {rows.length === 0 ? (
            <p className={styles.none} data-testid="palette-none">
              Try a step name, a waypoint, or an action.
            </p>
          ) : (
            rows.map(({ entry }, index) => {
              const group = entry.offBy === undefined ? entry.group : OFF_GROUP;
              const header = group === lastGroup ? null : group;
              lastGroup = group;
              const Icon = entry.icon;
              const second = entry.disabled === true && entry.reason !== undefined ? entry.reason : entry.detail;
              return (
                <div key={entry.id}>
                  {header === null ? null : <p className={styles.group}>{header}</p>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`${index === active ? styles.rowActive : styles.row} ${second === undefined ? "" : styles.tall} ${entry.offBy === undefined ? "" : styles.off}`}
                    disabled={entry.disabled}
                    data-testid={entry.offBy === undefined ? `palette-item-${entry.id}` : `palette-${entry.id}`}
                    data-off={entry.offBy === undefined ? undefined : "true"}
                    onPointerMove={(event) => {
                      // A move that went nowhere is the browser re-testing what is under a still
                      // pointer after the list opened or scrolled, not the person choosing a row.
                      if (event.movementX === 0 && event.movementY === 0) return;
                      if (entry.disabled !== true && index !== active) setPicked({ query, id: entry.id });
                    }}
                    onClick={() => {
                      choose(entry);
                    }}
                  >
                    <Icon size={16} strokeWidth={1.75} aria-hidden />
                    {second === undefined ? (
                      <span className={styles.label}>{highlight(entry.label, query)}</span>
                    ) : (
                      <span className={styles.text}>
                        <span className={styles.label}>{highlight(entry.label, query)}</span>
                        <span className={styles.detail} data-testid={`palette-detail-${entry.id}`}>
                          {second}
                        </span>
                      </span>
                    )}
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
