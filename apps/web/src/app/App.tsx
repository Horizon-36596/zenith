/**
 * The frame of UI_GUIDE section 3 and site/docs/editor.md: the title bar
 * and toolbar, the steps and ledger on the left, the field in the middle with the problems under
 * it, and the inspector on the right. Each panel is its own scroll container; the app never
 * scrolls. The guided tour and the shortcut overlay sit over all of it.
 *
 * On a first visit, with no project to reopen, the example loads and the core tour starts
 * (site/docs/editor.md).
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { addMarker, setMarkerAt, type LedgerRow } from "@horizon36596/zenith-core";
import { ChevronDown, ChevronUp, Route } from "lucide-react";
import type { Pose } from "@horizon36596/zenith-schema";
import type { PointTarget, Selection } from "../canvas/types";
import { FieldCanvas } from "../canvas/FieldCanvas";
import { Dialogs } from "../dialogs/Dialogs";
import { CommandPalette } from "../palette/CommandPalette";
import { FindingsPanel } from "../panels/FindingsPanel";
import { Inspector } from "../panels/Inspector";
import { LedgerPanel } from "../panels/LedgerPanel";
import { StepActions, StepsPanel } from "../panels/StepsPanel";
import { Timeline } from "../panels/Timeline";
import { TitleBar, Toolbar } from "../panels/Toolbar";
import { Button, Panel, RowButton } from "../components/primitives";
import { HelpTip } from "../help/HelpTip";
import { ShortcutsOverlay } from "../help/ShortcutsOverlay";
import { Tour } from "../tour/Tour";
import { startCoreTour, tourSignal } from "../tour/store";
import { shouldAutoStart } from "../tour/model";
import { EDITOR_PROVENANCE } from "@horizon36596/zenith-core";
import {
  beginTransaction,
  clearStatus,
  endTransaction,
  getState,
  initPrefs,
  setDialog,
  setPaletteOpen,
  setPlaying,
  setPrefs,
  setSelection,
  setStatus,
  useDerived,
  useEditor,
  type Status,
} from "../state/store";
import {
  addCommandStep,
  addPathStepTo,
  splitSegmentAt,
  tryEdit,
  writeHeadingMode,
  writePose,
  writePoses,
} from "./edits";
import { useHoveredRange } from "../lib/headingRangeHover";
import { canvasActions } from "./canvasMenu";
import { useSim } from "../state/sim";
import { loadExample, openFolder, reopenLastFolder } from "./projectActions";
import { isDesktop } from "../project/desktop";
import { effectiveLevel, levelInputs } from "../state/playback";
import { supportsDirectoryPicker } from "../project/types";
import { restoreGitHubSession } from "../github/actions";
import { ReviewView } from "../github/ReviewView";
import { initRouting } from "../github/route";
import { SHORTCUTS } from "./shortcuts";
import { useKeyboard } from "./useKeyboard";
import { guardUnload } from "./unsaved";
import styles from "./App.module.css";

export function App() {
  const state = useEditor();
  const derived = useDerived();
  const hoveredRange = useHoveredRange();
  useKeyboard();

  useEffect(() => {
    initPrefs();
    void restoreGitHubSession();
    const stopRouting = initRouting();
    // A reload or a closed tab asks first while there are unsaved edits (QA-12). The desktop app
    // decides for itself what closing a window does, so the guard is the web's alone.
    const stopGuard = isDesktop() ? () => undefined : guardUnload();
    void reopenLastFolder().then(async (reopened) => {
      await firstRun(reopened);
    });
    return () => {
      stopGuard();
      stopRouting();
    };
  }, []);

  const { prefs, project, auto } = state;
  // Extracted so its non-null narrowing (below) survives into the nested onAddMarker/onAddCommandAt
  // closures; TypeScript only carries that across a plain `const`, not a repeated `derived.plan`.
  const plan = derived.plan;
  // The instant sim: the timeline and the canvas read the same run at the Instant sim level.
  const sim = useSim(plan, plan?.robot ?? null, plan?.field ?? null);
  // Which of the three playback levels the robot on the field comes from (state/playback.ts).
  const level = effectiveLevel(state.prefs.playbackLevel, levelInputs(sim, state.trace));

  if (state.review !== null) {
    return (
      <div className={styles.app}>
        <TitleBar />
        <Toolbar />
        <ReviewView />
        <StatusLine />
        {state.paletteOpen ? <CommandPalette /> : null}
        <Dialogs />
        {state.dialog === "shortcuts" ? <ShortcutsOverlay /> : null}
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <TitleBar />
      <Toolbar />

      <div className={styles.body}>
        <aside
          className={styles.left}
          style={{ width: `${String(prefs.panelLeftW)}px` }}
          data-region
          tabIndex={-1}
          aria-label="Steps and ledger"
        >
          <Timeline />
          <div className={styles.leftSteps}>
            <Panel
              label="Steps"
              title="Steps"
              help="steps"
              tour="steps"
              actions={<StepActions />}
              testId="steps-panel"
            >
              <StepsPanel />
            </Panel>
          </div>
          <div className={styles.leftLedger} data-folded={prefs.ledgerOpen ? undefined : "true"}>
            <Panel
              label="Ledger"
              title="Ledger"
              help="ledger"
              tour="ledger"
              testId="ledger-panel"
              folded={!prefs.ledgerOpen}
              onToggleFold={() => {
                setPrefs({ ledgerOpen: !prefs.ledgerOpen });
              }}
              summary={ledgerSummary(derived.ledger)}
            >
              <LedgerPanel />
            </Panel>
          </div>
        </aside>

        <Resizer
          axis="x"
          label="Resize the steps panel"
          onMove={(delta) => {
            setPrefs({ panelLeftW: clamp(prefs.panelLeftW + delta, 220, 520) });
          }}
        />

        <main className={styles.centre}>
          <div
            className={styles.canvas}
            data-region
            data-tour="field"
            tabIndex={-1}
            aria-label="Field canvas"
          >
            {auto === null || project === undefined || project === null || plan === null ||
            derived.resolved === null ? (
              <Welcome />
            ) : (
              <>
              <span className={styles.fieldHelp}>
                <HelpTip id="field" side="left" />
              </span>
              <FieldCanvas
                field={plan.field}
                robot={plan.robot}
                auto={auto}
                resolved={derived.resolved}
                plan={plan}
                estimate={derived.estimate}
                findings={derived.findings}
                selection={state.selection}
                tool={state.tool}
                alliance={state.alliance}
                waypoints={project.waypoints ?? null}
                snap={prefs.snap}
                showGhosts={false}
                playbackS={state.playbackS ?? 0}
                playing={state.playing}
                onTogglePlay={() => {
                  setPlaying(!getState().playing);
                }}
                previewTrace={sim.trace}
                playbackLevel={level}
                trace={state.trace}
                staticSvg={derived.staticSvg}
                fieldView={prefs.fieldView}
                fieldImageVariant={prefs.fieldStyle}
                insertAnchorStepId={state.tool === "addPath" ? (state.selection.stepId ?? null) : null}
                canvasActions={canvasActions}
                onSplitAt={(stepId: string, _t: number, at: { segmentIndex: number; u: number }) => {
                  splitSegmentAt(stepId, at.segmentIndex, at.u);
                }}
                onDragPoses={writePoses}
                onSelect={(selection: Selection) => {
                  setSelection(selection);
                }}
                onHover={() => undefined}
                onDragStart={beginTransaction}
                onDragEnd={endTransaction}
                onDragPose={(stepId: string, target: PointTarget, pose: Pose) => {
                  writePose(stepId, target, pose);
                }}
                onDragHeading={(stepId: string, target: PointTarget, headingRad: number, pose: Pose) => {
                  // No longer called by the canvas (its per-point knob is gone, spec 11 section 3);
                  // kept because the prop is part of the canvas contract.
                  writePose(stepId, target, { ...pose, headingRad, provenance: EDITOR_PROVENANCE });
                }}
                onSetHeading={(stepId, heading) => {
                  writeHeadingMode(stepId, heading);
                  // A heading changed on the field: what the tour's Heading arrows stop asks for.
                  tourSignal("headingTurned");
                }}
                highlightRange={hoveredRange}
                onAddPathPoint={(pose: Pose) => {
                  addPathStepTo(pose);
                }}
                onAddMarker={(stepId: string, t: number) => {
                  const first = plan.robot.commands[0];
                  if (first === undefined) {
                    setStatus("error", "robot.json registers no commands to attach.");
                    return;
                  }
                  tryEdit((current) =>
                    addMarker(current, stepId, { at: { t }, command: { name: first.name } }),
                  );
                }}
                onDragMarker={(stepId: string, markerIndex: number, t: number) => {
                  tryEdit((current) => setMarkerAt(current, stepId, markerIndex, { t }));
                }}
                onAddCommandAt={() => {
                  const first = plan.robot.commands[0];
                  if (first === undefined) {
                    setStatus("error", "robot.json registers no commands to add.");
                    return;
                  }
                  addCommandStep(first);
                  setPaletteOpen(false);
                }}
              />
              </>
            )}
          </div>

          <Resizer
            axis="y"
            label="Resize the findings panel"
            onMove={(delta) => {
              setPrefs({ findingsH: clamp(prefs.findingsH - delta, 28, 420) });
            }}
          />

          <section
            className={styles.findings}
            style={{ height: `${String(prefs.findingsCollapsed ? 24 : prefs.findingsH)}px` }}
            data-region
            data-findings-panel
            data-tour="findings"
            tabIndex={-1}
            aria-label="Problems"
          >
            <div className={styles.findingsChrome}>
              <RowButton
                icon={prefs.findingsCollapsed ? ChevronUp : ChevronDown}
                label={prefs.findingsCollapsed ? "Show the problems" : "Collapse the problems"}
                onClick={() => {
                  setPrefs({ findingsCollapsed: !prefs.findingsCollapsed });
                }}
                testId="findings-collapse"
              />
            </div>
            {prefs.findingsCollapsed ? null : <FindingsPanel />}
          </section>
        </main>

        <Resizer
          axis="x"
          label="Resize the inspector"
          onMove={(delta) => {
            setPrefs({ panelRightW: clamp(prefs.panelRightW - delta, 240, 560) });
          }}
        />

        <aside
          className={styles.right}
          style={{ width: `${String(prefs.panelRightW)}px` }}
          data-region
          tabIndex={-1}
          aria-label="Inspector"
        >
          <Panel label="Inspector" title="Inspector" help="inspector" tour="inspector" testId="inspector-panel">
            <Inspector />
          </Panel>
        </aside>
      </div>

      <StatusLine />
      {state.paletteOpen ? <CommandPalette /> : null}
      <Dialogs />
      {state.dialog === "shortcuts" ? <ShortcutsOverlay /> : null}
      <Tour />
    </div>
  );
}

/**
 * The first visit: nothing to reopen and no route to follow, so load the example and start the
 * core tour on it. `prefs.tour.seen` makes this happen once; the tour sets it when it starts.
 */
