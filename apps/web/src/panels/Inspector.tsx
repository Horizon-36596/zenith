/**
 * The inspector of site/docs/editor.md and the field rows of UI_GUIDE section 9.5, as one calm panel
 * (issue #431). A selection header says what is selected: the kind's icon, its id, its estimate and
 * the kind's `?`. Under it, sections separated by hairlines, each with a small uppercase header that
 * folds it, and rows on one grid: labels at 24 px, values at 120 px. A step shows its kind's own
 * section (PATH or PATHS, WAIT, COMMAND, GROUP and STEPS, BRANCH, TRANSFER), then for a path HEADING,
 * SPEED and MARKERS, then ADVANCED for the rare rows and NOTES, both folded. A selected marker shows
 * its own section under a breadcrumb header. With nothing selected it is the Routine view (the start
 * and the Waypoints list); a selected start or waypoint shows its own section (issue #244). Degrees
 * here, radians in the file (CLAUDE.md rule 3), converted in this file and nowhere else in the panel.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Anchor, ClipboardList, Diamond, Flag, LocateFixed, Pencil, Plus, Route, Trash } from "lucide-react";
import { degToRad, flattenSteps, isTurnInPlace, jointTwin, radToDeg, setCommandArgs } from "@horizon36596/zenith-core";
import { setMarkerAt } from "@horizon36596/zenith-core";
import type {
  CommandSpec,
  Marker,
  MarkerAt,
  PathStep,
  Pose,
  PoseSource,
  Step,
  TransferStep,
  Waypoints,
} from "@horizon36596/zenith-schema";
import type { LedgerEntry, LedgerLocation, Pose as PlannedPose, SeasonRules } from "@horizon36596/zenith-core";
import {
  appendPathToChain,
  deleteMarker,
  placeMarker,
  removePathFromChain,
  setSegmentKindAt,
  tryEdit,
  writeHeadingMode,
  writeSpeed,
  writeTimeout,
} from "../app/edits";
import { useKeyLabel } from "../app/shortcuts";
import { CommandArgsForm, type Args } from "../components/CommandArgsForm";
import {
  ChoiceField,
  INSPECTOR_GRID,
  NumberField,
  NumberUnitField,
  PoseRow,
  SCRUB_HINT,
  Section,
  SelectField,
  SourceSelect,
  TextAreaField,
  FieldRow,
} from "../components/fields";
import { usePoseBounds } from "./poseBounds";
import { openFoldForNow } from "../components/foldMemory";
import { RowButton, StatusChip, TextButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { POSE_PROVENANCE_HINT, ProvenancePicker } from "../components/ProvenancePicker";
import { writeOwnPose, writePointNumbers, writePointProvenance, writeStartNumbers, writeStartProvenance } from "../app/edits";
import { chooseEndSource, endChoiceOf, endChoices } from "../app/endSource";
import { PointHeadingRow, formatHeading } from "./PointHeadingRow";
import { isPrimaryPoint, pointHolder, pointsSelectedLine } from "./pointSelection";
import { describedHint, type DescriptionId } from "../help/descriptions";
import { useDescribed, useDescriptions } from "../help/descriptions/useDescriptions";
import type { PanelHelpId } from "../help/content";
import {
  setBranchCondition,
  setCommandName,
  setEndCondition,
  setMarkerCommand,
  setNotes,
  setParallel,
  setTransfer,
  setWait,
} from "@horizon36596/zenith-core";
import { commandChoices, commandSummary } from "../lib/commands";
import { markerAtInUnit, markerMaxIn, type MarkerUnit } from "../lib/markerAt";
import { NO_TIMEOUT_WARNING } from "../lib/waitCap";
import { HEADING_MODES, headingForMode, headingModeHint, headingModeInfo, type PlannedHeadings } from "../lib/headingModes";
import { PiecewiseEditor } from "./PiecewiseEditor";
import { EnvelopeEntry, EnvelopeSection, RejoinEntry, RejoinSection, useDrawingEnvelope } from "./EnvelopeSection";
import { metaLineHint, metaLineText } from "../lib/metaLine";
import { carriesEnvelope, offersRejoin } from "../lib/envelope";
import { PARALLEL_MODES } from "../lib/parallelModes";
import { findEntry, indexSteps } from "../lib/stepOps";
import { KIND_ICON, TURN_ICON, TURN_LABEL } from "../lib/stepKinds";
import { transferChoices, transferOverridden } from "../lib/transfer";
import type { ParallelStep, WaitStep } from "@horizon36596/zenith-schema";
import { waitForCondition, waitForTime } from "../app/waitEdits";
import { SpeedFractionField, percentText, useRobotDefaultSpeed } from "./SpeedFractionField";
import { envelopeEntryShown, madeWithOff, piecewiseOffered, useFeature, useFeatures } from "../state/features";
import { MadeWithChip } from "./MadeWithChip";
import type { PointTarget, Selection } from "../canvas/types";
import { autoRobotOf, selectStep, setSelection, useDerived, useEditor } from "../state/store";
import { WaypointEndAction, WaypointHeaderMenu, WaypointsSection } from "./WaypointSection";
import { HeaderMark, SelectionHeader } from "./SelectionHeader";
import styles from "./Inspector.module.css";

/** Pedro's names for the heading modes, each with its plain meaning as a tooltip (ADR 0006). */
const HEADING_CHOICES = HEADING_MODES.map((info) => ({
  value: info.value,
  label: info.label,
  hint: headingModeHint(info),
}));

/**
 * The kind as the header's icon names it, in its tooltip and accessible name. The header's title is
 * the step's id, so the kind is said once, by the icon (issue #409).
 */
const KIND_WORD: Record<Step["kind"], string> = {
  path: "Path",
  command: "Command",
  wait: "Wait",
  transfer: "Transfer",
  sequence: "Sequence",
  parallel: "Parallel group",
  branch: "Branch",
};

/** The `?` of the selection header: the kind's own help, since the header is the kind's only one. */
const KIND_HELP: Record<Step["kind"], PanelHelpId> = {
  path: "section.step",
  command: "section.command",
  wait: "section.wait",
  transfer: "section.transfer",
  sequence: "section.sequence",
  parallel: "section.parallel",
  branch: "section.branch",
};

/** Under these modes the path decides the heading, so the Heading section shows the planned one. */
const DERIVED_MODES = new Set(["tangent", "tangentReversed", "facePoint"]);

/** Whether the Inspector is narrower than 300 px, where Speed and Markers start folded (INS-34). */
const NARROW_PX = 300;

/** A callback ref for the Inspector's root, and whether that root is narrow. */
function useNarrow(): [(element: HTMLDivElement | null) => void, boolean] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setNarrow(element.getBoundingClientRect().width < NARROW_PX);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return [setElement, narrow];
}

/**
 * The Inspector's frame: the selection header, which never scrolls, then the sections in a scroll
 * area. `testId` names the content, whose own height is what the sections take.
 */
