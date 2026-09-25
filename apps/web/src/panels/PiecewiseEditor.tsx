/**
 * The inspector's editor for a piecewise heading (site/docs/editor.md, "Inspector"):
 * a track of the path from t 0 to 1 with a block per range, then one row per range with its mode
 * and values. Click the track to split the range there, drag a boundary on the track to move it,
 * set a range's end, change its mode, or delete it. Hovering a range lights up its stretch of the
 * path on the canvas.
 *
 * Every change goes through the core range edits (`headingRanges.ts`), which keep the ranges
 * covering 0 to 1 with no gap and no overlap, and then through `writeHeadingMode`, the same path
 * as every other heading edit. A boundary drag on the track is one undo step.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Scissors, Trash } from "lucide-react";
import {
  degToRad,
  deleteRange,
  moveBoundary,
  radToDeg,
  rangeHeadingForMode,
  setRangeHeading,
  splitRange,
} from "@horizon36596/zenith-core";
import type { Heading, HeadingRange, RangeHeading } from "@horizon36596/zenith-schema";
import { writeHeadingMode } from "../app/edits";
import { ChoiceField, NumberField } from "../components/fields";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { setHoveredRange } from "../lib/headingRangeHover";
import { headingModeHint, RANGE_HEADING_MODES } from "../lib/headingModes";
import { beginTransaction, endTransaction } from "../state/store";
import styles from "./PiecewiseEditor.module.css";

type Piecewise = Extract<Heading, { mode: "piecewise" }>;

const RANGE_CHOICES = RANGE_HEADING_MODES.map((info) => ({
  value: info.value as RangeHeading["mode"],
  label: info.label,
  hint: headingModeHint(info),
}));

const SHORT_LABEL: Readonly<Record<RangeHeading["mode"], string>> = {
  tangent: "Tangent",
  tangentReversed: "Reverse",
  constant: "Constant",
  linear: "Linear",
  facePoint: "Facing",
};

const fmtT = (t: number): string => t.toFixed(2);

export function PiecewiseEditor({ stepId, heading }: { stepId: string; heading: Piecewise }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The heading at the start of a boundary drag, so every frame edits from where it began.
  const dragRef = useRef<{ index: number; base: Piecewise; moved: boolean } | null>(null);

  const write = (next: Heading): void => {
    writeHeadingMode(stepId, next);
  };

  const tAt = (clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width <= 0 ? 0 : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const hover = (range: HeadingRange | null): void => {
    setHoveredRange(range === null ? null : { stepId, startT: range.startT, endT: range.endT });
  };

  const onTrackClick = (event: { clientX: number }): void => {
    if (dragRef.current !== null) return;
    const next = splitRange(heading, tAt(event.clientX));
    if (next !== heading) write(next);
  };

  const onBoundaryDown = (index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = { index, base: heading, moved: false };
    beginTransaction();
  };

  const onBoundaryMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    drag.moved = true;
    write(moveBoundary(drag.base, drag.index, tAt(event.clientX)));
  };

  const onBoundaryUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (dragRef.current === null) return;
    dragRef.current = null;
    endTransaction();
  };

  return (
    <div className={styles.editor} data-testid="heading-ranges" onPointerLeave={() => hover(null)}>
      <Tooltip label="Ranges along the path" hint="Click to split a range there. Drag a line between two ranges to move it.">
        <div
          ref={trackRef}
          className={styles.track}
          data-testid="heading-track"
          role="group"
          aria-label="Heading ranges along the path, from start to end"
          onClick={onTrackClick}
        >
          {heading.ranges.map((range, index) => (
            <div
              key={`block-${String(index)}`}
              className={styles.block}
              data-mode={range.heading.mode}
              style={{ left: `${String(range.startT * 100)}%`, width: `${String((range.endT - range.startT) * 100)}%` }}
              onPointerEnter={() => hover(range)}
            >
              <span className={styles.blockLabel}>{SHORT_LABEL[range.heading.mode]}</span>
            </div>
          ))}
          {heading.ranges.slice(0, -1).map((range, index) => (
            <div
              key={`boundary-${String(index)}`}
              className={styles.boundary}
              style={{ left: `${String(range.endT * 100)}%` }}
              data-testid={`heading-track-boundary-${String(index)}`}
              role="separator"
              aria-label={`Boundary between range ${String(index + 1)} and range ${String(index + 2)} at t ${fmtT(range.endT)}`}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={onBoundaryDown(index)}
              onPointerMove={onBoundaryMove}
              onPointerUp={onBoundaryUp}
              onPointerCancel={onBoundaryUp}
            />
          ))}
        </div>
      </Tooltip>
      <div className={styles.scale} aria-hidden>
        <span>0</span>
        <span>t</span>
        <span>1</span>
      </div>

      {heading.ranges.map((range, index) => (
        <RangeRow
          key={`range-${String(index)}`}
          index={index}
          range={range}
          heading={heading}
          last={index === heading.ranges.length - 1}
          onWrite={write}
          onHover={hover}
        />
      ))}
    </div>
  );
}

function RangeRow({
  index,
  range,
  heading,
  last,
  onWrite,
  onHover,
}: {
  index: number;
  range: HeadingRange;
  heading: Piecewise;
  last: boolean;
  onWrite: (next: Heading) => void;
  onHover: (range: HeadingRange | null) => void;
}) {
  const id = `heading-range-${String(index)}`;
  const inner = range.heading;
  const setInner = (next: RangeHeading): void => {
    onWrite(setRangeHeading(heading, index, next));
  };
  const middle = (range.startT + range.endT) / 2;
  const canSplit = splitRange(heading, middle) !== heading;

  return (
    <div
      className={styles.range}
      data-testid={id}
      onPointerEnter={() => onHover(range)}
      onFocus={() => onHover(range)}
    >
      <div className={styles.rangeHead}>
        <span className={styles.rangeTitle}>
          Range {index + 1} · t {fmtT(range.startT)} to {fmtT(range.endT)}
        </span>
        <span className={styles.rangeActions}>
          <RowButton
            icon={Scissors}
            label="Split this range in half"
            disabled={!canSplit}
            whyDisabled="Each half must be at least 2% of the path."
            onClick={() => onWrite(splitRange(heading, middle))}
            testId={`${id}-split`}
          />
          <RowButton
            icon={Trash}
            label="Delete this range"
            hint="The range before it grows to cover its stretch."
            disabled={heading.ranges.length <= 1}
            whyDisabled="A piecewise heading needs one range. Choose another mode instead."
            onClick={() => {
              onHover(null);
              onWrite(deleteRange(heading, index));
            }}
            testId={`${id}-delete`}
          />
        </span>
      </div>
      <ChoiceField
        label="Mode"
        value={inner.mode}
        testId={`${id}-mode`}
        options={RANGE_CHOICES}
        onChange={(mode) => setInner(rangeHeadingForMode(mode, range))}
      />
      {last ? null : (
        <NumberField
          label="Ends at t"
          value={range.endT}
          step={0.01}
          digits={2}
          min={0}
          max={1}
          testId={`${id}-end`}
          onChange={(t) => onWrite(moveBoundary(heading, index, t))}
        />
      )}
      {inner.mode === "constant" ? (
        <NumberField
          label="Heading"
          unit="°"
          value={radToDeg(inner.headingRad)}
          step={5}
          digits={1}
          testId={`${id}-constant`}
          onChange={(deg) => setInner({ mode: "constant", headingRad: degToRad(deg) })}
        />
      ) : null}
      {inner.mode === "linear" ? (
        <>
          <NumberField
            label="From"
            unit="°"
            value={radToDeg(inner.fromRad)}
            step={5}
            digits={1}
            testId={`${id}-from`}
            onChange={(deg) => setInner({ ...inner, fromRad: degToRad(deg) })}
          />
          <NumberField
            label="To"
            unit="°"
            value={radToDeg(inner.toRad)}
            step={5}
            digits={1}
            testId={`${id}-to`}
            onChange={(deg) => setInner({ ...inner, toRad: degToRad(deg) })}
          />
        </>
      ) : null}
      {inner.mode === "facePoint" ? (
        <>
          <NumberField
            label="Point x"
            unit="in"
            value={inner.xIn}
            testId={`${id}-x`}
            onChange={(xIn) => setInner({ ...inner, xIn })}
          />
          <NumberField
            label="Point y"
            unit="in"
            value={inner.yIn}
            testId={`${id}-y`}
            onChange={(yIn) => setInner({ ...inner, yIn })}
          />
        </>
      ) : null}
    </div>
  );
}