async function firstRun(reopened: boolean): Promise<void> {
  const before = getState();
  if (reopened || before.prefs.tour.seen || before.project !== null || before.review !== null) return;
  const home = window.location.pathname === import.meta.env.BASE_URL || `${window.location.pathname}/` === import.meta.env.BASE_URL;
  if (!home || window.location.search !== "" || window.location.hash !== "") return;
  await loadExample();
  const after = getState();
  if (shouldAutoStart(after.prefs.tour, after.auto !== null)) startCoreTour();
}

/**
 * The folded ledger's one line (UI_GUIDE section 9.8): what the robot holds when the routine
 * ends, from the ledger's last row.
 */
function ledgerSummary(rows: readonly LedgerRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  const holds = rows[rows.length - 1]?.holds ?? {};
  const parts = Object.entries(holds).map(([kind, count]) => `${String(count)} ${kind}`);
  const changes = `${String(rows.length)} ${rows.length === 1 ? "change" : "changes"}`;
  return parts.length === 0 ? changes : `${changes}, ends holding ${parts.join(", ")}`;
}

/** UI_GUIDE section 9.12: the empty field, with one primary action. */
/**
 * What a newcomer sees with nothing open: what Zenith is for, one primary way in (the example), and
 * their own robot's folder beside it. A browser with no folder picker gets the open dialog instead,
 * which explains picking the files one by one; GitHub is in that dialog too.
 */
