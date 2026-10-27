/**
 * The inspector's editor for a piecewise heading (site/docs/editor.md, "Inspector", issue #431):
 * an 18 px track of the path from 0% to 100% with a block per range, then one 24 px row per range on
 * the Inspector's grid, `1  0–18%  Linear  90.0° → 135.9°`, where a range the path decides reads
 * "follows the path". A click on a row unfolds that range's Mode, Ends at and angle rows; its
 * scissors and bin show on hover or focus. Click the track to split the range there, drag a
 * boundary on the track to move it. Hovering a range, or opening it, underlines its block and lights
 * up its stretch of the path on the canvas.
 *
 * Every change goes through the core range edits (`headingRanges.ts`), which keep the ranges
 * covering 0 to 1 with no gap and no overlap, and then through `writeHeadingMode`, the same path
 * as every other heading edit. A boundary drag on the track is one undo step.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { FOLD_OPEN_EVENT, foldOpenListener, foldPending, rangeFoldId } from "../components/foldMemory";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { setHoveredRange } from "../lib/headingRangeHover";
import { headingModeHint, RANGE_HEADING_MODES } from "../lib/headingModes";
import { beginTransaction, endTransaction } from "../state/store";
import { formatHeading } from "./PointHeadingRow";
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

/** A position along the path as a percentage, which is what a student can picture: 0.2 reads 20%. */
const percent = (t: number): string => `${String(Math.round(t * 100))}%`;

const MODE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  RANGE_HEADING_MODES.map((info) => [info.value, info.label]),
);

/**
 * What a range's row says after its mode: its angles, `90.0° → 135.9°` or `30.0°`, where it faces,
 * or, for a range the path decides, "follows the path", so a row with no angles never looks broken.
 */
export function rangeValues(heading: RangeHeading): string {
  switch (heading.mode) {
    case "tangent":
    case "tangentReversed":
      return "follows the path";
    case "constant":
      return formatHeading(heading.headingRad);
    case "linear":
      return `${formatHeading(heading.fromRad)} → ${formatHeading(heading.toRad)}`;
    case "facePoint":
      return `faces ${heading.xIn.toFixed(1)}, ${heading.yIn.toFixed(1)}`;
  }
}

/** A range's span along the path, `0–18%`. */
export const rangeSpan = (range: HeadingRange): string =>
  `${String(Math.round(range.startT * 100))}–${String(Math.round(range.endT * 100))}%`;

/** The ranges among the first `count` whose open `openFoldForNow` asked for before they mounted. */
export function pendingRanges(count: number): ReadonlySet<number> {
  const open = new Set<number>();
  for (let index = 0; index < count; index += 1) if (foldPending(rangeFoldId(index))) open.add(index);
  return open;
}

