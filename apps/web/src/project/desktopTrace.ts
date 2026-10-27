/**
 * Cleans a high-fidelity sim trace before the desktop app draws it over the plan.
 *
 * A trace's poses are the robot's belief of where it is, one row per tick. When the localizer is
 * re-seeded or overwritten, the belief jumps further in one tick than any drivetrain can move, and a
 * polyline drawn through the rows joins the two places with a straight line the robot never drove.
 * The BIOBUZZ headless harness does this on its first tick today: row 0 is
 * the start pose the auto set, and row 1 is back at the origin, so the overlay drew a line from the
 * start pose to the field centre.
 *
 * Only a jump before the robot has moved is repaired, by dropping the rows before it: those rows are
 * the pose that did not stick, and nothing after them depends on them. A jump later in the run is
 * kept and counted, because dropping half a run would hide the problem rather than show it.
 */
import { parseTrace, type Trace, type TracePoseRow } from "@horizon36596/zenith-core";

/** Faster than any FTC drivetrain: roughly twice a fast robot's top speed. */
const MAX_PLAUSIBLE_SPEED_IN_PER_S = 150;
/** A jump this short is never called a reset, whatever the tick, so a slow tick is not mistaken. */
const MIN_RESET_JUMP_IN = 6;
/** How far the rows before a reset may wander and still count as "had not moved yet". */
const SETTLED_IN = 2;

export interface SettledTrace {
  trace: Trace;
  /** Rows dropped from the start because the pose they held was overwritten on the next tick. */
  droppedLeading: number;
  /** Indices, into the returned poses, of rows that jump from the row before them mid-run. */
  resets: number[];
}

const distanceIn = (a: TracePoseRow, b: TracePoseRow): number => Math.hypot(b[1] - a[1], b[2] - a[2]);

/** True when row `b` is further from row `a` than a robot can travel in the time between them. */
export function isPoseReset(a: TracePoseRow, b: TracePoseRow, tickS: number): boolean {
  const dt = Math.max(b[0] - a[0], tickS, 0);
  return distanceIn(a, b) > Math.max(MIN_RESET_JUMP_IN, MAX_PLAUSIBLE_SPEED_IN_PER_S * dt);
}

export function settleTrace(trace: Trace): SettledTrace {
  const rows = trace.poses;
  const first = rows[0];
  let poses = rows;
  let droppedLeading = 0;
  if (first !== undefined) {
    for (let i = 1; i < rows.length; i += 1) {
      const before = rows[i - 1] as TracePoseRow;
      const row = rows[i] as TracePoseRow;
      if (distanceIn(first, before) > SETTLED_IN) break;
      if (isPoseReset(before, row, trace.tickS)) {
        droppedLeading = i;
        poses = rows.slice(i);
        break;
      }
    }
  }
  const resets: number[] = [];
  for (let i = 1; i < poses.length; i += 1) {
    if (isPoseReset(poses[i - 1] as TracePoseRow, poses[i] as TracePoseRow, trace.tickS)) resets.push(i);
  }
  return { trace: droppedLeading === 0 ? trace : { ...trace, poses }, droppedLeading, resets };
}

/**
 * `settleTrace` for a trace whose poses arrive in batches (a streamed Full sim run): each batch is
 * looked at once, and the result after every batch is exactly what `settleTrace` gives for the rows
 * received so far, so the finished run settles the same streamed or read from its file.
 *
 * While every row so far is still within `SETTLED_IN` of the first and none jumped, the leading
 * repair is undecided: nothing is dropped yet, as `settleTrace` drops nothing for those rows. The
 * first row that moves off, or the first jump, decides it for good.
 */
export class TraceSettler {
  private rows: TracePoseRow[] = [];
  /** Null while undecided; then how many leading rows are dropped. */
  private dropped: number | null = null;
  /** The next row index whose jump from the row before has not been checked for `resets`. */
  private checked = 1;
  private readonly resets: number[] = [];

