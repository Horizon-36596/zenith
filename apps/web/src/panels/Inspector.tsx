/**
 * The inspector of site/docs/editor.md and UI_GUIDE section 8.3: everything
 * about the selected step, in 28 px label-and-value rows. Degrees here, radians in the file
 * (CLAUDE.md rule 3), converted in this file and nowhere else in the panel.
 */
import { useMemo } from "react";
import { MousePointer2, Plus, Trash } from "lucide-react";
import { degToRad, radToDeg, setCommandArgs, toPiecewise } from "@horizon36596/zenith-core";
import { addMarker, removeMarker, setMarkerAt } from "@horizon36596/zenith-core";
import type {
  CommandSpec,
  Heading,
  Marker,
  PathStep,
  Pose,
  PoseSource,
  Segment,
} from "@horizon36596/zenith-schema";
import { tryEdit, writeHeadingMode, writeSpeed, writeTimeout } from "../app/edits";
import { SHORTCUTS } from "../app/shortcuts";
import { CommandArgsForm, type Args } from "../components/CommandArgsForm";
import {
  ChoiceField,
  NumberField,
  Section,
  SelectField,
  TextAreaField,
  FieldRow,
} from "../components/fields";
import { EmptyState, ProvenanceChip, RowButton } from "../components/primitives";
import {
  EDITOR_PROVENANCE,
  setBranchCondition,
  setCommandName,
  setEndCondition,
  setMarkerCommand,
  setNotes,
  setParallel,
  setPose,
  setSegmentKind,
  setSegmentSource,
  setWait,
} from "@horizon36596/zenith-core";
import { HEADING_MODES, headingModeHint } from "../lib/headingModes";
import { PiecewiseEditor } from "./PiecewiseEditor";
import { findEntry } from "../lib/stepOps";
import { KIND_LABEL } from "../lib/stepKinds";
import { selectStep, useDerived, useEditor } from "../state/store";
import styles from "./Inspector.module.css";

/** Pedro's names for the heading modes, each with its plain meaning as a tooltip (ADR 0006). */
const HEADING_CHOICES = HEADING_MODES.map((info) => ({
  value: info.value,
  label: info.label,
  hint: headingModeHint(info),
}));

const PARALLEL_MODES: Array<{ value: "all" | "race" | "deadline"; label: string }> = [
  { value: "all", label: "Wait for all of them" },
  { value: "race", label: "Stop when the first ends" },
  { value: "deadline", label: "Stop when one step ends" },
];