export function PiecewiseEditor({ stepId, heading }: { stepId: string; heading: Piecewise }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The heading at the start of a boundary drag, so every frame edits from where it began.
  const dragRef = useRef<{ index: number; base: Piecewise; moved: boolean } | null>(null);
  // The ranges whose rows are open, and the one the pointer or the focus is on.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);

  // A new step, or a different number of ranges, folds every range again, except a range a selected
  // end's heading pencil asked to open before these rows were drawn (`focusHeadingField`).
  useEffect(() => {
    setOpen(pendingRanges(heading.ranges.length));
  }, [stepId, heading.ranges.length]);

  const write = (next: Heading): void => {
    writeHeadingMode(stepId, next);
  };

  const tAt = (clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width <= 0 ? 0 : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const hover = (index: number | null): void => {
    setActive(index);
    const range = index === null ? undefined : heading.ranges[index];
    setHoveredRange(range === undefined ? null : { stepId, startT: range.startT, endT: range.endT });
  };

  const toggle = (index: number, next?: boolean): void => {
    setOpen((before) => {
      const after = new Set(before);
      if (next ?? !after.has(index)) after.add(index);
      else after.delete(index);
      return after;
    });
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
    // Not a drag on the field, so not the tour's "drag one of the dots" (issue #145).
    endTransaction({ tourSignal: false });
  };

  return (
    <div className={styles.editor} data-testid="heading-ranges" onPointerLeave={() => hover(null)}>
      <div
        ref={trackRef}
        className={styles.track}
        data-testid="heading-track"
        role="group"
        aria-label="Heading ranges along the path, from start to end"
        onClick={onTrackClick}
      >
        {heading.ranges.map((range, index) => (
          // A block too narrow for its label shows none, so no glyph is clipped; the tooltip names
          // the range and its mode either way (issue #410).
          <Tooltip
            key={`block-${String(index)}`}
            label={`Range ${String(index + 1)}: ${MODE_LABEL[range.heading.mode] ?? range.heading.mode}`}
            hint="Click the track to split a range there. Drag a line between two ranges to move it."
          >
            <div
              className={styles.block}
              data-mode={range.heading.mode}
              data-active={active === index || open.has(index) ? "" : undefined}
              data-testid={`heading-track-block-${String(index)}`}
              style={{ left: `${String(range.startT * 100)}%`, width: `${String((range.endT - range.startT) * 100)}%` }}
              onPointerEnter={() => hover(index)}
            >
              <span className={styles.blockLabel}>{SHORT_LABEL[range.heading.mode]}</span>
            </div>
          </Tooltip>
        ))}
        {heading.ranges.slice(0, -1).map((range, index) => (
          <div
            key={`boundary-${String(index)}`}
            className={styles.boundary}
            style={{ left: `${String(range.endT * 100)}%` }}
            data-testid={`heading-track-boundary-${String(index)}`}
            role="separator"
            aria-label={`Boundary between range ${String(index + 1)} and range ${String(index + 2)} at ${percent(range.endT)} of the path`}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={onBoundaryDown(index)}
            onPointerMove={onBoundaryMove}
            onPointerUp={onBoundaryUp}
            onPointerCancel={onBoundaryUp}
          />
        ))}
      </div>
      <div className={styles.scale} aria-hidden>
        <span>0%</span>
        <span>100%</span>
      </div>

      {heading.ranges.map((range, index) => (
        <RangeRow
          key={`range-${String(index)}`}
          index={index}
          range={range}
          heading={heading}
          last={index === heading.ranges.length - 1}
          open={open.has(index)}
          active={active === index}
          onToggle={(next) => {
            toggle(index, next);
          }}
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
  open,
  active,
  onToggle,
  onWrite,
  onHover,
}: {
  index: number;
  range: HeadingRange;
  heading: Piecewise;
  last: boolean;
  open: boolean;
  active: boolean;
  /** Opens or folds the range's rows; `true` opens them whatever they were. */
  onToggle: (next?: boolean) => void;
  onWrite: (next: Heading) => void;
  onHover: (index: number | null) => void;
}) {
  const id = `heading-range-${String(index)}`;
  const inner = range.heading;
  const setInner = (next: RangeHeading): void => {
    onWrite(setRangeHeading(heading, index, next));
  };
  const middle = (range.startT + range.endT) / 2;
  const canSplit = splitRange(heading, middle) !== heading;

  // A selected end's heading pencil opens the range that decides it, for now (`focusHeadingField`).
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  useEffect(() => {
    const onOpen = foldOpenListener(rangeFoldId(index), () => {
      toggleRef.current(true);
    });
    window.addEventListener(FOLD_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(FOLD_OPEN_EVENT, onOpen);
    };
  }, [index]);

  return (
    <div
      className={styles.range}
      data-testid={id}
      data-open={open ? "" : undefined}
      onPointerEnter={() => onHover(index)}
      onFocus={() => onHover(index)}
    >
      <div className={styles.rangeHead} data-testid={`${id}-head`} data-active={active ? "" : undefined}>
        <button
          type="button"
          className={styles.rangeToggle}
          aria-expanded={open}
          aria-label={`Range ${String(index + 1)}, ${rangeSpan(range)}, ${MODE_LABEL[inner.mode] ?? inner.mode}`}
          data-testid={`${id}-toggle`}
          onClick={() => {
            onToggle();
          }}
        >
          <span className={styles.rangeLabel}>
            <span className={styles.rangeIndex}>{index + 1}</span>
            <span className={styles.rangeSpan}>{rangeSpan(range)}</span>
          </span>
          <span className={styles.rangeMode}>{SHORT_LABEL[inner.mode]}</span>
          <span className={styles.rangeValues} data-testid={`${id}-values`}>
            {rangeValues(inner)}
          </span>
        </button>
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
      {open ? (
        <div className={styles.rangeBody}>
          <ChoiceField
            label="Mode"
            value={inner.mode}
            testId={`${id}-mode`}
            options={RANGE_CHOICES}
            onChange={(mode) => setInner(rangeHeadingForMode(mode, range))}
          />
          {last ? null : (
            <NumberField
              label="Ends at"
              unit="%"
              value={range.endT * 100}
              step={1}
              digits={0}
              min={0}
              max={100}
              hint="How far along the path this range ends, as a percentage of its length."
              testId={`${id}-end`}
              onChange={(percentAlong) => onWrite(moveBoundary(heading, index, percentAlong / 100))}
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
      ) : null}
    </div>
  );
}