  constructor(private readonly tickS: number) {}

  push(rows: readonly TracePoseRow[]): void {
    this.rows.push(...rows);
    const all = this.rows;
    const first = all[0];
    if (first === undefined) return;
    if (this.dropped === null) {
      for (let i = Math.max(1, this.checked); i < all.length; i += 1) {
        const before = all[i - 1] as TracePoseRow;
        if (distanceIn(first, before) > SETTLED_IN) {
          this.decide(0);
          break;
        }
        if (isPoseReset(before, all[i] as TracePoseRow, this.tickS)) {
          this.decide(i);
          break;
        }
        // No jump yet and the robot has not moved: the pair is not a reset either way.
        this.checked = i + 1;
      }
    }
    if (this.dropped === null) return;
    for (let i = this.checked; i < all.length; i += 1) {
      if (isPoseReset(all[i - 1] as TracePoseRow, all[i] as TracePoseRow, this.tickS)) this.resets.push(i - this.dropped);
    }
    this.checked = Math.max(this.checked, all.length);
  }

  /** The trace with the rows received so far, settled; `trace` holds everything but the poses. */
  settle(trace: Trace): SettledTrace {
    const droppedLeading = this.dropped ?? 0;
    const poses = droppedLeading === 0 ? this.rows : this.rows.slice(droppedLeading);
    return { trace: { ...trace, poses: [...poses] }, droppedLeading, resets: [...this.resets] };
  }

  private decide(dropped: number): void {
    this.dropped = dropped;
    // Pairs inside the dropped rows are not part of the run; the first pair checked is the one
    // after the first kept row, which is where `settleTrace`'s own resets loop starts.
    this.checked = dropped + 1;
  }
}

/** The arrays a streamed run appends to, in the trace file's order. */
const STREAMED_ARRAYS = ["steps", "poses", "truthPoses", "structureContacts", "ledger", "events"] as const;

/**
 * A Full sim run as it streams in from the desktop app's sim server: the header from `traceStart`,
 * then each `rows` batch appended. Every batch is read with `parseTrace`, so a row of the wrong shape
 * is refused naming its key, as in a trace file. `settled()` is the trace so far, settled.
 */
export class StreamedTrace {
  private readonly header: Trace;
  private readonly settler: TraceSettler;
  private readonly rest: Omit<Trace, "poses" | "formatVersion" | "auto" | "sha" | "simTimeS" | "tickS" | "capabilities"> = {
    steps: [],
    truthPoses: [],
    structureContacts: [],
    ledger: [],
    events: [],
  };

  constructor(header: unknown) {
    const record = typeof header === "object" && header !== null && !Array.isArray(header) ? header : {};
    this.header = parseTrace({ ...record, poses: [] });
    this.settler = new TraceSettler(this.header.tickS);
  }

  append(rows: unknown): void {
    const record = (typeof rows === "object" && rows !== null && !Array.isArray(rows) ? rows : {}) as Record<string, unknown>;
    const batch: Record<string, unknown> = { poses: [] };
    for (const name of STREAMED_ARRAYS) if (record[name] !== undefined) batch[name] = record[name];
    const parsed = parseTrace(batch);
    this.settler.push(parsed.poses);
    this.rest.steps.push(...parsed.steps);
    this.rest.truthPoses.push(...parsed.truthPoses);
    this.rest.structureContacts.push(...parsed.structureContacts);
    this.rest.ledger.push(...parsed.ledger);
    this.rest.events.push(...parsed.events);
  }

  settled(): SettledTrace {
    return this.settler.settle({
      ...this.header,
      poses: [],
      steps: [...this.rest.steps],
      truthPoses: [...this.rest.truthPoses],
      structureContacts: [...this.rest.structureContacts],
      ledger: [...this.rest.ledger],
      events: [...this.rest.events],
    });
  }
}