function Welcome() {
  const canPickFolder = isDesktop() || supportsDirectoryPicker();
  return (
    <div className={styles.welcome} data-testid="canvas-empty">
      <Route size={32} strokeWidth={1.75} className={styles.welcomeIcon} aria-hidden />
      <h1 className={styles.welcomeTitle}>Plan your first autonomous</h1>
      <p className={styles.welcomeLine}>
        Zenith draws your robot&apos;s autonomous on the field, checks it for problems and times
        it.
      </p>
      <p className={styles.welcomeHint}>
        New here? Start with the example, a starter robot on the BIOBUZZ field with four short
        routines you can change freely. For your own robot, open its repository folder, the one
        with <code>zenith.json</code> at the top.
      </p>
      <div className={styles.welcomeButtons}>
        <Button kind="primary" testId="canvas-load-example" onClick={() => void loadExample()}>
          Open the example
        </Button>
        <Button
          testId="canvas-open-project"
          onClick={() => {
            if (canPickFolder) void openFolder();
            else setDialog("open");
          }}
        >
          Open a folder…
        </Button>
      </div>
      <button
        type="button"
        className={styles.welcomeMore}
        data-testid="canvas-open-other"
        onClick={() => {
          setDialog("open");
        }}
      >
        Other ways to open: GitHub, or single files
        <kbd className={styles.welcomeKey}>{SHORTCUTS.openProject}</kbd>
      </button>
    </div>
  );
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * Validation announces politely; a failed save is an alert (UI_GUIDE section 9). The message is an
 * overlay, never a row in the layout (UI_GUIDE section 9.14): a bar that fades in over the bottom
 * of the window and fades out again, so no panel, canvas or control moves when it comes or goes.
 * The pointer passes through the bar to whatever is under it; only its × takes a click. The last
 * message stays mounted through its fade-out, and the live region is always present so a screen
 * reader hears the first message too.
 */
function StatusLine() {
  const { status } = useEditor();
  const [shown, setShown] = useState<Status | null>(status);
  const leaving = status === null && shown !== null;
  useEffect(() => {
    if (status !== null) setShown(status);
  }, [status]);
  useEffect(() => {
    if (status === null || status.kind === "error") return;
    const timer = window.setTimeout(clearStatus, 6000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [status]);
  // The fade-out ends in animationend; the timer is the fallback for a document with no animation.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setShown(null);
    }, STATUS_FADE_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [leaving]);

  const current = status ?? shown;
  const polite = current === null || current.kind !== "error";
  return (
    <div className={styles.statusLayer} aria-live={polite ? "polite" : undefined}>
      {current === null ? null : (
        <div
          className={styles.status}
          data-kind={current.kind}
          data-leaving={leaving ? "true" : undefined}
          role={current.kind === "error" ? "alert" : undefined}
          data-testid={leaving ? "status-leaving" : "status"}
          onAnimationEnd={() => {
            if (leaving) setShown(null);
          }}
        >
          <span className={styles.statusText}>{current.message}</span>
          <button type="button" className={styles.statusClose} onClick={clearStatus} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** Longer than the fade-out, so the timer only ever fires when animationend did not. */
const STATUS_FADE_FALLBACK_MS = 400;

/** A 1 px rule with a 10 px pointer target, and arrow keys as its keyboard equivalent. */
function Resizer({
  axis,
  label,
  onMove,
}: {
  axis: "x" | "y";
  label: string;
  onMove: (delta: number) => void;
}) {
  const last = useRef<number | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    last.current = axis === "x" ? event.clientX : event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (last.current === null) return;
    const now = axis === "x" ? event.clientX : event.clientY;
    onMove(now - last.current);
    last.current = now;
  };
  const stop = (event: ReactPointerEvent<HTMLDivElement>) => {
    last.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className={axis === "x" ? styles.resizerX : styles.resizerY}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        if (axis === "x" && event.key === "ArrowLeft") onMove(-step);
        if (axis === "x" && event.key === "ArrowRight") onMove(step);
        if (axis === "y" && event.key === "ArrowUp") onMove(-step);
        if (axis === "y" && event.key === "ArrowDown") onMove(step);
        event.stopPropagation();
      }}
    />
  );
}
