/**
 * The inspector's Envelope and Rejoin sections (spec 13 section 10). An envelope is the area a
 * step's robot promises to stay inside while the step runs, for at most `maxDurationS`; a rejoin
 * pose is where a path picks the robot up again after a command that drives it by itself. Each is
 * its own section only once the step has one; until then, Advanced offers it as one row (issues
 * #239 and #431), in students' words: Stay inside and Rejoin pose.
 *
 * The editor makes and edits an envelope as an axis-aligned rectangle (issue #120): drawn on the
 * field from one corner to the opposite, resized there by its corner and side handles, or typed
 * here as x, y, width and height. The file still carries it as a four-corner polygon. An envelope
 * that is some other polygon (written by hand or by an agent) is shown as it is, with an offer to
 * turn it into the rectangle round it; editing other shapes is backlog issue #121.
 *
 * Every change goes through `tryEdit` and core's edit primitives, so each one is one undo step and
 * an edit the file would refuse (a window over the period) is turned into a status line instead of
 * being written. Degrees in the rows, radians in the file.
 *
 * The Actual row (issue #481) is the envelope's what-if run time, `actualDurationS`, like a
 * transfer's actual count: what the planner times the step by instead of the whole window, to
 * preview a run that finishes sooner or fails early. It comes with the Ledger switch, as the
 * transfer's does, and shows whatever the switch says when the file sets it. It is offered only on
 * a step its envelope times (one with no estimate of its own); on any other step it is hidden, and
 * a value the file sets anyway shows disabled, saying why, with its reset.
 */
import { Trash } from "lucide-react";
import { degToRad, radToDeg, setEnvelope, setEnvelopeDurations, setRejoinFrom, type Pose } from "@horizon36596/zenith-core";
import type { Envelope, RejoinPose, Step } from "@horizon36596/zenith-schema";
import { tryEdit, writeEnvelopeProvenance, writeRejoinProvenance } from "../app/edits";
import { FieldRow, NumberField, PoseRow, Section } from "../components/fields";
import { usePoseBounds } from "./poseBounds";
import { Button, RowButton, TextButton } from "../components/primitives";
import { KEPT_PROVENANCE_HINT, ProvenancePicker } from "../components/ProvenancePicker";
import {
  DEFAULT_ENVELOPE_SIDE_IN,
  DRAWN_ENVELOPE_PROVENANCE,
  ENVELOPE_MAX_DURATION_S,
  defaultEnvelopeFor,
  defaultEnvelopeSeconds,
  defaultRejoinFor,
  withEnvelopePolygon,
} from "../lib/envelope";
import {
  ENVELOPE_MIN_SIDE_IN,
  isRectangle,
  rectFromBox,
  rectOfPolygon,
  rectPolygon,
  rectSize,
} from "../lib/envelopeRect";
import { useFeature } from "../state/features";
import { startEnvelopeDraw, stopEnvelopeDraw, useUi } from "../state/ui";
import styles from "./Inspector.module.css";

/**
 * A step's envelope, as its own Stay-inside box section above Advanced (issues #239 and #431):
 * shown only while the step has one, or while one is being drawn for it. Adding one is
 * `EnvelopeEntry`, in Advanced.
 */
