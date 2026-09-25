import { distance, flattenSteps, type Estimate, type Plan } from "@horizon36596/zenith-core";

/**
 * The trace file `AutoTraceWriter` writes (site/docs/simulation.md). There
 * is no zod schema for it in `@horizon36596/zenith-schema` - it is not one of the five file kinds the schema
 * package owns - so this module does its own light validation, matching the writer's actual output
 * (`robot/auto-runtime/AutoTraceWriter.java`) rather than the full spec shape, which the writer does
 * not populate yet (`structureContacts`, `ledger` and `events` are empty until later sim batches).
 */
export interface TraceStep {
  id: string;
  startS: number;
  endS: number;
  interrupted: boolean;
}

/** `[timeS, xIn, yIn, headingRad]`. */
export type TracePoseRow = readonly [number, number, number, number];

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

export interface TraceFile {
  formatVersion: number;
  auto: string;
  simTimeS: number;
  tickS: number;
  capabilities: string[];
  steps: TraceStep[];
  poses: TracePoseRow[];
  truthPoses: TracePoseRow[];
  structureContacts: { timeS: number; obstacle: string; penetrationIn: number }[];
  ledger: TraceLedgerRow[];
  events: TraceEvent[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TraceParseError extends Error {}

/** Parses and shape-checks a trace file, without assuming fields later sim batches have not filled. */
export function parseTrace(json: unknown): TraceFile {
  if (!isObject(json)) throw new TraceParseError("the trace file is not a JSON object");
  const auto = json.auto;
  const steps = json.steps;
  const poses = json.poses;
  if (typeof auto !== "string" || !Array.isArray(steps) || !Array.isArray(poses)) {
    throw new TraceParseError('the trace file is missing "auto", "steps" or "poses"');
  }
  return {
    formatVersion: typeof json.formatVersion === "number" ? json.formatVersion : 1,
    auto,
    simTimeS: typeof json.simTimeS === "number" ? json.simTimeS : 0,
    tickS: typeof json.tickS === "number" ? json.tickS : 0.02,
    capabilities: Array.isArray(json.capabilities) ? json.capabilities.map(String) : [],
    steps: steps as TraceStep[],
    poses: poses as TracePoseRow[],
    truthPoses: Array.isArray(json.truthPoses) ? (json.truthPoses as TracePoseRow[]) : [],
    structureContacts: Array.isArray(json.structureContacts)
      ? (json.structureContacts as TraceFile["structureContacts"])
      : [],
    ledger: Array.isArray(json.ledger) ? (json.ledger as TraceLedgerRow[]) : [],
    events: Array.isArray(json.events) ? (json.events as TraceEvent[]) : [],
  };
}

export interface StepReport {
  id: string;
  estimateNominalS: number | null;
  actualS: number;
  deltaS: number | null;
  interrupted: boolean;
  /** Largest distance from a recorded pose to the nearest planned sample, inches. `null` for a
   * non-path step or a trace with no poses in the step's time window. */
  maxCrossTrackIn: number | null;
}

export interface SimReport {
  auto: string;
  simTimeS: number;
  steps: StepReport[];
  totalEstimateS: number | null;
  totalActualS: number;
  structureContacts: number;
  launches: number;
  tips: Record<string, number>;
  heldAtEnd: number | null;
  capabilities: string[];
  /** Report sections the sim build does not measure yet, read from the trace's own capability list. */
  inert: string[];
}

const KNOWN_CAPABILITIES = ["structureContacts", "ledger"];

/** Builds the estimate-vs-actual report `zenith sim` prints, from a trace and the auto's plan. */
export function buildSimReport(trace: TraceFile, plan: Plan, estimateResult: Estimate | null): SimReport {
  const planSteps = flattenSteps(plan.steps);
  const estimateById = new Map((estimateResult?.steps ?? []).map((step) => [step.stepId, step]));

  const steps: StepReport[] = trace.steps.map((traceStep) => {
    const actualS = traceStep.endS - traceStep.startS;
    const stepEstimate = estimateById.get(traceStep.id) ?? null;
    const nominalS = stepEstimate?.nominalS ?? null;
    const planStep = planSteps.find((candidate) => candidate.id === traceStep.id);
    let maxCrossTrackIn: number | null = null;
    if (planStep !== undefined && planStep.samples.length > 0) {
      const posesInWindow = trace.poses.filter((row) => row[0] >= traceStep.startS && row[0] <= traceStep.endS);
      if (posesInWindow.length > 0) {
        maxCrossTrackIn = 0;
        for (const row of posesInWindow) {
          const point = { xIn: row[1], yIn: row[2] };
          let nearest = Number.POSITIVE_INFINITY;
          for (const sample of planStep.samples) {
            const d = distance(point, sample.pose);
            if (d < nearest) nearest = d;
          }
          if (nearest > maxCrossTrackIn) maxCrossTrackIn = nearest;
        }
      }
    }
    return {
      id: traceStep.id,
      estimateNominalS: nominalS,
      actualS,
      deltaS: nominalS === null ? null : actualS - nominalS,
      interrupted: traceStep.interrupted,
      maxCrossTrackIn,
    };
  });

  const lastLedger = trace.ledger[trace.ledger.length - 1];
  const launches = trace.ledger.reduce((sum, row) => sum + (row.launches ?? 0), 0);
  const tips: Record<string, number> = {};
  for (const row of trace.ledger) {
    for (const [alliance, count] of Object.entries(row.tips ?? {})) tips[alliance] = count;
  }

  return {
    auto: trace.auto,
    simTimeS: trace.simTimeS,
    steps,
    totalEstimateS: estimateResult?.nominalS ?? null,
    totalActualS: trace.steps.reduce((sum, step) => sum + (step.endS - step.startS), 0),
    structureContacts: trace.structureContacts.length,
    launches,
    tips,
    heldAtEnd: lastLedger?.held ?? null,
    capabilities: trace.capabilities,
    inert: KNOWN_CAPABILITIES.filter((capability) => !trace.capabilities.includes(capability)),
  };
}