export function Inspector() {
  const { auto, project, selection, trace } = useEditor();
  const derived = useDerived();

  const entry = useMemo(
    () => (auto === null || selection.stepId === undefined ? undefined : findEntry(auto, selection.stepId)),
    [auto, selection.stepId],
  );

  if (auto === null) return null;
  if (entry === undefined) {
    return (
      <EmptyState
        icon={MousePointer2}
        line="Nothing selected."
        hint="Click a step or a point on the field."
        testId="inspector-empty"
      />
    );
  }

  const step = entry.step;
  const robot = project?.robot;
  const conditions = robot?.conditions ?? [];
  const commands = robot?.commands ?? [];
  const waypointNames = Object.keys(project?.waypoints?.waypoints ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  const perStep = derived.estimate?.byStepId[entry.id];
  const recordedStep = trace?.steps.find((candidate) => candidate.id === entry.id);
  const actualS = recordedStep === undefined ? null : recordedStep.endS - recordedStep.startS;
  const deltaS =
    actualS === null || perStep?.nominalS === null || perStep === undefined
      ? null
      : actualS - perStep.nominalS;

  return (
    <div className={styles.inspector} data-testid="inspector">
      <Section title={`${KIND_LABEL[step.kind]} · ${entry.id}`} help="section.step">
        <FieldRow label="Estimated">
          <span className={styles.readout} data-testid="inspector-estimate">
            {perStep?.nominalS === null || perStep === undefined
              ? "—"
              : perStep.nominalS.toFixed(2)}
            <span className="unit">s</span>
          </span>
        </FieldRow>
        {trace === null ? null : (
          <FieldRow label="Full sim">
            <span className={styles.readout} data-testid="inspector-actual">
              {actualS === null ? "—" : actualS.toFixed(2)}
              <span className="unit">s</span>
            </span>
          </FieldRow>
        )}
        {deltaS === null ? null : (
          <FieldRow label="Delta">
            <span className={styles.readout} data-testid="inspector-delta">
              {deltaS >= 0 ? "+" : ""}
              {deltaS.toFixed(2)}
              <span className="unit">s</span>
            </span>
          </FieldRow>
        )}
        {perStep?.strafeFraction === null || perStep === undefined ? null : (
          <FieldRow label="Strafe fraction">
            <span className={styles.readout}>{perStep.strafeFraction.toFixed(2)}</span>
          </FieldRow>
        )}
        {step.kind === "path" || step.kind === "command" || step.kind === "wait" ? (
          <NumberField<number | null>
            label="Timeout"
            unit="s"
            value={step.timeoutS ?? null}
            step={0.1}
            min={0.01}
            nullable
            hint="Empty means no timeout. Drag across the field to scrub. Shift for four times, Alt for a quarter."
            testId="inspector-timeout"
            onChange={(value) => {
              writeTimeout(entry.id, value);
            }}
          />
        ) : null}
        <TextAreaField
          label="Notes"
          value={"notes" in step ? (step.notes ?? "") : ""}
          onChange={(value) => {
            tryEdit((current) => setNotes(current, entry.id, value));
          }}
        />
      </Section>

      {step.kind === "path" ? (
        <PathInspector
          stepId={entry.id}
          step={step}
          waypointNames={waypointNames}
          commands={commands}
          conditions={conditions.map((condition) => condition.name)}
        />
      ) : null}

      {step.kind === "command" ? (
        <Section title="Command" help="section.command">
          <SelectField
            label="Name"
            value={step.name}
            testId="inspector-command-name"
            options={commands.map((spec) => ({ value: spec.name, label: spec.name }))}
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
        <Section title="Wait" help="section.wait">
          <NumberField
            label="Seconds"
            unit="s"
            value={step.seconds ?? null}
            step={0.1}
            min={0}
            testId="inspector-wait-seconds"
            onChange={(value) => {
              tryEdit((current) => setWait(current, entry.id, { seconds: value }));
            }}
          />
          <SelectField
            label="Until"
            value={step.until ?? ""}
            options={[
              { value: "", label: "—" },
              ...conditions.map((condition) => ({
                value: condition.name,
                label: condition.name,
              })),
            ]}
            onChange={(value) => {
              tryEdit((current) =>
                setWait(current, entry.id, value === "" ? { seconds: step.seconds ?? 0 } : { until: value }),
              );
            }}
          />
        </Section>
      ) : null}

      {step.kind === "sequence" ? (
        <Section title="Sequence" help="section.sequence">
          <FieldRow label="Steps">
            <span className={styles.readout} data-testid="inspector-sequence-count">
              {step.steps.length}
            </span>
          </FieldRow>
          <p className={styles.note}>
            Runs its steps one after another, as one block. Drag steps onto it in the list to add
            them, or right-click it and choose Unwrap to take them out again.
          </p>
        </Section>
      ) : null}

      {step.kind === "parallel" ? (
        <Section title="Parallel group" help="section.parallel">
          <SelectField
            label="Mode"
            value={step.mode}
            options={PARALLEL_MODES}
            onChange={(mode) => {
              tryEdit((current) => setParallel(current, entry.id, { mode }));
            }}
          />
          {step.mode === "deadline" ? (
            <SelectField
              label="Deadline"
              value={step.deadline ?? ""}
              options={[
                { value: "", label: "—" },
                ...step.steps.map((child, index) => {
                  const id = child.id ?? `${entry.id}.${String(index + 1)}`;
                  return { value: id, label: id };
                }),
              ]}
              onChange={(deadline) => {
                tryEdit((current) => setParallel(current, entry.id, { deadline }));
              }}
            />
          ) : null}
        </Section>
      ) : null}

      {step.kind === "branch" ? (
        <Section title="Branch" help="section.branch">
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
        </Section>
      ) : null}

      <Section title="Start of the routine" defaultOpen={false} help="section.start">
        <StartInspector waypointNames={waypointNames} />
      </Section>
    </div>
  );
}

/* ---- Path ---------------------------------------------------------------- */

function PathInspector({
  stepId,
  step,
  waypointNames,
  commands,
  conditions,
}: {
  stepId: string;
  step: PathStep;
  waypointNames: string[];
  commands: CommandSpec[];
  conditions: string[];
}) {
  return (
    <>
      {step.segments.map((segment, index) => (
        <Section
          key={`${stepId}-segment-${String(index)}`}
          title={`Segment ${String(index + 1)}`}
          help={index === 0 ? "section.segment" : undefined}
        >
          <SelectField
            label="Kind"
            value={segment.kind}
            testId={`inspector-segment-kind-${String(index)}`}
            options={[
              { value: "line", label: "Straight line" },
              { value: "bezier", label: "Curve" },
            ]}
            onChange={(kind) => {
              tryEdit((current) =>
                setSegmentKind(current, stepId, index, kind, midpointOf(segment)),
              );
            }}
          />
          <PoseSourceEditor
            stepId={stepId}
            segmentIndex={index}
            pointKind="from"
            source={segment.from}
            waypointNames={waypointNames}
          />
          <PoseSourceEditor
            stepId={stepId}
            segmentIndex={index}
            pointKind="to"
            source={segment.to}
            waypointNames={waypointNames}
          />
          {segment.kind === "bezier"
            ? segment.control.map((control, controlIndex) => (
                <ControlPointEditor
                  key={`control-${String(controlIndex)}`}
                  stepId={stepId}
                  segmentIndex={index}
                  controlIndex={controlIndex}
                  pose={control}
                />
              ))
            : null}
        </Section>
      ))}

      <Section title="Heading" help="section.heading">
        <ChoiceField
          label="Mode"
          value={step.heading?.mode ?? "tangent"}
          testId="inspector-heading-mode"
          options={HEADING_CHOICES}
          onChange={(mode) => {
            writeHeadingMode(stepId, headingForMode(mode, step));
          }}
        />
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
      </Section>

      <Section title="Speed and end" help="section.speed">
        <NumberField
          label="Speed fraction"
          value={step.speedFraction ?? null}
          step={0.05}
          min={0.01}
          max={1}
          testId="inspector-speed"
          hint="A fraction of the robot's own velocity cap, not a power."
          onChange={(value) => {
            writeSpeed(stepId, value);
          }}
        />
        <SelectField
          label="End condition"
          value={step.endCondition?.condition ?? ""}
          options={[
            { value: "", label: "—" },
            ...conditions.map((condition) => ({ value: condition, label: condition })),
          ]}
          onChange={(value) => {
            tryEdit((current) => setEndCondition(current, stepId, value === "" ? null : value));
          }}
        />
      </Section>

      <MarkersSection stepId={stepId} markers={step.markers ?? []} commands={commands} />
    </>
  );
}

function MarkersSection({
  stepId,
  markers,
  commands,
}: {
  stepId: string;
  markers: readonly Marker[];
  commands: CommandSpec[];
}) {
  const first = commands[0];
  return (
    <Section title={`Markers (${String(markers.length)})`} help="section.markers">
      {markers.map((marker, index) => {
        const at = marker.at;
        const spec = commands.find((candidate) => candidate.name === marker.command.name);
        return (
          <div key={`marker-${String(index)}`} className={styles.marker}>
            <div className={styles.markerHead}>
              <span className={styles.markerTitle}>{marker.command.name}</span>
              <RowButton
                icon={Trash}
                label="Remove this marker"
                onClick={() => {
                  tryEdit((current) => removeMarker(current, stepId, index));
                }}
              />
            </div>
            <SelectField
              label="Placed by"
              value={"t" in at ? "t" : "distanceIn" in at ? "distanceIn" : "distanceFromEndIn"}
              options={[
                { value: "t", label: "path parameter" },
                { value: "distanceIn", label: "distance from the start" },
                { value: "distanceFromEndIn", label: "distance from the end" },
              ]}
              onChange={(kind) => {
                const value = "t" in at ? at.t : "distanceIn" in at ? at.distanceIn : at.distanceFromEndIn;
                tryEdit((current) =>
                  setMarkerAt(
                    current,
                    stepId,
                    index,
                    kind === "t"
                      ? { t: Math.min(1, Math.max(0, value)) }
                      : kind === "distanceIn"
                        ? { distanceIn: Math.abs(value) }
                        : { distanceFromEndIn: Math.abs(value) },
                  ),
                );
              }}
            />
            <NumberField
              label={"t" in at ? "At t" : "At"}
              unit={"t" in at ? undefined : "in"}
              value={"t" in at ? at.t : "distanceIn" in at ? at.distanceIn : at.distanceFromEndIn}
              step={"t" in at ? 0.05 : 1}
              min={0}
              max={"t" in at ? 1 : undefined}
              testId={`inspector-marker-at-${String(index)}`}
              hint="Alt + left and right slide a marker along its path."
              onChange={(value) => {
                tryEdit((current) =>
                  setMarkerAt(
                    current,
                    stepId,
                    index,
                    "t" in at
                      ? { t: value }
                      : "distanceIn" in at
                        ? { distanceIn: value }
                        : { distanceFromEndIn: value },
                  ),
                );
              }}
            />
            <SelectField
              label="Command"
              value={marker.command.name}
              options={commands.map((candidate) => ({
                value: candidate.name,
                label: candidate.name,
              }))}
              onChange={(name) => {
                tryEdit((current) => setMarkerCommand(current, stepId, index, { name }));
              }}
            />
            <CommandArgsForm
              spec={spec}
              args={(marker.command.args ?? {}) as Args}
              idPrefix={`inspector-marker-${String(index)}`}
              onChange={(args) => {
                tryEdit((current) =>
                  setMarkerCommand(current, stepId, index, { name: marker.command.name, args }),
                );
              }}
            />
          </div>
        );
      })}
      <div className={styles.markerAdd}>
        <RowButton
          icon={Plus}
          label="Add a marker at the middle of this path"
          shortcut={SHORTCUTS.marker}
          disabled={first === undefined}
          onClick={() => {
            if (first === undefined) return;
            tryEdit((current) =>
              addMarker(current, stepId, { at: { t: 0.5 }, command: { name: first.name } }),
            );
          }}
        />
      </div>
    </Section>
  );
}

/* ---- Poses --------------------------------------------------------------- */

function PoseSourceEditor({
  stepId,
  segmentIndex,
  pointKind,
  source,
  waypointNames,
}: {
  stepId: string;
  segmentIndex: number;
  pointKind: "from" | "to";
  source: PoseSource;
  waypointNames: string[];
}) {
  const kind = source === "current" ? "current" : "ref" in source ? "ref" : "pose";
  const pose = kind === "pose" ? (source as Pose) : null;

  const write = (patch: Partial<Pose>): void => {
    if (pose === null) return;
    tryEdit((current) =>
      setPose(
        current,
        stepId,
        { segmentIndex, pointKind },
        {
          xIn: patch.xIn ?? pose.xIn,
          yIn: patch.yIn ?? pose.yIn,
          headingRad: patch.headingRad ?? pose.headingRad,
          provenance: patch.provenance ?? pose.provenance ?? EDITOR_PROVENANCE,
        },
      ),
    );
  };

  return (
    <div className={styles.pose}>
      <SelectField
        label={pointKind === "from" ? "From" : "To"}
        value={kind}
        testId={`inspector-${pointKind}-kind-${String(segmentIndex)}`}
        options={[
          { value: "pose", label: "this pose" },
          { value: "ref", label: "a waypoint" },
          ...(pointKind === "from"
            ? [{ value: "current" as const, label: "last step's end" }]
            : []),
        ]}
        onChange={(next) => {
          if (next === kind) return;
          if (next === "current") {
            tryEdit((current) => setSegmentSource(current, stepId, segmentIndex, pointKind, "current"));
          } else if (next === "ref") {
            const first = waypointNames[0];
            if (first === undefined) return;
            tryEdit((current) =>
              setSegmentSource(current, stepId, segmentIndex, pointKind, { ref: first }),
            );
          } else {
            tryEdit((current) =>
              setSegmentSource(current, stepId, segmentIndex, pointKind, {
                xIn: 0,
                yIn: 0,
                headingRad: 0,
                provenance: EDITOR_PROVENANCE,
              }),
            );
          }
        }}
      />

      {kind === "ref" && source !== "current" && "ref" in source ? (
        <SelectField
          label="Waypoint"
          value={source.ref}
          testId={`inspector-${pointKind}-ref-${String(segmentIndex)}`}
          options={waypointNames.map((name) => ({ value: name, label: name }))}
          onChange={(ref) => {
            tryEdit((current) => setSegmentSource(current, stepId, segmentIndex, pointKind, { ref }));
          }}
        />
      ) : null}

      {pose === null ? null : (
        <>
          <NumberField
            label="x"
            unit="in"
            value={pose.xIn}
            digits={2}
            testId={`inspector-${pointKind}-x-${String(segmentIndex)}`}
            chip={<ProvenanceChip provenance={pose.provenance} />}
            onChange={(xIn) => {
              write({ xIn });
            }}
          />
          <NumberField
            label="y"
            unit="in"
            value={pose.yIn}
            digits={2}
            testId={`inspector-${pointKind}-y-${String(segmentIndex)}`}
            onChange={(yIn) => {
              write({ yIn });
            }}
          />
          <NumberField
            label="Heading"
            unit="°"
            value={pose.headingRad === undefined ? null : radToDeg(pose.headingRad)}
            step={5}
            digits={1}
            testId={`inspector-${pointKind}-h-${String(segmentIndex)}`}
            hint="R and Shift R turn the selected point by 5 degrees."
            onChange={(deg) => {
              write({ headingRad: degToRad(deg) });
            }}
          />
        </>
      )}
    </div>
  );
}

function ControlPointEditor({
  stepId,
  segmentIndex,
  controlIndex,
  pose,
}: {
  stepId: string;
  segmentIndex: number;
  controlIndex: number;
  pose: Pose;
}) {
  const write = (patch: Partial<Pose>): void => {
    tryEdit((current) =>
      setPose(
        current,
        stepId,
        { segmentIndex, pointKind: "control", controlIndex },
        {
          xIn: patch.xIn ?? pose.xIn,
          yIn: patch.yIn ?? pose.yIn,
          provenance: pose.provenance ?? EDITOR_PROVENANCE,
        },
      ),
    );
  };
  return (
    <>
      <NumberField
        label={`Control ${String(controlIndex + 1)} x`}
        unit="in"
        value={pose.xIn}
        chip={<ProvenanceChip provenance={pose.provenance} />}
        onChange={(xIn) => {
          write({ xIn });
        }}
      />
      <NumberField
        label={`Control ${String(controlIndex + 1)} y`}
        unit="in"
        value={pose.yIn}
        onChange={(yIn) => {
          write({ yIn });
        }}
      />
    </>
  );
}

/** The routine's start pose, which every `"current"` chain resolves against. */
function StartInspector({ waypointNames }: { waypointNames: string[] }) {
  const { auto } = useEditor();
  if (auto === null) return null;
  const start = auto.start.pose;
  const isRef = "ref" in start;
  return (
    <>
      <SelectField
        label="Start"
        value={isRef ? "ref" : "pose"}
        options={[
          { value: "pose", label: "this pose" },
          { value: "ref", label: "a waypoint" },
        ]}
        onChange={(kind) => {
          const first = waypointNames[0];
          tryEdit((current) => ({
            ...current,
            start: {
              ...current.start,
              pose:
                kind === "ref" && first !== undefined
                  ? { ref: first }
                  : { xIn: 0, yIn: 0, headingRad: 0, provenance: EDITOR_PROVENANCE },
            },
          }));
        }}
      />
      {isRef ? (
        <SelectField
          label="Waypoint"
          value={start.ref}
          testId="inspector-start-ref"
          options={waypointNames.map((name) => ({ value: name, label: name }))}
          onChange={(ref) => {
            tryEdit((current) => ({ ...current, start: { ...current.start, pose: { ref } } }));
          }}
        />
      ) : (
        <>
          <NumberField
            label="x"
            unit="in"
            value={start.xIn}
            chip={<ProvenanceChip provenance={start.provenance} />}
            onChange={(xIn) => {
              tryEdit((current) => ({
                ...current,
                start: { ...current.start, pose: { ...start, xIn } },
              }));
            }}
          />
          <NumberField
            label="y"
            unit="in"
            value={start.yIn}
            onChange={(yIn) => {
              tryEdit((current) => ({
                ...current,
                start: { ...current.start, pose: { ...start, yIn } },
              }));
            }}
          />
          <NumberField
            label="Heading"
            unit="°"
            value={start.headingRad === undefined ? null : radToDeg(start.headingRad)}
            step={5}
            digits={1}
            onChange={(deg) => {
              tryEdit((current) => ({
                ...current,
                start: { ...current.start, pose: { ...start, headingRad: degToRad(deg) } },
              }));
            }}
          />
        </>
      )}
    </>
  );
}

/* ---- Helpers ------------------------------------------------------------- */

/** A heading of the chosen mode, keeping the step's current angle where the new mode has one. */
function headingForMode(mode: Heading["mode"], step: PathStep): Heading {
  const existing = step.heading;
  const current =
    existing?.mode === "constant"
      ? existing.headingRad
      : existing?.mode === "linear"
        ? existing.toRad
        : 0;
  switch (mode) {
    case "constant":
      return { mode: "constant", headingRad: current };
    case "linear":
      return { mode: "linear", fromRad: current, toRad: current };
    case "facePoint":
      return { mode: "facePoint", xIn: 0, yIn: 0 };
    case "piecewise":
      // One range over the whole path, holding what the step did before, ready to split.
      return toPiecewise(existing);
    default:
      return { mode };
  }
}

/** Where a new control point goes when a line becomes a Bezier: halfway between its endpoints. */
function midpointOf(segment: Segment): { xIn: number; yIn: number } {
  const ends = [segment.from, segment.to]
    .map((source) => (source === "current" || "ref" in source ? null : source))
    .filter((pose): pose is Pose => pose !== null);
  if (ends.length < 2) return { xIn: 0, yIn: 0 };
  const [a, b] = ends as [Pose, Pose];
  return { xIn: (a.xIn + b.xIn) / 2, yIn: (a.yIn + b.yIn) / 2 };
}

export { selectStep };
