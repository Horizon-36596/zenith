/**
 * The trace file the robot repository's headless sim writes
 * (site/docs/simulation.md), and what can be read off it without knowing
 * anything about a season.
 *
 * It is not one of the five file kinds `@horizon36596/zenith-schema` owns, so the parsing is here and it is
 * deliberately forgiving in one direction only: a key the sim build does not fill yet is absent
 * rather than wrong, and every absent key reads as empty. A key that is present but the wrong
 * shape throws, naming the key, because a trace that is silently half-read would show up as a
 * confident wrong number in the overlay.
 *
 * Pure, like the rest of core: nothing here runs a sim or reads a file.
 */

/** One step as the sim ran it, from the `Auto/step` log key. */
export interface TraceStep {
  id: string;
  startS: number;
  endS: number;
  interrupted: boolean;
}

/**
 * `[timeS, xIn, yIn, headingRad]`, where the robot believed it was. A sim that runs an auto as the
 * auto's own alliance records them in the frame the file's poses are written in, which is how the
 * editor overlays them and how `zenith sim` measures cross-track error against the plan.
 */
export type TracePoseRow = readonly [number, number, number, number];

export interface TraceContact {
  timeS: number;
  obstacle: string;
  penetrationIn: number;
}

export interface TraceLedgerRow {
  timeS: number;
  held?: number;
  launches?: number;
  tips?: Record<string, number>;
}

export interface TraceEvent {
  timeS: number;
  kind: string;
  alliance?: string;
}

/** A whole recorded run. */
export interface Trace {
  formatVersion: number;
  /** The auto's `name`, as the sim was asked for it. */
  auto: string;
  /** The commit the sim ran, when the writer knows it. */
  sha: string | null;
  simTimeS: number;
  tickS: number;
  /**
   * What this sim build actually measures, from the writer's own list. A report reads it to say
   * which of its sections are inert rather than empty (`07` section 5).
   */
  capabilities: string[];
  steps: TraceStep[];
  /** The robot's belief of where it was. */
  poses: TracePoseRow[];
  /** Where it really was, when the harness can tell them apart; empty when it cannot. */
  truthPoses: TracePoseRow[];
  structureContacts: TraceContact[];
  ledger: TraceLedgerRow[];
  events: TraceEvent[];
}

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberAt = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TraceError(`${key} is not a finite number.`);
  }
  return value;
};

function poseRow(row: unknown, key: string, at: number): TracePoseRow {
  if (!Array.isArray(row) || row.length < 4) {
    throw new TraceError(`${key}[${String(at)}] is not a [timeS, xIn, yIn, headingRad] row.`);
  }
  const numbers = row.slice(0, 4).map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TraceError(`${key}[${String(at)}] holds a value that is not a finite number.`);
    }
    return value;
  });
  return [
    numbers[0] as number,
    numbers[1] as number,
    numbers[2] as number,
    numbers[3] as number,
  ] as const;
}

function poseRows(value: unknown, key: string): TracePoseRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TraceError(`${key} is not an array.`);
  return value.map((row, at) => poseRow(row, key, at));
}

function steps(value: unknown): TraceStep[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TraceError("steps is not an array.");
  return value.map((entry, at) => {
    if (!isRecord(entry)) throw new TraceError(`steps[${String(at)}] is not an object.`);
    const { id, startS, endS } = entry;
    if (typeof id !== "string" || typeof startS !== "number" || typeof endS !== "number") {
      throw new TraceError(`steps[${String(at)}] needs id, startS and endS.`);
    }
    return { id, startS, endS, interrupted: entry["interrupted"] === true };
  });
}

function contacts(value: unknown): TraceContact[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TraceError("structureContacts is not an array.");
  return value.map((entry, at) => {
    if (!isRecord(entry)) throw new TraceError(`structureContacts[${String(at)}] is not an object.`);
    const obstacle = entry["obstacle"];
    if (typeof obstacle !== "string") {
      throw new TraceError(`structureContacts[${String(at)}] needs an obstacle name.`);
    }
    return {
      timeS: numberAt(entry, "timeS", 0),
      obstacle,
      penetrationIn: numberAt(entry, "penetrationIn", 0),
    };
  });
}

