/**
 * UI_GUIDE section 3, layout rule 9: the editor below desktop width. Below 820 px of window the
 * Inspector, and below 640 px the steps column too, leave the row and open as a sheet over the field,
 * one at a time, from the panel bar under the toolbar. The field keeps the whole width the sheets
 * gave up, and the bar says plainly that a wider window shows every panel side by side.
 *
 * The widths are the ones App.module.css and PanelSheets.module.css test; a window between them and
 * desktop width keeps the three columns.
 */
import { useEffect, useState, type RefObject } from "react";
import { currentStop } from "../tour/model";
import { currentTourStops } from "../tour/stops";
import { useTour } from "../tour/store";
export type { Sheet } from "./panelSheetModel";
import { INSPECTOR_SHEET_BELOW_PX, STEPS_SHEET_BELOW_PX, sheetAtWidth, sheetHolding, type Sheet } from "./panelSheetModel";
import styles from "./PanelSheets.module.css";

/** Whether `query` matches now, followed as the window resizes. */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const changed = (): void => {
      setMatches(list.matches);
    };
    changed();
    list.addEventListener("change", changed);
    return () => {
      list.removeEventListener("change", changed);
    };
  }, [query]);
  return matches;
}

/**
 * The open sheet, and the widths at which each panel is one. A tour stop whose anchor is in a panel
 * that is a sheet opens that sheet, and a stop on the field or the problems closes it, so the tour
 * always rings something the person can see.
 */
export function usePanelSheets(
  steps: RefObject<HTMLElement | null>,
  inspector: RefObject<HTMLElement | null>,
): { sheet: Sheet; setSheet: (sheet: Sheet) => void; stepsSheet: boolean; inspectorSheet: boolean } {
  const [sheet, setSheet] = useState<Sheet>(null);
  const inspectorSheet = useMediaQuery(`(max-width: ${String(INSPECTOR_SHEET_BELOW_PX - 0.02)}px)`);
  const stepsSheet = useMediaQuery(`(max-width: ${String(STEPS_SHEET_BELOW_PX - 0.02)}px)`);
  // Widening the window past a sheet's width puts its panel back in the row: close that sheet.
  useEffect(() => {
    setSheet((open) => sheetAtWidth(open, { steps: stepsSheet, inspector: inspectorSheet }));
  }, [stepsSheet, inspectorSheet]);
  const tour = useTour();
  const anchor = tour.phase === "off" ? null : (currentStop(tour, currentTourStops())?.anchor ?? null);
  useEffect(() => {
    if (anchor === null || (!stepsSheet && !inspectorSheet)) return;
    // A frame later, once the stop's own preparation (such as selecting a path) has drawn its anchor.
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector(`[data-tour="${CSS.escape(anchor)}"]`);
      const holding = sheetHolding(
        element,
        { steps: steps.current, inspector: inspector.current },
        { steps: stepsSheet, inspector: inspectorSheet },
      );
      if (holding !== undefined) setSheet(holding);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [anchor, stepsSheet, inspectorSheet, steps, inspector]);
  return { sheet, setSheet, stepsSheet, inspectorSheet };
}

const SEGMENTS = [
  { sheet: "steps", label: "Steps", testId: "panel-switch-steps" },
  { sheet: null, label: "Field", testId: "panel-switch-field" },
  { sheet: "inspector", label: "Inspector", testId: "panel-switch-inspector" },
] as const;

/**
 * The bar under the toolbar in a narrow window: which panel is over the field, and the note that a
 * wider window shows them all. It is hidden at desktop width by CSS alone, so it never appears or goes
 * while the person works; only resizing the window brings it.
 */
export function PanelBar({ sheet, onPick }: { sheet: Sheet; onPick: (sheet: Sheet) => void }) {
  return (
    <div className={styles.bar} data-testid="panel-bar">
      <div className={styles.switch} role="group" aria-label="Show a panel">
        {SEGMENTS.map((segment) => (
          <button
            key={segment.label}
            type="button"
            className={styles.option}
            data-sheet={segment.sheet ?? "field"}
            aria-pressed={sheet === segment.sheet}
            data-testid={segment.testId}
            onClick={() => {
              // A second press on an open sheet's segment closes it, back to the field.
              onPick(sheet === segment.sheet ? null : segment.sheet);
            }}
          >
            {segment.label}
          </button>
        ))}
      </div>
      <p className={styles.note} data-testid="panel-bar-note">
        A wider window shows every panel.
      </p>
    </div>
  );
}

/**
 * The note a view that needs side-by-side panels shows in a window too narrow for them: the review
 * of a pull request, a proposal, a library revision. It is drawn by CSS below 900 px only.
 */
export function WideWindowNote({ what }: { what: string }) {
  return (
    <p className={styles.wide} role="note" data-testid="wide-window-note">
      {what} needs a wider window. Widen it to at least 900 px to see every panel.
    </p>
  );
}