function InspectorFrame({
  head,
  testId = "inspector",
  root,
  children,
}: {
  head: ReactNode;
  testId?: string;
  root?: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    <div className={`${styles.frame} ${INSPECTOR_GRID}`}>
      {head}
      <div className={styles.scroll} ref={root}>
        <div className={styles.inspector} data-testid={testId}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Inspector() {
  const editor = useEditor();
  const { auto, project, selection, trace, autoField, multiSteps } = editor;
  const derived = useDerived();
  const drawingEnvelope = useDrawingEnvelope(selection.stepId);
  const features = useFeatures();
  const [root, narrow] = useNarrow();

  const entry = useMemo(
    () => (auto === null || selection.stepId === undefined ? undefined : findEntry(auto, selection.stepId)),
    [auto, selection.stepId],
  );

  if (auto === null) return null;
  if (entry === undefined && selection.waypoint !== undefined) {
    // A waypoint pin was clicked on the field or in the list (issue #134): its own section, then the
    // one compact list with its row marked (issue #245). With Waypoints off there is no list: the
    // pin's own section alone, which still edits and moves it, under the chip that says why.
    const name = selection.waypoint;
    return (
      <InspectorFrame
        head={
          <SelectionHeader
            icon={Flag}
            iconLabel="Waypoint"
            title={name}
            help="section.waypoints"
            action={features.waypoints ? <WaypointHeaderMenu name={name} /> : undefined}
          />
        }
      >
        {features.waypoints ? null : <MadeWithChip feature="waypoints" />}
        {/* Keyed, as every section is, so no other section's fold is reused for it by its place. */}
        <WaypointsSection key="waypoint.list" selected={name} listed={features.waypoints} />
      </InspectorFrame>
    );
  }
  if (entry === undefined && selection.start === true) {
    // The start mark was clicked on the field: its section alone, held open (issue #244). The
    // Waypoints list belongs to the Routine view and to a selected waypoint, not to the start.
    return (
      <InspectorFrame head={<SelectionHeader icon={LocateFixed} iconLabel="Start" title="Start" help="section.start" />}>
        <StartRoutineSection waypointNames={projectWaypointNames(project)} forceOpen />
      </InspectorFrame>
    );
  }
  if (entry === undefined) {
    // Nothing is selected: the Routine view, the settings of the routine as a whole (issue #244).
    // Its header says what this is; how to leave it is the first line of its `?` (issue #431).
    return (
      <InspectorFrame
        testId="inspector-routine"
        head={<SelectionHeader icon={Route} iconLabel="Routine" title="Routine" help="inspector" testId="inspector-routine-head" />}
      >
        <StartRoutineSection waypointNames={projectWaypointNames(project)} />
        {features.waypoints ? <WaypointsSection key="waypoint.list" /> : null}
      </InspectorFrame>
    );
  }

  const step = entry.step;
  // The auto's own robot when it sets one, as the findings use (issue #403).
  const robot = autoRobotOf(editor);
  const conditions = robot?.conditions ?? [];
  const commands = robot?.commands ?? [];
  const waypointNames = projectWaypointNames(project);
  const perStep = derived.estimate?.byStepId[entry.id];
  const planned =
    derived.plan === null ? undefined : flattenSteps(derived.plan.steps).find((candidate) => candidate.id === entry.id);
  const plannedStart = planned?.startPose ?? null;
  const recordedStep = trace?.steps.find((candidate) => candidate.id === entry.id);
  const actualS = recordedStep === undefined ? null : recordedStep.endS - recordedStep.startS;
  const deltaS =
    actualS === null || perStep?.nominalS === null || perStep === undefined
      ? null
      : actualS - perStep.nominalS;
  // The selected marker, when a marker rather than its whole path was clicked or placed. An index
  // that no longer names a marker (after an undo, say) falls back to the path alone.
  const markerIndex = selection.markerIndex;
  const selectedMarker =
    step.kind === "path" && markerIndex !== undefined ? step.markers?.[markerIndex] : undefined;

  if (selectedMarker !== undefined && markerIndex !== undefined) {
    // The selection decides the Inspector: a marker shows alone, under a breadcrumb back to its path
    // (INS-13, issue #431), with its bin as the header's one action.
    const stationary = commands.find((spec) => spec.name === selectedMarker.command.name)?.stationary === true;
    return (
      <InspectorFrame
        root={root}
        head={
          <SelectionHeader
            icon={Diamond}
            iconLabel="Marker"
            crumb={{
              label: entry.id,
              hint: "Selects the path this marker is on.",
              testId: "inspector-marker-back",
              onClick: () => {
                selectStep(entry.id);
                // Back on the path, its Markers section shows the marker list, open for now.
                requestAnimationFrame(() => {
                  openFoldForNow("path.markers");
                });
              },
            }}
            title={`Marker ${String(markerIndex + 1)}`}
            help="section.marker"
            marks={stationary ? <StandsStillMark testId="inspector-marker-stationary" /> : null}
            action={
              <RowButton
                icon={Trash}
                label="Remove marker"
                hint="Takes it off the path and leaves the path selected."
                testId="inspector-marker-remove"
                onClick={() => {
                  deleteMarker(entry.id, markerIndex);
                }}
              />
            }
          />
        }
      >
        <MarkerSection
          key={`${entry.id}-marker-${String(markerIndex)}`}
          stepId={entry.id}
          index={markerIndex}
          marker={selectedMarker}
          commands={commands}
          pathLengthIn={planned?.lengthIn ?? null}
        />
      </InspectorFrame>
    );
  }

  const notes = "notes" in step ? (step.notes ?? "") : "";
  const pointsLine = pointsSelectedLine(selection);
  // A group or a piecewise heading while its switch is off: it still shows and edits, with a chip.
  const madeWithTool = madeWithOff(step, features);
  // A command robot.json marks stationary says so by an anchor beside the estimate (issue #431).
  const standsStill = step.kind === "command" && commands.find((spec) => spec.name === step.name)?.stationary === true;
  const plannedHeadings =
    planned === undefined || planned.samples.length === 0 || planned.endPose === null
      ? null
      : {
          startRad: planned.startPose.headingRad,
          endRad: planned.endPose.headingRad,
          ...(planned.geometry === undefined ? {} : { geometry: planned.geometry }),
        };
  const estimateHint = metaLineHint(
    "inspector.estimated",
    perStep?.strafeFraction == null ? [] : [{ value: perStep.strafeFraction.toFixed(2), describe: "inspector.strafeFraction" }],
  );
  // A turn on the spot is a path step with no length, and reads as a turn here as in the list (issue #505).
  const turn = planned !== undefined && isTurnInPlace(planned);
  // Several steps selected in the list: the fields below edit only this one, so the Inspector says so (issue #505).
  const othersSelected = multiSteps.length > 1 && multiSteps.includes(entry.id) ? multiSteps.length : 0;

  return (
    <InspectorFrame
      root={root}
      head={
        <SelectionHeader
          icon={turn ? TURN_ICON : KIND_ICON[step.kind]}
          iconLabel={turn ? TURN_LABEL : KIND_WORD[step.kind]}
          title={entry.id}
          help={KIND_HELP[step.kind]}
          estimate={{ text: metaLineText(perStep), hint: estimateHint, testId: "inspector-estimate" }}
          marks={
            standsStill ? (
              <StandsStillMark testId="inspector-stands-still" />
            ) : step.kind === "transfer" ? (
              <HeaderMark
                icon={ClipboardList}
                words="Planner only"
                hint={describedHint({ describe: "inspector.plannerOnly" })}
                testId="inspector-transfer-planner-only"
              />
            ) : null
          }
        />
      }
    >
      <HeadBrief describe="inspector.estimated" />
      {othersSelected > 0 ? <MultiStepLine count={othersSelected} stepId={entry.id} /> : null}
      {madeWithTool === undefined ? null : <MadeWithChip feature={madeWithTool} />}
      {pointsLine === null ? null : <SelectionLine line={pointsLine} />}

      {step.kind === "path" ? (
        <PathSections
          key={turn ? `turn-${entry.id}` : "path"}
          stepId={entry.id}
          step={step}
          turn={turn}
          waypointNames={waypointNames}
          commands={commands}
          conditions={conditions.map((condition) => condition.name)}
          selection={selection}
          planned={plannedHeadings}
          narrow={narrow}
        />
      ) : null}

      {step.kind === "command" ? (
        <Section key="command" foldId="command" title="Command" summary={step.name}>
          {/* What the command does is the Command row's hint and each option's hint, not a paragraph. */}
          <ChoiceField
            label="Command"
            value={step.name}
            testId="inspector-command-name"
            rowTestId="inspector-command-name-row"
            hint={commandSummary(commands, step.name) ?? undefined}
            options={commandChoices(commands, step.name)}
            onChange={(name) => {
              tryEdit((current) => setCommandName(current, entry.id, name));
            }}
          />
          <CommandArgsForm
            spec={commands.find((spec) => spec.name === step.name)}
            args={(step.args ?? {}) as Args}
            idPrefix="inspector-arg"
            onChange={(args) => {
              tryEdit((current) => setCommandArgs(current, entry.id, args));
            }}
          />
        </Section>
      ) : null}

      {step.kind === "wait" ? (
        <Section
          key="wait"
          foldId="wait"
          title="Wait"
          summary={waitSummary(step)}
          // A wait for a condition with no time limit may wait to the end: a folded Wait says so with a lemon dot.
          marked={step.until !== undefined && step.timeoutS === undefined ? "warn" : undefined}
        >
          <WaitRows stepId={entry.id} step={step} conditions={conditions.map((condition) => condition.name)} />
        </Section>
      ) : null}

      {step.kind === "transfer" ? (
        <Section key="transfer" foldId="transfer" title="Transfer" summary={`${step.from} → ${step.to}`}>
          <TransferRows
            stepId={entry.id}
            step={step}
            season={derived.season}
            field={autoField ?? project?.field ?? null}
            alliance={auto.alliance}
          />
        </Section>
      ) : null}

      {step.kind === "parallel" ? (
        <Section key="parallel" foldId="parallel" title="Group" summary={PARALLEL_MODES.find((mode) => mode.value === step.mode)?.label}>
          <ParallelRows stepId={entry.id} step={step} />
        </Section>
      ) : null}

      {step.kind === "sequence" || step.kind === "parallel" ? (
        <StepsSection
          key="group.steps"
          parentId={entry.id}
          describe={step.kind === "sequence" ? "inspector.sequenceSteps" : "inspector.parallelSteps"}
          endsWith={step.kind === "parallel" && step.mode === "deadline" ? deadlineOf(entry.id, step) : null}
        />
      ) : null}

      {step.kind === "branch" ? (
        <Section key="branch" foldId="branch" title="Branch" summary={step.condition}>
          <SelectField
            label="Condition"
            value={step.condition}
            options={conditions.map((condition) => ({
              value: condition.name,
              label: condition.name,
            }))}
            onChange={(condition) => {
              tryEdit((current) => setBranchCondition(current, entry.id, condition));
            }}
          />
          <BranchPreview branch={derived.ledgerRun?.byStepId[entry.id]?.branch ?? null} />
        </Section>
      ) : null}

      {step.kind === "transfer" ? (
        <TransferCounts
          step={step}
          season={derived.season}
          alliance={auto.alliance}
          entry={derived.ledgerRun?.byStepId[entry.id] ?? null}
        />
      ) : null}

      {/* A rejoin pose or a stay-inside box the file has is its own section, never hidden in Advanced. */}
      {step.kind === "path" && step.rejoinFrom !== undefined ? (
        <RejoinSection key="rejoin" stepId={entry.id} rejoin={step.rejoinFrom} />
      ) : null}

      {carriesEnvelope(step) && (step.envelope !== undefined || drawingEnvelope) ? (
        <EnvelopeSection
          key="envelope"
          stepId={entry.id}
          envelope={step.envelope}
          timedByEnvelope={perStep?.fromEnvelope === true}
        />
      ) : null}

      <AdvancedSection
        key="step.more"
        stepId={entry.id}
        step={step}
        // Adding an envelope comes with Commands (owner ruling 2026-10-10, issue #273); one the step
        // already has shows as its own section whatever the switch says.
        offerEnvelope={carriesEnvelope(step) && step.envelope === undefined && !drawingEnvelope && envelopeEntryShown(features)}
        offerRejoin={step.kind === "path" && step.rejoinFrom === undefined && offersRejoin(auto, entry, robot)}
        rejoinStart={planned?.segments?.[0]?.fromPose ?? plannedStart}
        startPose={plannedStart}
        estimateS={perStep === undefined || perStep.fromEnvelope === true ? null : perStep.nominalS}
        traced={trace !== null}
        actualS={actualS}
        deltaS={deltaS}
      />

      <NotesSection key={`notes-${entry.id}`} stepId={entry.id} notes={notes} />
    </InspectorFrame>
  );
}

/** The stands-still fact of a command, as an anchor in the header (issue #431). */
function StandsStillMark({ testId }: { testId: string }) {
  return <HeaderMark icon={Anchor} words="Stands still" hint={describedHint({ describe: "inspector.standsStill" })} testId={testId} />;
}

/**
 * A row's brief that belongs to the header, such as the estimate's, drawn only in With descriptions:
 * one quiet line under the selection header.
 */
function HeadBrief({ describe }: { describe: DescriptionId }) {
  const { brief } = useDescribed(describe);
  if (brief === undefined) return null;
  return (
    <p className={styles.headBrief} data-testid="row-brief">
      {brief}
    </p>
  );
}

/**
 * The Selection line while several points are selected (INS-25): what is selected, and how to let
 * go of it, as one 28 px row under the header (issue #431). Dragging and the arrow keys already move
 * the points together.
 */
function SelectionLine({ line }: { line: string }) {
  return (
    <div className={styles.banner} data-testid="inspector-selection">
      <span className={styles.bannerText} data-testid="inspector-points-selected">
        {line}
      </span>
      <TextButton
        label="Clear selection"
        shortcut="Esc"
        hint="Selects nothing, so the Inspector shows the routine."
        testId="inspector-clear-selection"
        onClick={() => {
          setSelection({});
        }}
      />
    </div>
  );
}

/**
 * The line while several steps are selected in the list (issue #505): how many, that the fields
 * below change only the one the Inspector shows, and a way to select just that one. Duplicate,
 * Delete and Wrap in the list's menu act on all of them.
 */
function MultiStepLine({ count, stepId }: { count: number; stepId: string }) {
  return (
    <div className={styles.banner} data-testid="inspector-multi-steps">
      <span className={styles.bannerText} data-testid="inspector-multi-steps-line">
        {`${String(count)} steps selected. The fields below change ${stepId} only.`}
      </span>
      <TextButton
        label={`Select only ${stepId}`}
        hint="Lets go of the other steps, so Duplicate, Delete and Wrap act on this one."
        testId="inspector-multi-steps-only"
        onClick={() => {
          selectStep(stepId);
        }}
      />
    </div>
  );
}

/** A row's brief under a control that draws its own row, drawn only in With descriptions. */
function RowBrief({ describe }: { describe: DescriptionId }) {
  const { brief } = useDescribed(describe);
  if (brief === undefined) return null;
  return (
    <p className={styles.brief} data-testid="row-brief">
      {brief}
    </p>
  );
}

/** The waypoint names of the project in alphabetical order, for the start's and a path end's select. */
function projectWaypointNames(project: ReturnType<typeof useEditor>["project"]): string[] {
  return Object.keys(project?.waypoints?.waypoints ?? {}).sort((a, b) => a.localeCompare(b));
}

/**
 * The routine's start. It is a section of the Routine view and of a selected start only: no step's
 * Inspector carries it (issue #244). It is open unless the person folded it; `forceOpen` holds it
 * open when the start itself was clicked, without writing the fold memory.
 */
function StartRoutineSection({ waypointNames, forceOpen = false }: { waypointNames: string[]; forceOpen?: boolean }) {
  return (
    // Held open, the start is selected and its header has the `?`; in the Routine view the section has it.
    <Section key="routine.start" title="Start" help="section.start" helpInHeader={forceOpen} foldId="routine.start" forceOpen={forceOpen}>
      <StartInspector waypointNames={waypointNames} />
    </Section>
  );
}

/* ---- Step ---------------------------------------------------------------- */

/**
 * A step's notes for the team (issue #431): their own section at the end, folded by default, with a
 * dot while folded once something is written. Open, the text sits in a quiet well that is the box:
 * a click types in it, and the focus leaving it writes the change as one undo step.
 */
function NotesSection({ stepId, notes }: { stepId: string; notes: string }) {
  const written = notes.trim() !== "";
  return (
    <Section title="Notes" foldId="step.notes" defaultOpen={false} marked={written ? "set" : undefined}>
      <TextAreaField
        label="Notes"
        well
        value={notes}
        placeholder="Notes for your team"
        testId="inspector-notes"
        onChange={(value) => {
          tryEdit((current) => setNotes(current, stepId, value));
        }}
      />
    </Section>
  );
}

/**
 * A step's time limit, or none (INS-17, issue #431): Give up after on every kind. A path has it in
 * Speed beside Stop early, a wait for a condition in Wait, and a command or a wait for a time in
 * Advanced. Empty reads `Never`, drawn quiet, the word Stop early uses for its own empty choice.
 */
function TimeoutField({ stepId, timeoutS, chip }: { stepId: string; timeoutS: number | undefined; chip?: ReactNode }) {
  return (
    <NumberField<number | null>
      label="Give up after"
      unit="s"
      value={timeoutS ?? null}
      step={0.1}
      min={0.01}
      nullable
      emptyStart={0}
      quiet={timeoutS === undefined}
      hint={`Empty means no timeout. ${SCRUB_HINT}`}
      rowHint="The step's Timeout: the most it may take before the robot moves on. Empty means no timeout."
      placeholder="Never"
      testId="inspector-timeout"
      rowTestId="inspector-timeout-row"
      // The one chip here, No time limit, is long: beside the box it squeezed the box to 20 px at the
      // Inspector's 240 px (W2-16), so it goes on a line of its own under the value.
      chip={chip}
      onChange={(value) => {
        writeTimeout(stepId, value);
      }}
    />
  );
}

/**
 * The rare rows of a step, behind a disclosure that starts closed (issue #239, UI_GUIDE layout rule
 * 5), as Advanced (issue #431): Give up after on a command and on a wait for a time, adding a
 * stay-inside box, a rejoin pose, and the full sim's time and delta on one row. A dot while folded
 * says a time limit is set inside. With nothing to hold, it is not drawn.
 */
function AdvancedSection({
  stepId,
  step,
  offerEnvelope,
  offerRejoin,
  rejoinStart,
  startPose,
  estimateS,
  traced,
  actualS,
  deltaS,
}: {
  stepId: string;
  step: Step;
  offerEnvelope: boolean;
  offerRejoin: boolean;
  /** Where the planner has the path starting now, which a new rejoin pose copies. */
  rejoinStart: PlannedPose | null;
  /** Where the planner has the step starting, which a new square envelope is centred on. */
  startPose: PlannedPose | null;
  estimateS: number | null;
  /** A full sim trace is loaded, so its time and the delta have a row. */
  traced: boolean;
  actualS: number | null;
  deltaS: number | null;
}) {
  // A path's limit is in Speed and a wait for a condition's in Wait; these two keep theirs here.
  const timeout = step.kind === "command" || (step.kind === "wait" && step.until === undefined);
  if (!timeout && !offerEnvelope && !offerRejoin && !traced) return null;
  const timeoutS = "timeoutS" in step ? step.timeoutS : undefined;
  return (
    <Section title="Advanced" foldId="step.more" defaultOpen={false} marked={timeout && timeoutS !== undefined ? "set" : undefined}>
      {timeout && carriesEnvelope(step) ? <TimeoutField stepId={stepId} timeoutS={timeoutS} /> : null}
      {offerEnvelope && carriesEnvelope(step) ? (
        <EnvelopeEntry stepId={stepId} step={step} startPose={startPose} estimateS={estimateS} />
      ) : null}
      {offerRejoin ? <RejoinEntry stepId={stepId} startPose={rejoinStart} /> : null}
      {traced ? (
        <FieldRow label="Full sim" quiet>
          <span className={styles.readout} data-testid="inspector-actual">
            {actualS === null ? "not in the trace" : actualS.toFixed(2)}
            {actualS === null ? null : <span className="unit">s</span>}
          </span>
          {deltaS === null ? null : (
            <Tooltip label="Delta" hint="The full sim's time less the estimate.">
              <span className={styles.delta} data-testid="inspector-delta" tabIndex={0}>
                {deltaS >= 0 ? "+" : ""}
                {deltaS.toFixed(2)}
                <span className="unit">s</span>
              </span>
            </Tooltip>
          )}
        </FieldRow>
      ) : null}
    </Section>
  );
}

/* ---- Groups -------------------------------------------------------------- */

/** The member a deadline group names as the one that ends it, or null when it names none of its own. */
function deadlineOf(stepId: string, step: ParallelStep): string | null {
  const memberIds = step.steps.map((child, index) => child.id ?? `${stepId}.${String(index + 1)}`);
  return step.deadline !== undefined && memberIds.includes(step.deadline) ? step.deadline : null;
}

/**
 * The members of a sequence or parallel group as their own Steps section (INS-22, issue #431): one
 * 24 px row each, the kind's icon, the id and the estimate. A click selects that member. In deadline
 * mode the member that ends the group carries a flag, whose words are its tooltip and, in With
 * descriptions, are drawn beside it.
 */
function StepsSection({
  parentId,
  describe,
  endsWith = null,
}: {
  parentId: string;
  describe: DescriptionId;
  endsWith?: string | null;
}) {
  const { auto } = useEditor();
  const derived = useDerived();
  const { brief, hint } = useDescribed(describe);
  const full = useDescriptions() === "full";
  if (auto === null) return null;
  const members = indexSteps(auto).filter((candidate) => candidate.parentId === parentId);
  return (
    <Section title="Steps" foldId="group.steps" count={members.length} tight>
      <div className={styles.members} data-testid="inspector-members" role="group" aria-label="Steps">
        {brief === undefined ? null : (
          <p className={styles.brief} data-testid="row-brief">
            {brief}
          </p>
        )}
        {members.map((member) => {
          const Icon = KIND_ICON[member.step.kind];
          const seconds = derived.estimate?.byStepId[member.id]?.nominalS ?? null;
          return (
            // What the list is for is each row's long-hover hint, as a row label's is.
            <Tooltip key={member.id} label={`Select ${member.id}`} hint={hint} delay="long">
              <button
                type="button"
                className={styles.memberRow}
                data-testid={`inspector-member-${member.id}`}
                onClick={() => {
                  selectStep(member.id);
                }}
              >
                <Icon size={12} strokeWidth={1.75} aria-hidden className={styles.memberIcon} />
                <span className={styles.memberId}>{member.id}</span>
                {endsWith === member.id ? (
                  <span className={styles.memberEnds} data-testid="inspector-member-ends" title="Ends the group">
                    <Flag size={12} strokeWidth={1.75} aria-hidden />
                    <span className={full ? styles.memberEndsWords : "visually-hidden"}>ends the group</span>
                  </span>
                ) : null}
                <span className={styles.memberTime}>{seconds === null ? "—" : `${seconds.toFixed(1)} s`}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * A parallel group's mode, and the member that ends it in deadline mode (Ends with, INS-23).
 * Switching to deadline names the group's first step that drives, and switching away removes it
 * (core's `setParallel`), so there is no empty choice. A disabled Pick a step shows only when the
 * file names no step of the group. Its members are the Steps section after it.
 */
function ParallelRows({ stepId, step }: { stepId: string; step: ParallelStep }) {
  const memberIds = step.steps.map((child, index) => child.id ?? `${stepId}.${String(index + 1)}`);
  const named = deadlineOf(stepId, step);
  return (
    <>
      <SelectField
        label="Mode"
        value={step.mode}
        options={PARALLEL_MODES}
        testId="inspector-parallel-mode"
        onChange={(mode) => {
          tryEdit((current) => setParallel(current, stepId, { mode }));
        }}
      />
      {step.mode === "deadline" ? (
        <SelectField
          label="Ends with"
          value={named ?? ""}
          testId="inspector-parallel-deadline"
          options={[
            ...(named === null ? [{ value: "", label: "Pick a step", disabled: true }] : []),
            ...memberIds.map((id) => ({ value: id, label: id })),
          ]}
          onChange={(deadline) => {
            tryEdit((current) => setParallel(current, stepId, { deadline }));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Which side of a branch the preview follows (INS-24), in words: If true or If false. When the
 * ledger could not read the condition, a quiet guess chip carries its reason.
 */
function BranchPreview({ branch }: { branch: LedgerEntry["branch"] }) {
  if (branch === null) return null;
  return (
    <FieldRow
      label="Preview follows"
      testId="inspector-branch-row"
      chipInline
      chip={
        branch.known ? undefined : (
          <StatusChip hint={branch.reason ?? "The ledger cannot tell, so the preview takes If true."} testId="inspector-branch-guess">
            guess
          </StatusChip>
        )
      }
    >
      <span className={styles.wordValue} data-testid="inspector-branch-side">
        {branch.then ? "If true" : "If false"}
      </span>
    </FieldRow>
  );
}

/* ---- Transfer ------------------------------------------------------------ */

/** One location's count before and after the step, from the ledger: `partner 4 → 0`. */
function countLine(
  season: SeasonRules,
  alliance: "RED" | "BLUE",
  entry: LedgerEntry | null,
  id: string,
): string {
  if (entry === null || season.locations === undefined) return "—";
  const find = (list: LedgerLocation[]): LedgerLocation | undefined => list.find((location) => location.id === id);
  const before = find(season.locations(entry.before, alliance))?.count;
  const after = find(season.locations(entry.after, alliance))?.count;
  if (before === undefined || after === undefined) return "—";
  if (before === null || after === null) return "not counted";
  return before === after ? String(after) : `${String(before)} → ${String(after)}`;
}

/**
 * A planner-only transfer: where the pieces come from and go to, the count the routine is written
 * for, and the count the ledger uses instead, with its reset at the row's right edge. Changing
 * either count changes the preview and the checks, never what the robot runs.
 */
function TransferRows({
  stepId,
  step,
  season,
  field,
  alliance,
}: {
  stepId: string;
  step: TransferStep;
  season: SeasonRules;
  field: import("@horizon36596/zenith-schema").Field | null;
  alliance: "RED" | "BLUE";
}) {
  const choices = transferChoices(season, field, alliance, [step.from, step.to]);
  return (
    <>
      <SelectField
        label="From"
        value={step.from}
        options={choices}
        testId="inspector-transfer-from"
        onChange={(from) => {
          tryEdit((current) => setTransfer(current, stepId, { from }));
        }}
      />
      <SelectField
        label="To"
        value={step.to}
        options={choices}
        testId="inspector-transfer-to"
        onChange={(to) => {
          tryEdit((current) => setTransfer(current, stepId, { to }));
        }}
      />
      <NumberField
        label="Expected"
        value={step.expectedCount}
        step={1}
        digits={0}
        min={0}
        hint={`How many pieces the auto is written for. ${SCRUB_HINT}`}
        testId="inspector-transfer-expected"
        onChange={(value) => {
          tryEdit((current) => setTransfer(current, stepId, { expectedCount: Math.round(value) }));
        }}
      />
      <NumberField<number | null>
        label="Actual"
        value={step.actualCount ?? null}
        step={1}
        digits={0}
        min={0}
        nullable
        quiet={!transferOverridden(step)}
        placeholder={String(step.expectedCount)}
        hint="What the ledger moves instead, to preview an edge case such as the partner failing to tip. Empty means the expected count."
        testId="inspector-transfer-actual"
        action={
          transferOverridden(step) ? (
            <RowButton
              icon={Trash}
              label="Use the expected count"
              hint="Clear the actual count, so the ledger moves the expected one again."
              onClick={() => {
                tryEdit((current) => setTransfer(current, stepId, { actualCount: null }));
              }}
              testId="inspector-transfer-reset"
            />
          ) : undefined
        }
        onChange={(value) => {
          tryEdit((current) =>
            setTransfer(current, stepId, { actualCount: value === null ? null : Math.round(value) }),
          );
        }}
      />
    </>
  );
}

/** What the ledger does with a transfer's counts: a fold of its own, closed, gone with the Ledger switch. */
function TransferCounts({
  step,
  season,
  alliance,
  entry,
}: {
  step: TransferStep;
  season: SeasonRules;
  alliance: "RED" | "BLUE";
  entry: LedgerEntry | null;
}) {
  const ledgerOn = useFeature("ledger");
  if (!ledgerOn) return null;
  const moved = entry?.transfer?.moved ?? null;
  return (
    <Section title="Counts" foldId="transfer.counts" defaultOpen={false}>
      <FieldRow label="Ledger moves" quiet>
        <span className={styles.readout} data-testid="inspector-transfer-moved">
          {moved === null ? "—" : String(moved)}
        </span>
      </FieldRow>
      <FieldRow label={step.from} quiet>
        <span className={styles.readout} data-testid="inspector-transfer-from-count">
          {countLine(season, alliance, entry, step.from)}
        </span>
      </FieldRow>
      <FieldRow label={step.to} quiet>
        <span className={styles.readout} data-testid="inspector-transfer-to-count">
          {countLine(season, alliance, entry, step.to)}
        </span>
      </FieldRow>
    </Section>
  );
}

/* ---- Wait ---------------------------------------------------------------- */

/** A folded Wait's summary: `1.50 s`, or the condition it waits for. */
function waitSummary(step: WaitStep): string {
  return step.until === undefined ? `${(step.seconds ?? 0).toFixed(2)} s` : step.until;
}

/**
 * A wait waits for a time or for a condition, never both (issue #144), so one Wait for choice picks
 * which and only that field is shown. A switch is one undo step, and the status line says so. On a
 * wait for a condition the cap is its own row, Give up after, said once (INS-17), and with none the
 * warning chip sits in that row's chip slot (issue #431).
 */
function WaitRows({ stepId, step, conditions }: { stepId: string; step: WaitStep; conditions: string[] }) {
  return (
    <>
      <SelectField
        label="Wait for"
        value={step.until === undefined ? "time" : "condition"}
        testId="inspector-wait-for"
        options={[
          { value: "time", label: "A time" },
          { value: "condition", label: "A condition" },
        ]}
        onChange={(kind) => {
          if (kind === "time") waitForTime(stepId);
          else waitForCondition(stepId, conditions[0]);
        }}
      />
      {step.until === undefined ? (
        <NumberField
          label="Seconds"
          unit="s"
          value={step.seconds ?? null}
          step={0.1}
          min={0}
          testId="inspector-wait-seconds"
          onChange={(value) => {
            tryEdit((current) => setWait(current, stepId, { seconds: value }));
          }}
        />
      ) : (
        <>
          <SelectField
            label="Until"
            value={step.until}
            testId="inspector-wait-until"
            rowTestId="inspector-wait-until-row"
            describe="inspector.waitUntil"
            options={[...conditions, ...(conditions.includes(step.until) ? [] : [step.until])].map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={(until) => {
              tryEdit((current) => setWait(current, stepId, { until }));
            }}
          />
          {/* On a wait for a condition the Timeout is the cap, so it sits here rather than in Advanced. */}
          <TimeoutField
            stepId={stepId}
            timeoutS={step.timeoutS}
            chip={
              step.timeoutS === undefined ? (
                <StatusChip
                  tone="warn"
                  hint={describedHint({ describe: "inspector.waitUntil" })}
                  testId="inspector-wait-no-timeout"
                >
                  {NO_TIMEOUT_WARNING}
                </StatusChip>
              ) : undefined
            }
          />
        </>
      )}
    </>
  );
}

/* ---- Path ---------------------------------------------------------------- */

/**
 * The sections of a path step (issue #431): PATH, or PATHS with one sub-group per path of a chain,
 * with + Add path to chain as its header's action; then HEADING, SPEED and MARKERS. A point selected
 * on the field opens its path, and a control point its Controls, without writing the fold memory.
 *
 * A turn on the spot (`turn`, issue #505) shows only what a turn has: HEADING, then TURN with Give up
 * after and Edit as a path, which shows the sections above, to make it drive somewhere.
 */
function PathSections({
  stepId,
  step,
  turn,
  waypointNames,
  commands,
  conditions,
  selection,
  planned,
  narrow,
}: {
  stepId: string;
  step: PathStep;
  /** Whether the step is a turn on the spot: a path step with no length. */
  turn: boolean;
  waypointNames: string[];
  commands: CommandSpec[];
  conditions: string[];
  /** What is selected on the field: its primary point opens its path and marks its own block. */
  selection: Selection;
  /** The headings the robot has now at the path's two ends, which a switch to Constant or Linear keeps. */
  planned: PlannedHeadings | null;
  /** The Inspector is under 300 px wide, so Speed and Markers start folded (INS-34). */
  narrow: boolean;
}) {
  const commandsOn = useFeature("commands");
  // Piecewise is offered for a path that is not piecewise yet only with Advanced heading on.
  const headingChoices = piecewiseOffered(step.heading, useFeatures())
    ? HEADING_CHOICES
    : HEADING_CHOICES.filter((choice) => choice.value !== "piecewise");
  const single = step.segments.length === 1;
  // In a chain of several paths, one is open: the one holding the selected point, else the first.
  // This follows the selection and is not remembered (issue #241). A later path's From at a joint is
  // edited under the earlier path's To, so it opens that path.
  const waypoints = useEditor().project?.waypoints;
  const point = selection.stepId === stepId ? selection.point : undefined;
  const selectedPoint = jointOwner(step, point, waypoints);
  const selectedSegment = selectedPoint?.segmentIndex;
  const openPath = selectedSegment !== undefined && selectedSegment < step.segments.length ? selectedSegment : 0;
  const mode = step.heading?.mode ?? "tangent";
  const first = step.segments[0];
  const robotSpeed = useRobotDefaultSpeed();
  const [asPath, setAsPath] = useState(false);
  const turnOnly = turn && !asPath;
  const headingSection = (
    <Section
      key="path.heading"
      foldId="path.heading"
      scope={stepId}
      title="Heading"
      help="section.heading"
      summary={headingModeInfo(mode).label}
      actions={
        DERIVED_MODES.has(mode) ? (
          // The path decides the heading; the one way to set it by hand (INS-02) is the header's pencil.
          <RowButton
            icon={Pencil}
            label="Switch to Linear"
            hint="Makes the heading one you set, starting from the way the path faces now."
            testId="inspector-heading-linear"
            onClick={() => {
              writeHeadingMode(stepId, headingForMode("linear", step.heading, planned));
            }}
          />
        ) : undefined
      }
    >
      <HeadingRows stepId={stepId} step={step} mode={mode} planned={planned} choices={headingChoices} />
    </Section>
  );
  if (turnOnly) {
    return (
      <>
        {headingSection}
        <Section key="path.turn" foldId="path.turn" title="Turn" help="section.heading" summary={step.timeoutS === undefined ? undefined : `gives up after ${step.timeoutS.toFixed(2)} s`}>
          <TimeoutField stepId={stepId} timeoutS={step.timeoutS} />
          <TextButton
            label="Edit as a path"
            hint="Shows its points, speed and markers, so it can drive somewhere as well as turn."
            testId="inspector-turn-as-path"
            onClick={() => {
              setAsPath(true);
            }}
          />
        </Section>
      </>
    );
  }
  return (
    <>
      <Section
        key="path.paths"
        foldId="path.paths"
        scope={stepId}
        title={single ? "Path" : "Paths"}
        count={single ? undefined : step.segments.length}
        help="section.segment"
        summary={single && first !== undefined ? segmentSummary(first) : undefined}
        // A point selected on the field holds the paths open and writes no memory (issue #243).
        forceOpen={selectedPoint !== undefined}
        holder={selectedPoint === undefined ? undefined : `${String(selectedPoint.segmentIndex)}-${pointHolder(selectedPoint) ?? ""}`}
        tight={!single}
        actions={
          // The chain stays joined: the new path starts where the last one ends (issue #185).
          <RowButton
            icon={Plus}
            label="Add path to chain"
            hint="A new path at the end of this chain, starting where the last one ends."
            testId="inspector-chain-add"
            onClick={() => {
              appendPathToChain(stepId);
            }}
          />
        }
      >
        {single ? (
          <SegmentRows stepId={stepId} step={step} index={0} waypointNames={waypointNames} selection={selection} />
        ) : (
          step.segments.map((segment, index) => (
            <Section
              // Keyed by whether the selection opens it, so a new selection folds the paths afresh.
              key={`${stepId}-segment-${String(index)}-${index === openPath ? "open" : "folded"}`}
              variant="sub"
              defaultOpen={index === openPath}
              // A point selected here holds its path open and writes no memory.
              forceOpen={selectedSegment === index}
              // Each point is its own holder, so a path folded over one selected point opens for the next.
              holder={selectedSegment === index ? pointHolder(selectedPoint) : undefined}
              title={`Path ${String(index + 1)}`}
              summary={segmentSummary(segment)}
              hoverActions
              actions={
                // The chain stays joined: the next path starts where the one before this ends (issue #185).
                <RowButton
                  icon={Trash}
                  label="Remove this path"
                  hint="The paths either side stay joined."
                  testId={`inspector-segment-remove-${String(index)}`}
                  onClick={() => {
                    removePathFromChain(stepId, index);
                  }}
                />
              }
            >
              <SegmentRows stepId={stepId} step={step} index={index} waypointNames={waypointNames} selection={selection} />
            </Section>
          ))
        )}
      </Section>

      {headingSection}

      <Section
        key="path.speed"
        foldId="path.speed"
        title="Speed"
        help="section.speed"
        defaultOpen={!narrow}
        summary={speedSummary(step, robotSpeed)}
      >
        <SpeedFractionField
          value={step.speedFraction}
          onChange={(value) => {
            writeSpeed(stepId, value);
          }}
        />
        <SelectField
          label="Stop early"
          value={step.endCondition?.condition ?? ""}
          describe="inspector.endCondition"
          testId="inspector-end-condition"
          quiet={step.endCondition === undefined}
          options={[
            { value: "", label: "Never" },
            ...conditions.map((condition) => ({ value: condition, label: condition })),
          ]}
          onChange={(value) => {
            tryEdit((current) => setEndCondition(current, stepId, value === "" ? null : value));
          }}
        />
        {/* A student treats when to stop early and when to give up as one decision (issue #431). */}
        <TimeoutField stepId={stepId} timeoutS={step.timeoutS} />
      </Section>

      {/* Markers run commands, so the Commands switch in Settings, General hides them. */}
      {commandsOn ? (
        <MarkersSection stepId={stepId} markers={step.markers ?? []} commands={commands} narrow={narrow} />
      ) : null}
    </>
  );
}

/** The Heading section's rows: the mode, then the numbers that mode has. */
function HeadingRows({
  stepId,
  step,
  mode,
  planned,
  choices,
}: {
  stepId: string;
  step: PathStep;
  mode: NonNullable<PathStep["heading"]>["mode"];
  planned: PlannedHeadings | null;
  choices: typeof HEADING_CHOICES;
}) {
  return (
    <>
      <ChoiceField
        label="Mode"
        value={mode}
        testId="inspector-heading-mode"
        hint={describedHint({ describe: "inspector.headingMode" })}
        options={choices}
        onChange={(next) => {
          writeHeadingMode(stepId, headingForMode(next, step.heading, planned));
        }}
      />
      <RowBrief describe="inspector.headingMode" />
      {DERIVED_MODES.has(mode) ? (
        // The path decides the heading: what the plan gives at its two ends, read only (INS-02).
        <FieldRow
          label="Planned"
          quiet
          testId="inspector-heading-planned-row"
          hint="The headings the plan gives the robot at the start and the end of this path."
        >
          <span className={styles.readout} data-testid="inspector-heading-planned">
            {planned === null ? "not planned yet" : `${formatHeading(planned.startRad)} → ${formatHeading(planned.endRad)}`}
          </span>
        </FieldRow>
      ) : null}
      {step.heading?.mode === "piecewise" ? <PiecewiseEditor stepId={stepId} heading={step.heading} /> : null}
      {step.heading?.mode === "constant" ? (
        <NumberField
          label="Heading"
          unit="°"
          value={radToDeg(step.heading.headingRad)}
          step={5}
          digits={1}
          testId="inspector-heading-constant"
          onChange={(deg) => {
            writeHeadingMode(stepId, { mode: "constant", headingRad: degToRad(deg) });
          }}
        />
      ) : null}
      {step.heading?.mode === "linear" ? (
        <>
          <NumberField
            label="From"
            unit="°"
            value={radToDeg(step.heading.fromRad)}
            step={5}
            digits={1}
            testId="inspector-heading-from"
            onChange={(deg) => {
              if (step.heading?.mode !== "linear") return;
              writeHeadingMode(stepId, {
                mode: "linear",
                fromRad: degToRad(deg),
                toRad: step.heading.toRad,
              });
            }}
          />
          <NumberField
            label="To"
            unit="°"
            value={radToDeg(step.heading.toRad)}
            step={5}
            digits={1}
            testId="inspector-heading-to"
            onChange={(deg) => {
              if (step.heading?.mode !== "linear") return;
              writeHeadingMode(stepId, {
                mode: "linear",
                fromRad: step.heading.fromRad,
                toRad: degToRad(deg),
              });
            }}
          />
        </>
      ) : null}
      {step.heading?.mode === "facePoint" ? (
        <>
          <NumberField
            label="Point x"
            unit="in"
            value={step.heading.xIn}
            onChange={(xIn) => {
              if (step.heading?.mode !== "facePoint") return;
              writeHeadingMode(stepId, { ...step.heading, xIn });
            }}
          />
          <NumberField
            label="Point y"
            unit="in"
            value={step.heading.yIn}
            onChange={(yIn) => {
              if (step.heading?.mode !== "facePoint") return;
              writeHeadingMode(stepId, { ...step.heading, yIn });
            }}
          />
          <NumberField
            label="Offset"
            unit="°"
            value={radToDeg(step.heading.offsetRad ?? 0)}
            step={5}
            digits={1}
            onChange={(deg) => {
              if (step.heading?.mode !== "facePoint") return;
              writeHeadingMode(stepId, { ...step.heading, offsetRad: degToRad(deg) });
            }}
          />
        </>
      ) : null}
    </>
  );
}

/** The folded Speed's summary: `30%`, or `80% default` for the robot's, then a stop or a limit if set. */
function speedSummary(step: PathStep, robotDefault: number | undefined): string {
  const speed =
    step.speedFraction !== undefined
      ? percentText(step.speedFraction)
      : robotDefault === undefined
        ? "default speed"
        : `${percentText(robotDefault)} default`;
  const parts = [speed];
  if (step.endCondition !== undefined) parts.push("stops early");
  if (step.timeoutS !== undefined) parts.push(`gives up after ${step.timeoutS.toFixed(2)} s`);
  return parts.join(", ");
}

/**
 * The point that holds the selection in the chain's sections: a later path's From at a joint is the
 * earlier path's To, where the joint is edited (INS-10).
 */
function jointOwner(step: PathStep, point: PointTarget | undefined, waypoints: Waypoints | undefined): PointTarget | undefined {
  if (point === undefined || point.pointKind !== "from" || point.segmentIndex === 0) return point;
  return joinsEarlier(step, point.segmentIndex, waypoints) ? { segmentIndex: point.segmentIndex - 1, pointKind: "to" } : point;
}

/**
 * Whether a later path's From is the same point as the earlier path's To, by core's `jointTwin`:
 * written as `"current"`, the same waypoint, or a pose on the same spot. A gap is not a joint, so
 * its From keeps its editor.
 */
function joinsEarlier(step: PathStep, segmentIndex: number, waypoints: Waypoints | undefined): boolean {
  return segmentIndex > 0 && jointTwin(step, { segmentIndex, pointKind: "from" }, waypoints) !== null;
}

/**
 * One path's own rows: its kind, its From and To, and a curve's control points behind a Controls
 * row that starts folded (issue #431). A later path's From that joins the path before it is one
 * read-only line (INS-10).
 */
function SegmentRows({
  stepId,
  step,
  index,
  waypointNames,
  selection,
}: {
  stepId: string;
  step: PathStep;
  index: number;
  waypointNames: string[];
  selection: Selection;
}) {
  const { project } = useEditor();
  const waypoints = project?.waypoints;
  const segment = step.segments[index];
  if (segment === undefined) return null;
  const owner = jointOwner(step, selection.stepId === stepId ? selection.point : undefined, waypoints);
  const primary = (target: PointTarget): boolean =>
    owner !== undefined && selection.stepId === stepId && isPrimaryPoint({ stepId, point: owner }, stepId, target);
  const joined = joinsEarlier(step, index, waypoints);
  const control = owner !== undefined && owner.segmentIndex === index && owner.pointKind === "control" ? owner : undefined;
  return (
    <>
      <SelectField
        label="Kind"
        value={segment.kind}
        testId={`inspector-segment-kind-${String(index)}`}
        options={[
          { value: "line", label: "Straight line" },
          { value: "bezier", label: "Curve" },
        ]}
        onChange={(kind) => {
          setSegmentKindAt(stepId, index, kind);
        }}
      />
      {joined ? (
        <FieldRow
          label="From"
          quiet
          testId={`inspector-from-joint-${String(index)}`}
          hint={`Where Path ${String(index)} ends. Edit the joint under Path ${String(index)}'s To.`}
        >
          <span className={styles.quietValue} data-testid={`inspector-from-joint-text-${String(index)}`}>
            End of Path {index}
          </span>
        </FieldRow>
      ) : (
        <PoseSourceEditor
          stepId={stepId}
          segmentIndex={index}
          pointKind="from"
          source={segment.from}
          waypointNames={waypointNames}
          describe="inspector.endSource"
          selected={primary({ segmentIndex: index, pointKind: "from" })}
        />
      )}
      <PoseSourceEditor
        stepId={stepId}
        segmentIndex={index}
        pointKind="to"
        source={segment.to}
        waypointNames={waypointNames}
        describe={index === 0 ? "inspector.endSourceTo" : "inspector.endSourceLater"}
        selected={primary({ segmentIndex: index, pointKind: "to" })}
      />
      {segment.kind === "bezier" ? (
        <Section
          key={`${stepId}-controls-${String(index)}`}
          variant="row"
          title="Controls"
          foldId="path.controls"
          defaultOpen={false}
          // A control point selected on the field opens them for now (issue #431).
          forceOpen={control !== undefined}
          holder={control === undefined ? undefined : pointHolder(control)}
          summary={`${String(segment.control.length)} ${segment.control.length === 1 ? "point" : "points"}`}
          headTestId={`inspector-controls-${String(index)}`}
        >
          {segment.control.map((point, controlIndex) => (
            <ControlPointEditor
              key={`control-${String(controlIndex)}`}
              stepId={stepId}
              segmentIndex={index}
              controlIndex={controlIndex}
              pose={point}
              selected={primary({ segmentIndex: index, pointKind: "control", controlIndex })}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}

/** A folded path's summary after its title: its kind and where it ends, `curve → scoreNorth`. */
function segmentSummary(segment: PathStep["segments"][number]): string {
  const to = segment.to;
  const where =
    to === "current" ? "the previous end" : "ref" in to ? to.ref : `${to.xIn.toFixed(1)}, ${to.yIn.toFixed(1)}`;
  return `${segment.kind === "bezier" ? "curve" : "line"} → ${where}`;
}

/** Where a marker fires, in words for the list: `50% along`, `12.0 in from the start`. */
function markerWhere(at: MarkerAt): string {
  if ("t" in at) return `${String(Math.round(at.t * 100))}% along`;
  if ("distanceIn" in at) return `${at.distanceIn.toFixed(1)} in from the start`;
  return `${at.distanceFromEndIn.toFixed(1)} in from the end`;
}

/**
 * The path's markers as a list (issue #431): + Add marker is the header's action, and each 24 px
 * row selects that marker, which then shows alone, where its command, arguments and position are
 * edited. Each row's bin shows on hover or focus. With none, the section is its header.
 */
function MarkersSection({
  stepId,
  markers,
  commands,
  narrow,
}: {
  stepId: string;
  markers: readonly Marker[];
  commands: CommandSpec[];
  narrow: boolean;
}) {
  const markerKey = useKeyLabel("marker");
  const first = commands[0];
  return (
    <Section
      title="Markers"
      help="section.markers"
      foldId="path.markers"
      scope={stepId}
      defaultOpen={!narrow}
      count={markers.length === 0 ? undefined : markers.length}
      tight
      actions={
        <RowButton
          icon={Plus}
          label="Add marker"
          shortcut={markerKey}
          hint={describedHint({ describe: "inspector.addMarker" })}
          disabled={first === undefined}
          whyDisabled="The robot has no commands for a marker to fire."
          testId="inspector-marker-add"
          onClick={() => {
            if (first === undefined) return;
            placeMarker(stepId, { t: 0.5 }, first.name);
          }}
        />
      }
    >
      {markers.length === 0
        ? null
        : markers.map((marker, index) => (
            <div key={`marker-${String(index)}`} className={styles.markerRow}>
              <button
                type="button"
                className={styles.markerOpen}
                data-testid={`inspector-marker-open-${String(index)}`}
                onClick={() => {
                  setSelection({ stepId, markerIndex: index });
                }}
              >
                <span className={styles.markerTitle}>{marker.command.name}</span>
                <span className={styles.markerWhere}>{markerWhere(marker.at)}</span>
              </button>
              <span className={styles.hoverAction}>
                <RowButton
                  icon={Trash}
                  label="Remove this marker"
                  testId={`inspector-marker-remove-${String(index)}`}
                  onClick={() => {
                    deleteMarker(stepId, index);
                  }}
                />
              </span>
            </div>
          ))}
    </Section>
  );
}

/** The At row's units, in words: a share of the path, or inches from either end (INS-12). */
const MARKER_UNITS: ReadonlyArray<{ value: MarkerUnit; label: string }> = [
  { value: "t", label: "% along" },
  { value: "distanceIn", label: "in from start" },
  { value: "distanceFromEndIn", label: "in from end" },
];

/**
 * The selected marker (INS-13): the command it fires, that command's arguments from robot.json, and
 * where on the path it fires, as one At row with a unit select (issue #242). A share of the path
 * shows as a percent, `50% along`, while the file keeps `t`. The way back to its path and its bin
 * are in the selection header (issue #431).
 */
function MarkerSection({
  stepId,
  index,
  marker,
  commands,
  pathLengthIn,
}: {
  stepId: string;
  index: number;
  marker: Marker;
  commands: CommandSpec[];
  /** How long the planner has the path, which a distance from either end may not pass; null when unknown. */
  pathLengthIn: number | null;
}) {
  const at = marker.at;
  const maxIn = markerMaxIn(pathLengthIn);
  const unit: MarkerUnit = "t" in at ? "t" : "distanceIn" in at ? "distanceIn" : "distanceFromEndIn";
  // The number the row shows: a percent for `t`, inches otherwise.
  const shown = "t" in at ? Math.round(at.t * 10000) / 100 : "distanceIn" in at ? at.distanceIn : at.distanceFromEndIn;
  const spec = commands.find((candidate) => candidate.name === marker.command.name);
  return (
    // It shows only under the marker's selection header, which has the `?`.
    <Section title="Marker" foldId="marker" help="section.marker" helpInHeader>
      <ChoiceField
        label="Command"
        value={marker.command.name}
        testId="inspector-marker-command"
        hint={commandSummary(commands, marker.command.name) ?? undefined}
        options={commandChoices(commands, marker.command.name)}
        onChange={(name) => {
          tryEdit((current) => setMarkerCommand(current, stepId, index, { name }));
        }}
      />
      <CommandArgsForm
        spec={spec}
        args={(marker.command.args ?? {}) as Args}
        idPrefix="inspector-marker-arg"
        onChange={(args) => {
          tryEdit((current) => setMarkerCommand(current, stepId, index, { name: marker.command.name, args }));
        }}
      />
      <NumberUnitField
        label="At"
        value={shown}
        step={unit === "t" ? 5 : 1}
        digits={unit === "t" ? 0 : 2}
        min={0}
        max={unit === "t" ? 100 : maxIn}
        testId="inspector-marker-at"
        hint={
          unit === "t" || maxIn === undefined
            ? "You can also drag the marker along the path on the field."
            : "At most the path's length. You can also drag the marker along the path on the field."
        }
        unit={{
          value: unit,
          options: MARKER_UNITS,
          testId: "inspector-marker-at-unit",
          // The number shown stays as it is, fitted to the new unit's range, so a switch never moves it far.
          onChange: (next) => {
            tryEdit((current) => setMarkerAt(current, stepId, index, markerAtInUnit(next, next === "t" ? shown / 100 : shown, pathLengthIn)));
          },
        }}
        onChange={(next) => {
          tryEdit((current) =>
            setMarkerAt(
              current,
              stepId,
              index,
              unit === "t"
                ? { t: Math.round(next * 100) / 10000 }
                : unit === "distanceIn"
                  ? { distanceIn: next }
                  : { distanceFromEndIn: next },
            ),
          );
        }}
      />
    </Section>
  );
}

/* ---- Poses --------------------------------------------------------------- */

/** A followed waypoint's pose as words: `-13.00, -36.00 in`, for a tooltip and a brief. */
function followedWords(waypoint: { xIn: number; yIn: number }): string {
  return `${waypoint.xIn.toFixed(2)}, ${waypoint.yIn.toFixed(2)} in`;
}

/**
 * Where a followed waypoint is, read only and quiet, as a Position row (INS-06, issue #431): `-13.00
 * -36.00 in`. The crosshair on the row above goes to the waypoint to edit it, since moving it moves
 * every point that follows it.
 */
function FollowedPoseRow({ name, testId }: { name: string; testId: string }) {
  const { project } = useEditor();
  const waypoint = project?.waypoints?.waypoints[name];
  if (waypoint === undefined) return null;
  return (
    <FieldRow label="Position" quiet hint={`Where waypoint ${name} is. Select it to move it, and every end that follows it.`}>
      <span className={styles.poseReadout} data-testid={testId}>
        <span className={styles.poseNumber}>{waypoint.xIn.toFixed(2)}</span>{" "}
        <span className={styles.poseNumber}>{waypoint.yIn.toFixed(2)}</span> <span className="unit">in</span>
      </span>
    </FieldRow>
  );
}

/**
 * One end of a segment, in one SourceSelect (issue #241): for its start "Last step's end" (for a
 * later path of the chain, "Previous path's end", the same `"current"` in the file), drawn quiet as
 * the default, then "This pose", then every waypoint. "This pose" keeps the point where it stands
 * now (issue #133), with its numbers and short provenance chip. A waypoint makes the end follow it:
 * the selected end shows where it is as a quiet Position row, and an end that is not selected keeps
 * it in its tooltip, and as a brief in With descriptions (issue #431). A crosshair at the row's end
 * selects the waypoint followed, and a bookmark-plus saves an end of its own as a waypoint (issue
 * #134). Only the primary selected end has a heading row; the Heading section is where heading is
 * edited (INS-02).
 */
function PoseSourceEditor({
  stepId,
  segmentIndex,
  pointKind,
  source,
  waypointNames,
  describe,
  selected,
}: {
  stepId: string;
  segmentIndex: number;
  pointKind: "from" | "to";
  source: PoseSource;
  waypointNames: string[];
  describe: DescriptionId;
  /** This end is the primary selected point: its block takes the selected-row style. */
  selected: boolean;
}) {
  const { project } = useEditor();
  const bounds = usePoseBounds();
  const full = useDescriptions() === "full";
  const kind = source === "current" ? "current" : "ref" in source ? "ref" : "pose";
  const pose = kind === "pose" ? (source as Pose) : null;
  const follows = source !== "current" && "ref" in source ? source.ref : null;
  const followed = follows === null ? undefined : project?.waypoints?.waypoints[follows];

  // A typed number keeps the point's label, except MEASURED and CALIBRATED FROM ROBOT, which become
  // SET FROM EDITOR with a warning (issue #273). Where two segments meet is one point: typing either
  // end moves both (issue #146).
  const write = (patch: { xIn?: number; yIn?: number }): void => {
    if (pose === null) return;
    writePointNumbers(stepId, { segmentIndex, pointKind }, patch);
  };
  const owner = { stepId, point: { segmentIndex, pointKind } };
  const choices = endChoices(pointKind, segmentIndex, waypointNames, source);
  const id = `${pointKind}-${String(segmentIndex)}`;
  return (
    <PointBlock selected={selected} testId={`inspector-point-${id}`}>
      {/* One select for where the end is (issue #241), with its waypoint button at the row's end. */}
      <SourceSelect
        label={pointKind === "from" ? "From" : "To"}
        value={endChoiceOf(source)}
        ends={choices.ends}
        group={{ label: "Waypoints", options: choices.waypoints }}
        describe={describe}
        quiet={kind === "current"}
        detail={followed === undefined ? undefined : followedWords(followed)}
        brief={
          // In With descriptions an end that is not selected says where its waypoint is, in words.
          full && !selected && followed !== undefined ? (
            <span className={styles.followedBrief} data-testid={`inspector-${id}-follows-brief`}>
              {followedWords(followed)}
            </span>
          ) : undefined
        }
        testId={`inspector-${pointKind}-source-${String(segmentIndex)}`}
        onChange={(choice) => {
          chooseEndSource(owner, choice);
        }}
        action={<WaypointEndAction owner={owner} follows={follows} />}
      />

      {follows === null || !selected ? null : <FollowedPoseRow name={follows} testId={`inspector-${id}-follows-pose`} />}

      {pose === null ? null : (
        <PoseRow
          label="Position"
          x={{
            ...bounds.x,
            value: pose.xIn,
            testId: `inspector-${pointKind}-x-${String(segmentIndex)}`,
            onChange: (xIn) => {
              write({ xIn });
            },
          }}
          y={{
            ...bounds.y,
            value: pose.yIn,
            testId: `inspector-${pointKind}-y-${String(segmentIndex)}`,
            onChange: (yIn) => {
              write({ yIn });
            },
          }}
          chip={
            <ProvenancePicker
              short
              provenance={pose.provenance}
              hint={POSE_PROVENANCE_HINT}
              testId={`inspector-${pointKind}-provenance-${String(segmentIndex)}`}
              onChange={(provenance) => {
                writePointProvenance(stepId, { segmentIndex, pointKind }, provenance);
              }}
            />
          }
        />
      )}

      {/* The heading the plan gives the robot at the selected end, and what decides it (issue #147). */}
      {selected ? <PointHeadingRow stepId={stepId} segmentIndex={segmentIndex} pointKind={pointKind} /> : null}
    </PointBlock>
  );
}

/**
 * One end or control point of a path. When it is the primary selected point it takes the selected-row
 * style and scrolls into view, nearest, as the point is selected (issue #243). A point already in
 * view does not move the panel.
 */
function PointBlock({
  selected,
  testId,
  className = styles.pose,
  children,
}: {
  selected: boolean;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div ref={ref} className={className} data-selected={selected ? "true" : undefined} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * A curve's control point: a shape handle, not a measured field position, so it carries no
 * provenance chip unless it is the primary selected point (INS-09).
 */
function ControlPointEditor({
  stepId,
  segmentIndex,
  controlIndex,
  pose,
  selected,
}: {
  stepId: string;
  segmentIndex: number;
  controlIndex: number;
  pose: Pose;
  selected: boolean;
}) {
  const write = (patch: { xIn?: number; yIn?: number }): void => {
    writePointNumbers(stepId, { segmentIndex, pointKind: "control", controlIndex }, patch);
  };
  const at = `${String(segmentIndex)}-${String(controlIndex)}`;
  return (
    <PointBlock selected={selected} testId={`inspector-point-control-${at}`} className={styles.pointRow}>
      <PoseRow
        label={`Control ${String(controlIndex + 1)}`}
        testId={`inspector-control-row-${String(controlIndex)}`}
        x={{
          value: pose.xIn,
          testId: `inspector-control-x-${at}`,
          onChange: (xIn) => {
            write({ xIn });
          },
        }}
        y={{
          value: pose.yIn,
          testId: `inspector-control-y-${at}`,
          onChange: (yIn) => {
            write({ yIn });
          },
        }}
        chip={
          selected ? (
            <ProvenancePicker
              short
              provenance={pose.provenance}
              hint={POSE_PROVENANCE_HINT}
              testId={`inspector-control-provenance-${at}`}
              onChange={(provenance) => {
                writePointProvenance(stepId, { segmentIndex, pointKind: "control", controlIndex }, provenance);
              }}
            />
          ) : undefined
        }
      />
    </PointBlock>
  );
}

/** The start's one select: `pose`, or `ref:` and a waypoint's name, as a path end's is. */
type StartChoice = "pose" | `ref:${string}`;

/**
 * The routine's start pose, which every `"current"` chain resolves against, edited as a path end is
 * (INS-07): one Pose select with "This pose" and the Waypoints, and the same crosshair or bookmark
 * at the row's end. "This pose" keeps the pose the start stands at (issue #133); a waypoint makes
 * the start follow it, shown read only and quiet as Position and Heading rows (issue #431).
 */
function StartInspector({ waypointNames }: { waypointNames: string[] }) {
  const { auto, project } = useEditor();
  const bounds = usePoseBounds();
  if (auto === null) return null;
  const start = auto.start.pose;
  const follows = "ref" in start ? start.ref : null;
  const names = follows === null || waypointNames.includes(follows) ? waypointNames : [...waypointNames, follows];
  const followed = follows === null ? undefined : project?.waypoints?.waypoints[follows];
  return (
    <>
      <SourceSelect<StartChoice>
        label="Pose"
        value={follows === null ? "pose" : `ref:${follows}`}
        ends={[{ value: "pose", label: "This pose" }]}
        group={{ label: "Waypoints", options: names.map((name) => ({ value: `ref:${name}` as const, label: name })) }}
        testId="inspector-start-source"
        onChange={(choice) => {
          if (choice === "pose") {
            writeOwnPose("start");
            return;
          }
          const ref = choice.slice("ref:".length);
          if (ref === follows) return;
          tryEdit((current) => ({ ...current, start: { ...current.start, pose: { ref } } }));
        }}
        action={<WaypointEndAction owner="start" follows={follows} />}
      />
      {"ref" in start ? (
        <>
          <FollowedPoseRow name={start.ref} testId="inspector-start-follows-pose" />
          {followed === undefined ? null : (
            <FieldRow label="Heading" quiet hint={`The heading of waypoint ${start.ref}, which the robot sets up at.`}>
              <span className={styles.readout} data-testid="inspector-start-follows-heading">
                {formatHeading(followed.headingRad)}
              </span>
            </FieldRow>
          )}
        </>
      ) : (
        <>
          <PoseRow
            label="Position"
            x={{
              ...bounds.x,
              value: start.xIn,
              testId: "inspector-start-x",
              onChange: (xIn) => {
                writeStartNumbers({ xIn });
              },
            }}
            y={{
              ...bounds.y,
              value: start.yIn,
              testId: "inspector-start-y",
              onChange: (yIn) => {
                writeStartNumbers({ yIn });
              },
            }}
            chip={
              <ProvenancePicker
                short
                provenance={start.provenance}
                hint={POSE_PROVENANCE_HINT}
                testId="inspector-start-provenance"
                onChange={writeStartProvenance}
              />
            }
          />
          <NumberField
            label="Heading"
            unit="°"
            value={start.headingRad === undefined ? null : radToDeg(start.headingRad)}
            step={5}
            digits={1}
            testId="inspector-start-h"
            onChange={(deg) => {
              writeStartNumbers({ headingRad: degToRad(deg) });
            }}
          />
        </>
      )}
    </>
  );
}

/* ---- Helpers ------------------------------------------------------------- */

export { selectStep };
