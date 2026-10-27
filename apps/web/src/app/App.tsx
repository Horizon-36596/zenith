/**
 * The frame of UI_GUIDE section 3 and site/docs/editor.md: the title bar
 * and toolbar, the steps and ledger on the left, the field in the middle with the problems under
 * it, and the inspector on the right. Each panel is its own scroll container; the app never
 * scrolls. The guided tour and the shortcut overlay sit over all of it.
 *
 * On a first visit, with no project to reopen, the example loads and the core tour starts
 * (site/docs/editor.md).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { setMarkerAt } from "@horizon36596/zenith-core";
import { ChevronDown, ChevronUp, FolderX, Route, X } from "lucide-react";
import type { Pose } from "@horizon36596/zenith-schema";
import type { PointTarget, Selection } from "../canvas/types";
import { FieldCanvas } from "../canvas/FieldCanvas";
import { Dialogs } from "../dialogs/Dialogs";
import { Sharing } from "../cloud/Sharing";
import { AdminRoute } from "../admin/AdminRoute";
import { CloudOffLink } from "./CloudOffLink";
import { PanelBar, WideWindowNote, usePanelSheets } from "./PanelSheets";
import { Account } from "../account/Account";
import { Settings } from "../settings/SettingsWindow";
import { CommandPalette } from "../palette/CommandPalette";
import { BottomPanel } from "../panels/BottomPanel";
import { Inspector } from "../panels/Inspector";
import { OptimizeCard } from "../optimize/OptimizeCard";
import { candidatePreview } from "../optimize/preview";
import { stepToApply, useOptimizeCard } from "../optimize/state";
import { LedgerPanel } from "../panels/LedgerPanel";
import { ledgerSummary } from "../panels/ledgerSummary";
import { StepActions, StepsPanel } from "../panels/StepsPanel";
import { Timeline } from "../panels/Timeline";
import { buildPartnerScene, ownLocalS } from "../alliance/model";
import { PartnersPanel, partnersSummary } from "../alliance/PartnersPanel";
import { setAlliancePanelOpen } from "../alliance/store";
import { useAlliance } from "../alliance/useAlliance";
import { TitleBar, Toolbar } from "../panels/Toolbar";
import { Button, Panel, RowButton } from "../components/primitives";
import { HelpTip } from "../help/HelpTip";
import { ShortcutsOverlay } from "../help/ShortcutsOverlay";
import { Tour } from "../tour/Tour";
import { PresetCard } from "../tour/PresetCard";
import { startFirstRun } from "../tour/firstRun";
import { tourSignal } from "../tour/store";
import { isFirstRunAddress } from "../tour/model";
import { EDITOR_PROVENANCE } from "@horizon36596/zenith-core";
import {
  beginTransaction,
  cancelTransaction,
  clearStatus,
  endTransaction,
  getState,
  hiddenWaypoints,
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
  placeMarker,
  splitSegmentAt,
  tryEdit,
  writeHeadingMode,
  writePose,
  writePoses,
  writeStartPose,
} from "./edits";
import { askAddWaypointAt, askRenameWaypoint } from "./waypointDialog";
import { protectedPinNames } from "./pinProtection";
import { dragWaypoint, endWaypointDrag, pressProtectedPin, waypointEditingOff } from "./waypointEdits";
import { useHoveredRange } from "../lib/headingRangeHover";
import { envelopeOfStep, withEnvelopePolygon } from "../lib/envelope";
import { getUi, stopEnvelopeDraw, useUi } from "../state/ui";
import { useHoveredFinding } from "../lib/findingHover";
import { canvasActions } from "./canvasMenu";
import { useSim } from "../state/sim";
import { markerCount, useFeatures } from "../state/features";
import { loadExample, openAutoNamed, openFolder, reopenLastFolder } from "./projectActions";
import { openProblemView, useOpenProblem } from "./openProblem";
import { createAuto } from "./newAuto";
import { Tooltip } from "../components/Tooltip";
import { isDesktop } from "../project/desktop";
import { effectiveLevel, levelInputs } from "../state/playback";
import { supportsDirectoryPicker } from "../project/types";
import { restoreGitHubSession } from "../github/actions";
import { ReviewView } from "../github/ReviewView";
import { RevisionReviewView } from "../library/RevisionReviewView";
import { useLibraryReview } from "../library/reviewStore";
import { ProposalModeView, useProposalMode } from "../proposals/ProposalMode";
import { initRouting } from "../github/route";
import { initNavigation } from "./navigation";
import { useKeyLabel } from "./shortcuts";
import { useKeyboard } from "./useKeyboard";
import { guardUnload } from "./unsaved";
import { isHostMode, startHostSession } from "../project/hostSession";
import { HostEmpty, HostGate } from "../project/hostPanel";
import { clampLedgerHeight, KEY_STEP_LARGE_PX, KEY_STEP_PX, MIN_STEPS_H } from "./ledgerSplit";
import styles from "./App.module.css";

export function App() {
  const state = useEditor();
  const ui = useUi();
  // Drawing an envelope is for the selected step; selecting anything else stops it.
  const drawStepId = ui.envelopeDraw?.stepId ?? null;
  useEffect(() => {
    if (drawStepId !== null && state.selection.stepId !== drawStepId) stopEnvelopeDraw();
  }, [drawStepId, state.selection.stepId]);
  const derived = useDerived();
  const hoveredRange = useHoveredRange();
  const hoveredFinding = useHoveredFinding();
  const features = useFeatures();
  useKeyboard();

  useEffect(() => {
    initPrefs();
    if (isHostMode()) {
      // Another web app opened this window to edit an auto for it (site/docs/host-protocol.md):
      // the project comes from it, so nothing is reopened, routed or signed in, and the first-run
      // example never loads. Unsaved edits still ask before the window closes.
      const stopHost = startHostSession();
      const stopHostGuard = guardUnload();
      return () => {
        stopHostGuard();
        stopHost();
      };
    }
    void restoreGitHubSession();
    const stopRouting = initRouting();
    // The mouse's side buttons and Alt + arrows go back and forward between screens (issue #83).
    const stopNavigation = initNavigation();
    // A reload or a closed tab asks first while there are unsaved edits (QA-12). The desktop app
    // decides for itself what closing a window does, so the guard is the web's alone.
    const stopGuard = isDesktop() ? () => undefined : guardUnload();
    void reopenLastFolder().then(async (reopened) => {
      await firstRun(reopened);
    });
    return () => {
      stopGuard();
      stopNavigation();
      stopRouting();
    };
  }, []);

  const { prefs, project, auto } = state;
  const leftPanel = useRef<HTMLElement | null>(null);
  const rightPanel = useRef<HTMLElement | null>(null);
  // Below desktop width the side panels open as sheets over the field (UI_GUIDE layout rule 9).
  const sheets = usePanelSheets(leftPanel, rightPanel);
  // The step list and the Ledger, held as state so the divider's measurements follow them when the
  // editor's body mounts after a review or host screen.
  const [stepsBox, setStepsBox] = useState<HTMLDivElement | null>(null);
  const [ledgerBox, setLedgerBox] = useState<HTMLDivElement | null>(null);
  // The Ledger and its divider are there only with the ledger switch on (`state/features.ts`).
  const ledgerOpen = features.ledger && prefs.ledgerOpen;
  const ledgerRange = useLedgerSplit(stepsBox, ledgerBox, ledgerOpen);
  // Extracted so its non-null narrowing (below) survives into the nested onAddMarker/onAddCommandAt
  // closures; TypeScript only carries that across a plain `const`, not a repeated `derived.plan`.
  const plan = derived.plan;
  // The Optimize card and what the field draws for it (issue #308), only while the card is open.
  const optimizeCard = useOptimizeCard();
  const candidate = useMemo(
    () =>
      optimizeCard === null || auto === null || plan === null || !features.optimizer
        ? null
        : candidatePreview(
            // A clear path (issue #310) is planned inside its draft, the auto with the new step in it.
            { auto: optimizeCard.draft?.auto ?? auto, robot: plan.robot, field: plan.field, waypoints: project?.waypoints },
            {
              stepId: optimizeCard.stepId,
              marginIn: optimizeCard.marginIn,
              result: optimizeCard.result,
              stale: optimizeCard.stale,
              route: stepToApply(optimizeCard),
            },
          ),
    // The card's other fields (its progress, its phase) change nothing on the field.
    [
      optimizeCard?.stepId,
      optimizeCard?.marginIn,
      optimizeCard?.result,
      optimizeCard?.stale,
      optimizeCard?.choice,
      optimizeCard?.draft,
      optimizeCard === null,
      auto,
      plan,
      project?.waypoints,
      features.optimizer,
    ],
  );
  // The instant sim: the timeline and the canvas read the same run at the Instant sim level.
  const sim = useSim(plan, plan?.robot ?? null, plan?.field ?? null);
  // Which of the three playback levels the robot on the field comes from (state/playback.ts).
  const level = effectiveLevel(state.prefs.playbackLevel, levelInputs(sim, state.trace, state.host, features.fullSim));
  // The alliance view (spec 13 section 9): while a partner is loaded the scrubber reads the
  // alliance clock, the user's robot waits out its start offset, and each partner is drawn at its
  // own offset (alliance/model.ts).
  // With partner sharing off there are no partners: the clock is the routine's own.
  const alliance = useAlliance(plan);
  const allianceOn = features.partners && alliance.active;
  const allianceS = state.playbackS ?? 0;
  const ownPlaybackS = allianceOn ? ownLocalS(allianceS, alliance.ownOffsetS) : allianceS;
  const partnerScene = useMemo(
    () => (!features.partners || alliance.result === null ? [] : buildPartnerScene(alliance.result.partners, allianceS)),
    [features.partners, alliance.result, allianceS],
  );
  // The pins this person hid (issue #236), worked out again only when the parts of the state it
  // reads change: the project, the auto, the show mode and the overrides.
  const hiddenPins = useMemo(
    () => hiddenWaypoints(getState()),
    [state.project, state.auto, state.prefs.waypointPins, state.prefs.waypointPinOverrides],
  );
  // The pins that take their first press as a select (decision D12), none while the setting is off.
  const protectedPins = useMemo(
    () => protectedPinNames(state.project?.waypoints, state.prefs.protectMeasuredPins),
    [state.project?.waypoints, state.prefs.protectMeasuredPins],
  );
  const openProposal = useProposalMode();
  const proposalMode = features.partners ? openProposal : null;
  // Sharing decides for itself what partner sharing switched off leaves (`cloud/Sharing.tsx`).
  const sharing = <Sharing />;
  const libraryReview = useLibraryReview();

  // Host mode before the host's project has arrived, or once it is clear that none will.
  if (state.host !== null && state.project === null && (state.host.phase === "waiting" || state.host.phase === "failed")) {
    return (
      <div className={styles.app}>
        <HostGate />
      </div>
    );
  }

  // A proposal to a partner, or the review of one a partner sent (spec 13 section 14), takes the
  // editor's body the way the pull-request review does.
  if (proposalMode !== null) {
    return (
      <div className={styles.app}>
        <TitleBar />
        <Toolbar />
        <WideWindowNote what="A proposal" />
        <ProposalModeView mode={proposalMode} />
        <StatusLine />
        {state.paletteOpen ? <CommandPalette /> : null}
        <Dialogs />
        {sharing}
        <AdminRoute />
        <CloudOffLink onClosed={afterCloudOffLink} />
        <Settings />
        {state.dialog === "shortcuts" ? <ShortcutsOverlay /> : null}
      </div>
    );
  }

  // Two team library revisions side by side (spec 13 section 5.3) take the body the same way; the
  // open auto stays underneath, untouched, until the person chooses.
  if (libraryReview !== null) {
    return (
      <div className={styles.app}>
        <TitleBar />
        <Toolbar />
        <WideWindowNote what="This comparison" />
        <RevisionReviewView />
        <StatusLine />
        {state.paletteOpen ? <CommandPalette /> : null}
        <Dialogs />
        {sharing}
        <AdminRoute />
        <CloudOffLink onClosed={afterCloudOffLink} />
        <Settings />
        <Account />
        {state.dialog === "shortcuts" ? <ShortcutsOverlay /> : null}
      </div>
    );
  }

  if (state.review !== null) {
    return (
      <div className={styles.app}>
        <TitleBar />
        <Toolbar />
        <WideWindowNote what="This review" />
        <ReviewView />
        <StatusLine />
        {state.paletteOpen ? <CommandPalette /> : null}
        <Dialogs />
        {sharing}
        <AdminRoute />
        <CloudOffLink onClosed={afterCloudOffLink} />
        <Settings />
        <Account />
        {state.dialog === "shortcuts" ? <ShortcutsOverlay /> : null}
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <TitleBar />
      <Toolbar />

      {/* In a narrow window the panels open one at a time over the field; with nothing open there are none to show. */}
      {auto === null ? null : <PanelBar sheet={sheets.sheet} onPick={sheets.setSheet} />}

      {/* With nothing open the inspector is empty, so a narrow window gives its room to the start screen. */}
      <div
        className={styles.body}
        data-empty={auto === null ? "true" : undefined}
        data-sheets="true"
        data-sheet={sheets.sheet ?? undefined}
      >
        <aside
          ref={leftPanel}
          className={styles.left}
          style={{ width: `${String(prefs.panelLeftW)}px` }}
          data-region
          tabIndex={-1}
          aria-label="Steps and ledger"
        >
          <Timeline />
          <div
            ref={setStepsBox}
            className={styles.leftSteps}
            // Beside a Ledger with a set height the step list takes the rest of the column, and the
            // Ledger gives way before the step list goes under its minimum.
            style={
              ledgerOpen && prefs.ledgerH !== null
                ? { flex: "1 1 0", minHeight: `${String(MIN_STEPS_H)}px` }
                : undefined
            }
          >
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
          {ledgerOpen ? (
            <Resizer
              axis="y"
              label="Resize the ledger"
              testId="ledger-resizer"
              value={ledgerRange.shown}
              min={ledgerRange.min}
              max={ledgerRange.max}
              onMove={(delta) => {
                // Dragging down makes the Ledger shorter; from the height on screen, as the widths are.
                const shared = sharedHeight(stepsBox, ledgerBox);
                const shown = ledgerBox?.getBoundingClientRect().height ?? prefs.ledgerH ?? 0;
                setPrefs({ ledgerH: clampLedgerHeight(shown - delta, shared) });
              }}
            />
          ) : null}
          {features.ledger ? (
            <div
              ref={setLedgerBox}
              className={styles.leftLedger}
              data-folded={ledgerOpen ? undefined : "true"}
              data-sized={ledgerOpen && prefs.ledgerH !== null ? "true" : undefined}
              style={ledgerOpen && prefs.ledgerH !== null ? { height: `${String(prefs.ledgerH)}px` } : undefined}
            >
              <Panel
                label="Ledger"
                title="Ledger"
                help="ledger"
                tour="ledger"
                testId="ledger-panel"
                folded={!ledgerOpen}
                onToggleFold={() => {
                  setPrefs({ ledgerOpen: !prefs.ledgerOpen });
                }}
                summary={ledgerSummary(derived.ledgerRun, derived.season)}
              >
                <LedgerPanel />
              </Panel>
            </div>
          ) : null}
          {features.partners ? (
            <div className={styles.leftLedger} data-folded={alliance.state.open ? undefined : "true"}>
              <Panel
                label="Partners"
                title="Partners"
                help="partners"
                testId="partners-panel"
                folded={!alliance.state.open}
                onToggleFold={() => {
                  setAlliancePanelOpen(!alliance.state.open);
                }}
                summary={partnersSummary(alliance)}
              >
                <PartnersPanel view={alliance} />
              </Panel>
            </div>
          ) : null}
        </aside>

        <Resizer
          axis="x"
          label="Resize the steps panel"
          onMove={(delta) => {
            // From the width on screen, which a narrow window can hold below the saved one.
            setPrefs({ panelLeftW: clamp(shownWidth(leftPanel, prefs.panelLeftW) + delta, 220, 520) });
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
              isHostMode() ? (
                <HostEmpty />
              ) : (
                <Welcome />
              )
            ) : (
              <>
              <span className={styles.fieldHelp}>
                <HelpTip id="field" side="left" />
              </span>
              <FieldCanvas
                field={plan.field}
                robot={plan.robot}
                auto={auto}
                openedAuto={state.fileName}
                resolved={derived.resolved}
                plan={plan}
                estimate={derived.estimate}
                findings={derived.findings}
                selection={state.selection}
                tool={state.tool}
                alliance={state.alliance}
                waypoints={project.waypoints ?? null}
                hiddenWaypoints={hiddenPins}
                snap={prefs.snap}
                keepNewPathHeading={prefs.newPathKeepsHeading && prefs.defaultHeading !== "tangent"}
                showGhosts={false}
                playbackS={ownPlaybackS}
                partners={partnerScene}
                playing={state.playing}
                onTogglePlay={() => {
                  setPlaying(!getState().playing);
                }}
                previewTrace={sim.trace}
                playbackLevel={level}
                trace={state.trace}
                // The rendered field draws marker pins, so it gives way to the plain field while they are hidden.
                staticSvg={features.commands || markerCount(auto) === 0 ? derived.staticSvg : null}
                showMarkers={features.commands}
                newPiecewise={features.advancedHeading}
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
                onDragEnd={() => {
                  endTransaction();
                  endWaypointDrag();
                  // Drawing an envelope is one drag: once it has made one, the field is back to normal.
                  const draw = getUi().envelopeDraw;
                  const after = getState().auto;
                  if (draw !== null && after !== null && envelopeOfStep(after, draw.stepId) !== undefined) stopEnvelopeDraw();
                }}
                onDragPose={(stepId: string, target: PointTarget, pose: Pose) => {
                  writePose(stepId, target, pose);
                }}
                onDragStartPose={(pose, carried) => {
                  // Only the position: the drag keeps the heading, and a start written without one
                  // stays without one. The path points that sat on the start at the press go with it.
                  writeStartPose({ xIn: pose.xIn, yIn: pose.yIn }, {}, carried ?? []);
                }}
                onTurnStartPose={(headingRad) => {
                  writeStartPose({ headingRad });
                }}
                // Pins move only where Save can write waypoints.json (issue #134); the inspector's
                // Waypoints section says why everywhere else.
                onDragWaypoint={
                  waypointEditingOff(state) === null
                    ? (name: string, pose: Pose) => {
                        dragWaypoint(name, { xIn: pose.xIn, yIn: pose.yIn });
                      }
                    : undefined
                }
                protectedPins={protectedPins}
                onProtectedPinPress={pressProtectedPin}
                // A double-click on a pin renames it only while the Waypoints switch is on (spec 15
                // section 4.1); with it off the pin still selects and drags.
                onRenameWaypoint={features.waypoints ? askRenameWaypoint : undefined}
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
                clipGhosts={prefs.clipGhosts}
                clearanceOutline={prefs.clearanceOutline}
                candidate={candidate}
                overheadOutlines={prefs.overheadOutlines}
                fieldGrid={prefs.fieldGrid}
                // The ledger always reaches the field, so the hives move with the Ledger switch off;
                // the switch only hides the counts.
                ledger={derived.ledgerRun === null ? null : { run: derived.ledgerRun, season: derived.season }}
                showLedgerCounts={features.ledger && prefs.ledgerCounts}
                hoveredFindingKey={hoveredFinding}
                onAddPathPoint={(pose: Pose, waypoint?: string) => {
                  // A click snapped onto a waypoint's pin makes the new end follow it (issue #150).
                  addPathStepTo(pose, waypoint);
                }}
                onAddMarker={(stepId: string, t: number) => {
                  const first = plan.robot.commands[0];
                  if (first === undefined) {
                    setStatus("error", "robot.json registers no commands to attach.");
                    return;
                  }
                  placeMarker(stepId, { t }, first.name);
                }}
                onDragMarker={(stepId: string, markerIndex: number, t: number) => {
                  tryEdit((current) => setMarkerAt(current, stepId, markerIndex, { t }));
                }}
                onSetEnvelopePolygon={(stepId, polygon) => {
                  tryEdit((current) => withEnvelopePolygon(current, stepId, polygon));
                }}
                placeWaypointArmed={ui.placingWaypoint}
                onPlaceWaypoint={(pose, snappedOnto) => {
                  askAddWaypointAt(pose === undefined || snappedOnto === undefined ? pose : { ...pose, waypoint: snappedOnto });
                }}
                drawEnvelopeFor={ui.envelopeDraw?.stepId ?? null}
                onDrawEnvelope={(stepId, polygon) => {
                  const draw = getUi().envelopeDraw;
                  if (draw === null || draw.stepId !== stepId) return;
                  tryEdit((current) => withEnvelopePolygon(current, stepId, polygon, draw));
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
                onDragCancel={() => {
                  // Escape, or a pointer the browser cancelled, takes the whole drag back (issue #148),
                  // and a cancelled envelope drawing leaves the field back to normal.
                  cancelTransaction();
                  endWaypointDrag();
                  stopEnvelopeDraw();
                  setStatus("info", "Drag cancelled.");
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
            // Collapsed, the panel keeps its 32 px header (--row-h): the tabs and the counts stay (issue #413).
            style={{ height: `${String(prefs.findingsCollapsed ? 32 : prefs.findingsH)}px` }}
            data-region
            data-findings-panel
            data-tour="findings"
            tabIndex={-1}
            aria-label="Problems and code"
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
            {/* The Code tab sits beside Problems while the person's Code tab switch is on. */}
            <BottomPanel showCode={features.codeTab} collapsed={prefs.findingsCollapsed} />
          </section>
        </main>

        <Resizer
          axis="x"
          label="Resize the inspector"
          onMove={(delta) => {
            setPrefs({ panelRightW: clamp(shownWidth(rightPanel, prefs.panelRightW) - delta, 240, 560) });
          }}
        />

        <aside
          ref={rightPanel}
          className={styles.right}
          style={{ width: `${String(prefs.panelRightW)}px` }}
          data-region
          tabIndex={-1}
          aria-label="Inspector"
        >
          {/* Docked over the Inspector while it is open, never modal. */}
          <OptimizeCard />
          {/* No region title: the Inspector's selection header says what is selected, and its ? (issue #431). */}
          <Panel label="Inspector" tour="inspector" testId="inspector-panel" scroll={false}>
            <Inspector />
          </Panel>
        </aside>
      </div>

      <StatusLine besideLeft={leftPanel} />
      {state.paletteOpen ? <CommandPalette /> : null}
      <Dialogs />
      {sharing}
      <AdminRoute />
      <CloudOffLink onClosed={afterCloudOffLink} />
      <Settings />
      <Account />
      {state.dialog === "shortcuts" ? <ShortcutsOverlay /> : null}
      <Tour />
      <PresetCard />
    </div>
  );
}

/**
 * A share or invite link opened with the cloud off skips the first visit, because the address is
 * not the plain one. Once its page is closed the address is, so the first visit happens then.
 */
const afterCloudOffLink = (): void => {
  void firstRun(false);
};

/**
 * The first visit: nothing to reopen and no route to follow, so load the example and ask which preset
 * the person wants, then start the core tour on it (`startFirstRun`). `prefs.tour.seen` makes this
 * happen once; the tour sets it when it starts. Host mode never comes here, and a share, invite or
 * review link is not the plain address, so none of them shows the card; a host's session starts the
 * tour itself once its project is open.
 */
async function firstRun(reopened: boolean): Promise<void> {
  const before = getState();
  if (reopened || before.prefs.tour.seen || before.project !== null || before.review !== null) return;
  const { pathname, search, hash } = window.location;
  if (!isFirstRunAddress(pathname, search, hash, import.meta.env.BASE_URL)) return;
  await loadExample();
  startFirstRun();
}

/** UI_GUIDE section 9.12: the empty field, with one primary action. */
/**
 * What a newcomer sees with nothing open: the headline, one sentence, the example as the primary way
 * in and their own robot's folder beside it (issue #414). What a folder must hold, and what Zenith does
 * with one that has no zenith.json, are the hint on the folder button, not text a newcomer reads before
 * the buttons. A browser with no folder picker gets the open dialog instead, which explains picking the
 * files one by one; GitHub is in that dialog too. A project that is open but has no autos gets its own
 * words and New auto, never the first-run welcome. Nor does one whose autos are there but none is
 * open, such as when none of them loaded: it lists them, and the status line says what went wrong
 * (the 0.1.2 UX sweep, W3-3).
 *
 * "Other ways to open" names what the Open project dialog offers in this browser: picking single
 * files is there only when the browser has no folder picker (the 0.1.2 UX sweep, W3-8).
 */
function Welcome() {
  const { project, auto } = useEditor();
  const openProblem = useOpenProblem();
  const openKey = useKeyLabel("openProject");
  const canPickFolder = isDesktop() || supportsDirectoryPicker();
  const openFolderHint = canPickFolder
    ? "Pick your robot repository's folder, the one with zenith.json at the top. No zenith.json there yet? Open the folder anyway: Zenith offers to set itself up, with the commands your robot code registers."
    : "Pick your robot repository's files. This browser has no folder picker, so the Open project dialog explains how.";
  const openOther = (): void => {
    if (canPickFolder) void openFolder();
    else setDialog("open");
  };
  // The start screen's first Tab stop is Open the example, which was the 25th (0.1.2 UX sweep, W1-10),
  // and on a project's own start screens it is the screen's first button: the first auto to pick, or
  // New auto. The first Tab moves focus there, rather than a focus made in code as the screen appears:
  // Chromium then treats every later focus made in code as keyboard focus, and a ? the app focuses
  // pops its bubble. Only the first Tab after the screen shows, only while nothing else has focus and
  // no dialog is open (a Modal is a native `dialog` with no role), so a dialog keeps its own Tab order,
  // and the Tab goes on as usual unless the button really took focus.
  const welcome = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let done = false;
    const onKey = (event: KeyboardEvent): void => {
      if (done || event.key !== "Tab") return;
      done = true;
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (getState().dialog !== null) return;
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]') !== null) return;
      const first = welcome.current?.querySelector<HTMLElement>("button:not([disabled])");
      if (first === null || first === undefined) return;
      first.focus();
      if (document.activeElement === first) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  if (project !== null && project.autoFiles.length > 0 && auto === null) {
    return (
      <div ref={welcome} className={styles.welcome} data-testid="canvas-pick-auto">
        <Route size={32} strokeWidth={1.75} className={styles.welcomeIcon} aria-hidden />
        <h1 className={styles.welcomeTitle}>Pick an auto in {project.name}</h1>
        <ul className={styles.welcomeAutos}>
          {project.autoFiles.map((fileName) => (
            <li key={fileName}>
              <button
                type="button"
                className={styles.welcomeAuto}
                data-testid={`canvas-auto-${fileName}`}
                onClick={() => void openAutoNamed(fileName)}
              >
                {fileName}
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.welcomeButtons}>
          <Button testId="canvas-new-auto" onClick={() => void createAuto()}>
            New auto
          </Button>
        </div>
      </div>
    );
  }
  if (project !== null && project.autoFiles.length === 0) {
    return (
      <div ref={welcome} className={styles.welcome} data-testid="canvas-no-autos">
        <Route size={32} strokeWidth={1.75} className={styles.welcomeIcon} aria-hidden />
        <h1 className={styles.welcomeTitle}>{project.name} has no autos yet</h1>
        <div className={styles.welcomeButtons}>
          <Button kind="primary" testId="canvas-new-auto" onClick={() => void createAuto()}>
            New auto
          </Button>
          <Tooltip label="Open another folder" hint={openFolderHint}>
            <span className={styles.tipAnchor}>
              <Button testId="canvas-open-another" onClick={openOther}>
                Open another folder…
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
    );
  }
  if (project === null && openProblem !== null) {
    // An open that failed says so here, where the person is looking, and not only on the status
    // line under a canvas that still invited them to plan a first auto (issue #502). The title and
    // the button follow what was being opened: a folder, a repository, files, the example.
    const { title, retry } = openProblemView(openProblem);
    return (
      <div ref={welcome} className={styles.welcome} data-testid="canvas-open-failed" role="alert">
        <FolderX size={32} strokeWidth={1.75} className={styles.welcomeIcon} aria-hidden />
        <h1 className={styles.welcomeTitle}>{title}</h1>
        <p className={styles.welcomeLine} data-testid="canvas-open-failed-why">
          {openProblem.message}
        </p>
        <div className={styles.welcomeButtons}>
          {retry === null ? null : (
            <Tooltip
              label={retry.label.replace("…", "")}
              hint={retry.via === "folder" ? openFolderHint : "Opens the Open project dialog, with every way in: GitHub, or files."}
            >
              <span className={styles.tipAnchor}>
                <Button
                  kind="primary"
                  testId="canvas-open-failed-another"
                  onClick={() => {
                    if (retry.via === "folder") openOther();
                    else setDialog("open");
                  }}
                >
                  {retry.label}
                </Button>
              </span>
            </Tooltip>
          )}
          <Button kind={retry === null ? "primary" : "secondary"} testId="canvas-load-example" onClick={() => void loadExample()}>
            Open the example
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div ref={welcome} className={styles.welcome} data-testid="canvas-empty">
      <Route size={32} strokeWidth={1.75} className={styles.welcomeIcon} aria-hidden />
      <h1 className={styles.welcomeTitle}>Plan your first autonomous</h1>
      <p className={styles.welcomeLine}>Start with the example, or open your robot's folder.</p>
      <div className={styles.welcomeButtons}>
        <Button kind="primary" testId="canvas-load-example" onClick={() => void loadExample()}>
          Open the example
        </Button>
        <Tooltip label="Open a folder" hint={openFolderHint}>
          <span className={styles.tipAnchor}>
            <Button testId="canvas-open-project" onClick={openOther}>
              Open a folder…
            </Button>
          </span>
        </Tooltip>
      </div>
      <button
        type="button"
        className={styles.welcomeMore}
        data-testid="canvas-open-other"
        onClick={() => {
          setDialog("open");
        }}
      >
        {supportsDirectoryPicker() ? "Other ways to open: GitHub" : "Other ways to open: GitHub, or single files"}
        {openKey === undefined ? null : <kbd className={styles.welcomeKey}>{openKey}</kbd>}
      </button>
    </div>
  );
}

/** A side panel's width as drawn, or the saved one before it has been laid out. */
const shownWidth = (panel: { current: HTMLElement | null }, saved: number): number =>
  panel.current === null ? saved : Math.round(panel.current.getBoundingClientRect().width);

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * Validation announces politely; a failed save is an alert (UI_GUIDE section 9). The message is an
 * overlay, never a row in the layout (UI_GUIDE section 9.15): a bar that fades in over the bottom
 * of the window and fades out again, so no panel, canvas or control moves when it comes or goes.
 * The pointer passes through the bar to whatever is under it; only its × takes a click. The last
 * message stays mounted through its fade-out, and the live region is always present so a screen
 * reader hears the first message too.
 */
function StatusLine({ besideLeft }: { besideLeft?: { current: HTMLElement | null } } = {}) {
  const { status } = useEditor();
  const insetLeft = useRightEdgeOf(besideLeft);
  const [shown, setShown] = useState<Status | null>(status);
  const leaving = status === null && shown !== null;
  useEffect(() => {
    if (status !== null) setShown(status);
  }, [status]);
  useEffect(() => {
    // An error, and a warning about what a save left behind, stay until dismissed.
    if (status === null || status.kind === "error" || status.kind === "warn") return;
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
    <div
      className={styles.statusLayer}
      style={insetLeft === 0 ? undefined : { left: `${String(insetLeft)}px` }}
      aria-live={polite ? "polite" : undefined}
    >
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
          <span className={styles.statusText}>
            {current.message}
            {/* A real space, so the message and the hint read as two sentences, not "read only)Save". */}
            {current.hint === undefined ? null : " "}
            {current.hint === undefined ? null : (
              <span className={styles.statusHint} data-testid="status-hint">
                {current.hint}
              </span>
            )}
          </span>
          <Tooltip label="Dismiss">
            <button type="button" className={styles.statusClose} onClick={clearStatus} aria-label="Dismiss" data-testid="status-close">
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/**
 * Where an element's right edge is drawn, followed as it resizes, or 0 with no element. The status bar
 * starts at the steps column's right edge, so it never lies over the folded Ledger and Partners
 * headers at the foot of that column (sweep item A23); it still overlays the layout (9.15).
 */
function useRightEdgeOf(element: { current: HTMLElement | null } | undefined): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = element?.current ?? null;
    if (node === null) return;
    const measure = () => {
      // A steps column opened as a sheet over the field (layout rule 9) is not a column to start
      // beside: the bar takes the window's width under it, as it does while the sheet is closed.
      const sheet = getComputedStyle(node).position === "absolute";
      setWidth(sheet ? 0 : Math.round(node.getBoundingClientRect().right));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return width;
}

/** The height the step list and the Ledger share between them on screen, the divider aside. */
function sharedHeight(steps: HTMLElement | null, ledger: HTMLElement | null): number {
  return (steps?.getBoundingClientRect().height ?? 0) + (ledger?.getBoundingClientRect().height ?? 0);
}

/**
 * The Ledger's height on screen and the range the divider can move it through, followed as the
 * window and the panels resize, for the divider's `aria-valuenow`, `aria-valuemin` and
 * `aria-valuemax`.
 */
function useLedgerSplit(
  stepsNode: HTMLElement | null,
  ledgerNode: HTMLElement | null,
  open: boolean,
): { shown: number; min: number; max: number } {
  const [split, setSplit] = useState({ shown: 0, min: 0, max: 0 });
  useEffect(() => {
    if (!open || stepsNode === null || ledgerNode === null) return;
    const measure = () => {
      const shared = sharedHeight(stepsNode, ledgerNode);
      const shown = Math.round(ledgerNode.getBoundingClientRect().height);
      const min = clampLedgerHeight(0, shared);
      const max = clampLedgerHeight(Number.POSITIVE_INFINITY, shared);
      setSplit((was) => (was.shown === shown && was.min === min && was.max === max ? was : { shown, min, max }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stepsNode);
    observer.observe(ledgerNode);
    return () => {
      observer.disconnect();
    };
  }, [stepsNode, ledgerNode, open]);
  return split;
}

/** Longer than the fade-out, so the timer only ever fires when animationend did not. */
const STATUS_FADE_FALLBACK_MS = 400;

/**
 * A 1 px rule with a 10 px pointer target, and arrow keys as its keyboard equivalent. Given a
 * `value`, it says the size it controls and its range to assistive technology.
 */
function Resizer({
  axis,
  label,
  onMove,
  value,
  min,
  max,
  testId,
}: {
  axis: "x" | "y";
  label: string;
  onMove: (delta: number) => void;
  value?: number;
  min?: number;
  max?: number;
  testId?: string;
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
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      data-testid={testId}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
        if (axis === "x" && event.key === "ArrowLeft") onMove(-step);
        if (axis === "x" && event.key === "ArrowRight") onMove(step);
        if (axis === "y" && event.key === "ArrowUp") onMove(-step);
        if (axis === "y" && event.key === "ArrowDown") onMove(step);
        event.stopPropagation();
      }}
    />
  );
}