export function EnvelopeSection({
  stepId,
  envelope,
  timedByEnvelope,
}: {
  stepId: string;
  /** The step's envelope; undefined while one is being drawn on the field. */
  envelope: Envelope | undefined;
  /** True when the planner times the step by its envelope, having no estimate of its own. */
  timedByEnvelope: boolean;
}) {
  return (
    <Section
      title="Stay-inside box"
      help="section.envelope"
      foldId="envelope"
      actions={
        envelope === undefined ? undefined : (
          // The bin is a header action (issue #242): the step keeps everything else.
          <RowButton
            icon={Trash}
            label="Remove the envelope"
            hint="The step keeps everything else. Undo brings the envelope back."
            testId="inspector-envelope-remove"
            onClick={() => {
              tryEdit((current) => setEnvelope(current, stepId, null));
            }}
          />
        )
      }
    >
      {envelope !== undefined ? (
        <EnvelopeRows stepId={stepId} envelope={envelope} timedByEnvelope={timedByEnvelope} />
      ) : (
        <>
          <p className={styles.note} data-testid="inspector-envelope-drawing">
            Drag on the field from one corner of the envelope to the opposite corner. It snaps like a
            point; Shift draws a square. Esc cancels.
          </p>
          <div className={styles.markerAdd}>
            <Button testId="inspector-envelope-draw-cancel" onClick={stopEnvelopeDraw}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

/** Whether the field is drawing a new envelope for this step right now. */
export function useDrawingEnvelope(stepId: string | undefined): boolean {
  const drawing = useUi().envelopeDraw;
  return stepId !== undefined && drawing?.stepId === stepId;
}

/**
 * Advanced's way to add an envelope to a step that has none (issue #431): a Stay inside row whose
 * value is two text buttons, draw the box on the field, or a square round the start.
 */
export function EnvelopeEntry({
  stepId,
  step,
  startPose,
  estimateS,
}: {
  stepId: string;
  step: Extract<Step, { kind: "path" | "command" | "wait" }>;
  /** Where the planner has the step starting, which a new square envelope is centred on. */
  startPose: Pose | null;
  /** The step's own estimate, which a new envelope's window starts from when it has no timeout. */
  estimateS: number | null;
}) {
  return (
    <FieldRow label="Stay inside" describe="inspector.envelope">
      <span className={styles.entryButtons}>
        <TextButton
          label="Draw box"
          hint="Drag on the field from one corner of the box to the opposite one. Partners see it."
          testId="inspector-envelope-draw"
          onClick={() => {
            startEnvelopeDraw({
              stepId,
              maxDurationS: defaultEnvelopeSeconds(step, estimateS),
              provenance: DRAWN_ENVELOPE_PROVENANCE,
            });
          }}
        />
        {/* The square goes round where the step starts, so it is offered once the step is planned. */}
        {startPose === null ? null : (
          <TextButton
            label={`Add ${String(DEFAULT_ENVELOPE_SIDE_IN)} in`}
            hint={`A ${String(DEFAULT_ENVELOPE_SIDE_IN)} in square box round where the step starts, to resize on the field.`}
            testId="inspector-envelope-add"
            onClick={() => {
              const next = defaultEnvelopeFor(step, startPose, estimateS);
              tryEdit((current) => setEnvelope(current, stepId, next));
            }}
          />
        )}
      </span>
    </FieldRow>
  );
}

/** Advanced's way to give a path a rejoin pose, offered after a command that drives the robot itself. */
export function RejoinEntry({
  stepId,
  startPose,
}: {
  stepId: string;
  /** Where the planner has the path starting now, which a new rejoin pose copies. */
  startPose: Pose | null;
}) {
  return (
    <FieldRow label="Rejoin pose" describe="inspector.rejoin">
      <TextButton
        label="Add"
        hint="Starts at where the planner has this path starting now; then change it to where the robot usually ends up."
        disabled={startPose === null}
        whyDisabled="The step has not been planned yet, so there is no pose to start from."
        testId="inspector-rejoin-add"
        onClick={() => {
          if (startPose === null) return;
          const next = defaultRejoinFor(startPose);
          tryEdit((current) => setRejoinFrom(current, stepId, next));
        }}
      />
    </FieldRow>
  );
}

function EnvelopeRows({ stepId, envelope, timedByEnvelope }: { stepId: string; envelope: Envelope; timedByEnvelope: boolean }) {
  const ledgerOn = useFeature("ledger");
  const rectangle = isRectangle(envelope.polygon);
  const rect = rectOfPolygon(envelope.polygon);
  const { widthIn, heightIn } = rectSize(rect);
  /** Writes the rectangle the four numbers describe, from the one that changed. */
  const box = (patch: Partial<{ xIn: number; yIn: number; widthIn: number; heightIn: number }>): void => {
    const next = { xIn: rect.minXIn, yIn: rect.minYIn, widthIn, heightIn, ...patch };
    const polygon = rectPolygon(rectFromBox(next.xIn, next.yIn, next.widthIn, next.heightIn));
    tryEdit((current) => withEnvelopePolygon(current, stepId, polygon));
  };
  return (
    <>
      {/* The envelope's one provenance covers its time, its corner and its size, so it is one chip, here (issue #242). */}
      <NumberField
        label="Lasts at most"
        unit="s"
        value={envelope.maxDurationS}
        step={0.1}
        digits={1}
        min={0.1}
        max={ENVELOPE_MAX_DURATION_S}
        testId="inspector-envelope-seconds"
        hint={`The robot is out of the envelope by then. A step with no estimate of its own takes this time on the timeline. At most ${String(ENVELOPE_MAX_DURATION_S)} s.`}
        chipInline
        chip={
          <ProvenancePicker
            short
            provenance={envelope.provenance}
            hint={KEPT_PROVENANCE_HINT}
            testId="inspector-envelope-provenance"
            onChange={(provenance) => {
              writeEnvelopeProvenance(stepId, provenance);
            }}
          />
        }
        onChange={(maxDurationS) => {
          // A what-if the new window is no longer longer than is dropped (`setEnvelopeDurations`).
          tryEdit((current) => setEnvelopeDurations(current, stepId, { maxDurationS }));
        }}
      />
      <ActualRow stepId={stepId} envelope={envelope} timedByEnvelope={timedByEnvelope} ledgerOn={ledgerOn} />
      {rectangle ? (
        <>
          <PoseRow
            label="Corner"
            x={{
              value: rect.minXIn,
              step: 1,
              testId: "inspector-envelope-x",
              hint: "The left edge, the smallest x. Moving it keeps the size.",
              onChange: (xIn) => {
                box({ xIn });
              },
            }}
            y={{
              value: rect.minYIn,
              step: 1,
              testId: "inspector-envelope-y",
              hint: "The bottom edge, the smallest y. Moving it keeps the size.",
              onChange: (yIn) => {
                box({ yIn });
              },
            }}
          />
          <PoseRow
            label="Size"
            axes={["width", "height"]}
            between="×"
            x={{
              value: widthIn,
              step: 1,
              min: ENVELOPE_MIN_SIDE_IN,
              testId: "inspector-envelope-w",
              hint: "Along x from the left edge. You can also drag a side on the field.",
              onChange: (next) => {
                box({ widthIn: next });
              },
            }}
            y={{
              value: heightIn,
              step: 1,
              min: ENVELOPE_MIN_SIDE_IN,
              testId: "inspector-envelope-h",
              hint: "Along y from the bottom edge. You can also drag a side on the field.",
              onChange: (next) => {
                box({ heightIn: next });
              },
            }}
          />
        </>
      ) : (
        <>
          <p className={styles.note} data-testid="inspector-envelope-polygon-note">
            {`This envelope is a ${String(envelope.polygon.length)}-corner shape, not a rectangle. The file keeps it as it is; the editor resizes rectangles only.`}
          </p>
          <div className={styles.markerAdd}>
            <Button
              testId="inspector-envelope-to-rect"
              onClick={() => {
                tryEdit((current) => withEnvelopePolygon(current, stepId, rectPolygon(rect)));
              }}
            >
              Make it the rectangle round it
            </Button>
          </div>
        </>
      )}
    </>
  );
}
/**
 * The envelope's what-if run time (issue #481): empty means the step runs the whole window. Shown
 * with the Ledger switch on a step its envelope times, and whenever the file sets one, so an
 * override is never hidden; on a step with an estimate of its own, which the what-if does not time,
 * a value the file sets shows disabled, saying why, with its reset.
 */
function ActualRow({
  stepId,
  envelope,
  timedByEnvelope,
  ledgerOn,
}: {
  stepId: string;
  envelope: Envelope;
  timedByEnvelope: boolean;
  ledgerOn: boolean;
}) {
  const set = envelope.actualDurationS !== undefined;
  if (!set && !(ledgerOn && timedByEnvelope)) return null;
  return (
    <NumberField<number | null>
      label="Actual"
      unit="s"
      value={envelope.actualDurationS ?? null}
      step={0.1}
      digits={1}
      min={0.1}
      max={envelope.maxDurationS}
      nullable
      quiet={!set}
      disabled={!timedByEnvelope}
      placeholder={envelope.maxDurationS.toFixed(1)}
      hint={
        timedByEnvelope
          ? "What the planner uses instead, to preview a faster or failed run. Empty means Lasts at most. The robot ignores it."
          : "Not used: this step has an estimate of its own, so the planner times it by that and not by its envelope. Clear it with the bin."
      }
      testId="inspector-envelope-actual"
      action={
        set ? (
          <RowButton
            icon={Trash}
            label="Use Lasts at most"
            hint="Clear the actual time, so the planner times the step by the whole window again."
            testId="inspector-envelope-actual-reset"
            onClick={() => {
              tryEdit((current) => setEnvelopeDurations(current, stepId, { actualDurationS: null }));
            }}
          />
        ) : undefined
      }
      onChange={(value) => {
        tryEdit((current) => setEnvelopeDurations(current, stepId, { actualDurationS: value }));
      }}
    />
  );
}

/** A path's rejoin pose, as its own section above Advanced (issue #239), shown only while it has one. */
export function RejoinSection({ stepId, rejoin }: { stepId: string; rejoin: RejoinPose }) {
  const bounds = usePoseBounds();
  const write = (patch: Partial<RejoinPose>): void => {
    tryEdit((current) => setRejoinFrom(current, stepId, { ...rejoin, ...patch }));
  };
  return (
    <Section
      title="Rejoin"
      help="section.rejoin"
      foldId="rejoin"
      actions={
        <RowButton
          icon={Trash}
          label="Remove the rejoin pose"
          hint="The path then starts wherever the step before it began, as the planner cannot tell where it ended."
          testId="inspector-rejoin-remove"
          onClick={() => {
            tryEdit((current) => setRejoinFrom(current, stepId, null));
          }}
        />
      }
    >
      <PoseRow
        label="Position"
        x={{
          ...bounds.x,
          value: rejoin.xIn,
          testId: "inspector-rejoin-x",
          onChange: (xIn) => {
            write({ xIn });
          },
        }}
        y={{
          ...bounds.y,
          value: rejoin.yIn,
          testId: "inspector-rejoin-y",
          onChange: (yIn) => {
            write({ yIn });
          },
        }}
        chip={
          <ProvenancePicker
            short
            provenance={rejoin.provenance}
            hint={KEPT_PROVENANCE_HINT}
            testId="inspector-rejoin-provenance"
            onChange={(provenance) => {
              writeRejoinProvenance(stepId, provenance);
            }}
          />
        }
      />
      <NumberField
        label="Heading"
        unit="°"
        value={radToDeg(rejoin.headingRad)}
        step={5}
        digits={1}
        testId="inspector-rejoin-h"
        onChange={(deg) => {
          write({ headingRad: degToRad(deg) });
        }}
      />
    </Section>
  );
}