function ledgerRows(value: unknown): TraceLedgerRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TraceError("ledger is not an array.");
  return value.map((entry, at) => {
    if (!isRecord(entry)) throw new TraceError(`ledger[${String(at)}] is not an object.`);
    const tips = entry["tips"];
    const row: TraceLedgerRow = { timeS: numberAt(entry, "timeS", 0) };
    if (entry["held"] !== undefined) row.held = numberAt(entry, "held", 0);
    if (entry["launches"] !== undefined) row.launches = numberAt(entry, "launches", 0);
    if (isRecord(tips)) {
      const counts: Record<string, number> = {};
      for (const [alliance, count] of Object.entries(tips)) {
        if (typeof count === "number") counts[alliance] = count;
      }
      row.tips = counts;
    }
    return row;
  });
}

function events(value: unknown): TraceEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TraceError("events is not an array.");
  return value.map((entry, at) => {
    if (!isRecord(entry)) throw new TraceError(`events[${String(at)}] is not an object.`);
    const kind = entry["kind"];
    if (typeof kind !== "string") throw new TraceError(`events[${String(at)}] needs a kind.`);
    const alliance = entry["alliance"];
    return {
      timeS: numberAt(entry, "timeS", 0),
      kind,
      ...(typeof alliance === "string" ? { alliance } : {}),
    };
  });
}

/** Parses a trace, naming the first key that is wrong rather than failing silently. */
export function parseTrace(json: unknown): Trace {
  if (!isRecord(json)) throw new TraceError("A trace file must be a JSON object.");
  if (json["poses"] === undefined) throw new TraceError("A trace file needs a poses array.");
  const sha = json["sha"];
  const capabilities = json["capabilities"];
  return {
    formatVersion: numberAt(json, "formatVersion", 1),
    auto: typeof json["auto"] === "string" ? json["auto"] : "",
    sha: typeof sha === "string" ? sha : null,
    simTimeS: numberAt(json, "simTimeS", 0),
    tickS: numberAt(json, "tickS", 0.02),
    capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
    steps: steps(json["steps"]),
    poses: poseRows(json["poses"], "poses"),
    truthPoses: poseRows(json["truthPoses"], "truthPoses"),
    structureContacts: contacts(json["structureContacts"]),
    ledger: ledgerRows(json["ledger"]),
    events: events(json["events"]),
  };
}

/** The last recorded time, which is how far a playback scrubber can run on recorded time. */
export function traceDurationS(trace: Trace): number {
  const lastPose = trace.poses[trace.poses.length - 1];
  const lastStep = trace.steps[trace.steps.length - 1];
  return Math.max(lastPose?.[0] ?? 0, lastStep?.endS ?? 0);
}

/** How long each step actually took, by step id. */
export function traceStepDurations(trace: Trace): Map<string, number> {
  const durations = new Map<string, number>();
  for (const step of trace.steps) durations.set(step.id, step.endS - step.startS);
  return durations;
}

/** What the whole run came to: the numbers the Simulate dialog shows (`07` section 3). */
export interface TraceSummary {
  /** Recorded wall time from the first step's start to the last step's end. */
  totalS: number;
  structureContacts: number;
  launches: number;
  /** Tips achieved, by alliance, as the last ledger row that mentions each one reports them. */
  tips: Record<string, number>;
  /** What the robot was holding at the end, or null when this sim build does not track it. */
  heldAtEnd: number | null;
  /** Of the things a report wants to say, the ones this sim build does not measure. */
  inert: string[];
}

const MEASURABLE = ["structureContacts", "ledger"];

export function traceSummary(trace: Trace): TraceSummary {
  const tips: Record<string, number> = {};
  for (const row of trace.ledger) {
    for (const [alliance, count] of Object.entries(row.tips ?? {})) tips[alliance] = count;
  }
  const last = trace.ledger[trace.ledger.length - 1];
  return {
    totalS: traceDurationS(trace),
    structureContacts: trace.structureContacts.length,
    launches: trace.ledger.reduce((sum, row) => sum + (row.launches ?? 0), 0),
    tips,
    heldAtEnd: last?.held ?? null,
    inert:
      trace.capabilities.length === 0
        ? []
        : MEASURABLE.filter((capability) => !trace.capabilities.includes(capability)),
  };
}
