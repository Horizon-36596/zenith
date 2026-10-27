/**
 * The numbers the optimizer's bench sets: which scorer the search uses for every candidate, and how
 * many candidates it may score.
 *
 * The bench itself is `scripts/bench-optimizer.ts`. It is a script and not a test, because a clock
 * does not belong in `pnpm test` or in this package. What it measures, and what it chose from the
 * measurement, is recorded below, so a later unit reads the constants and the rule that produced
 * them, and can re-run the script to see whether the answer still holds.
 *
 * Pure (CLAUDE.md rule 1).
 */

/** The middle value of the list, or the mean of the middle two. Throws on an empty list. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new Error("There is no median of an empty list.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const high = sorted[middle] as number;
  return sorted.length % 2 === 1 ? high : ((sorted[middle - 1] as number) + high) / 2;
}

/**
 * The cost of one window simulation, in milliseconds, above which the search stops scoring every
 * candidate with the instant sim and scores with the estimate instead.
 */
export const FINALIST_THRESHOLD_MS = 10;

/** In finalist mode the instant sim re-ranks this many of the estimate's best candidates. */
export const FINALIST_COUNT = 3;

/** How long a typical step's search should take on the machine the bench ran on, in seconds. */
export const BUDGET_TARGET_S = 2;

/** The budget is a multiple of this, so the figure reads as chosen and not computed. */
export const BUDGET_STEP = 50;

/**
 * Which scorer the search uses for every candidate (spec 16 section 5.2): `sim` scores each one
 * with the instant sim, `finalist` scores with the estimate and lets the instant sim re-rank the
 * best few. One window simulation above the threshold means finalist mode.
 */
export type ScorerMode = "sim" | "finalist";

export function chooseScorerMode(t1WindowMs: number, thresholdMs: number = FINALIST_THRESHOLD_MS): ScorerMode {
  return t1WindowMs > thresholdMs ? "finalist" : "sim";
}

/**
 * How many evaluations fit in `targetS` seconds when one costs `perEvaluationMs`, rounded down to
 * `BUDGET_STEP` and never below one step.
 */
export function chooseBudget(perEvaluationMs: number, targetS: number = BUDGET_TARGET_S): number {
  if (!(perEvaluationMs > 0) || !Number.isFinite(perEvaluationMs)) {
    throw new Error("The time of one evaluation must be a positive number of milliseconds.");
  }
  const fits = Math.floor((targetS * 1000) / perEvaluationMs);
  return Math.max(BUDGET_STEP, Math.floor(fits / BUDGET_STEP) * BUDGET_STEP);
}

/**
 * What `scripts/bench-optimizer.ts` measured, in milliseconds: the median over every path step of
 * the example projects of each step's own median of 15 runs, so no one step decides it.
 *
 * - `t0Candidate`: resolve the auto with one step changed, plan it (every other step answers from
 *   the plan memo) and estimate it.
 * - `t1Window`: one window evaluation under the instant sim, that is the ledger the sim reads plus
 *   `resimulate` resumed from the checkpoint at the step and stopped when the step ends
 *   (`SimOptions.stopAfterStepId`).
 * - `t1MiniAuto`: the alternative to the checkpoint, the step simulated alone from rest. It
 *   leaves out the speed the robot arrives with and everything the steps before it did, so it is
 *   not used; it is recorded because it is the cheaper way to get a number if the checkpoint ever
 *   costs more than it saves.
 * - the `Slowest` figures are the single slowest run of any step, which is the figure to read when
 *   asking whether one evaluation can ever block a frame.
 * - `wholeRunPerEvaluation` (issue #434): one whole Optimize path run on each step at
 *   `wholeRunBudget` evaluations, the search, the final check and the result, divided by the
 *   evaluations it made; the median over the steps, and the slowest step. It is what a run costs per
 *   evaluation, the search's own geometry and clearance tests and the final check included, which
 *   the candidate figures leave out. They are about a quarter of it: 2.62 ms of 10.719 ms.
 */
export const OPTIMIZE_BENCH = {
  t0CandidateMedianMs: 1.483,
  t0CandidateSlowestMs: 3.54,
  t1WindowMedianMs: 1.134,
  t1ResimulateMedianMs: 1.018,
  t1ResimulateSlowestMs: 3.384,
  t1MiniAutoMedianMs: 0.361,
  t1MiniAutoSlowestMs: 1.351,
  wholeRunBudget: 250,
  wholeRunPerEvaluationMedianMs: 10.719,
  wholeRunPerEvaluationSlowestMs: 18.75,
  /** 32 path steps in the 7 autos of the two example projects. */
  steps: 32,
  runsPerStep: 15,
  /** The runtime and machine it ran on. */
  node: "v22.23.3",
  machine: "AMD Ryzen 9 7950X 16-Core Processor, 32 threads",
  date: "2026-10-11",
  wholeRunDate: "2026-10-12",
} as const;

/**
 * The scorer the search uses for every candidate. One window evaluation costs well under
 * `FINALIST_THRESHOLD_MS`, so the instant sim scores each candidate and finalist mode is not used.
 */
export const OPTIMIZE_SCORER_MODE: ScorerMode = "sim";

/**
 * How many evaluations the search may make, chosen from what a whole run costs per evaluation
 * (`wholeRunPerEvaluationMedianMs`, 10.72 ms). `BUDGET_TARGET_S` of that is 186, which
 * `chooseBudget` rounds down to 150; the budget is the smallest above it at which the OPT-10
 * Contract still holds, 250, so a typical step takes about 2.7 s on the bench machine and finishes
 * well inside the editor's 5 s safety stop. At 150 and 200 the Contract's route no longer passes the
 * dense oracle and the range moves no longer find their turn.
 *
 * It was 750, chosen from the candidate figures alone (T0 plus one window, 2.62 ms). That left out
 * about three quarters of what a run costs, so a typical step took 7 to 9 s instead of 2 s, and in the editor
 * most runs met the 5 s safety stop and ended "Stopped early" (issue #434).
 */
export const OPTIMIZE_DEFAULT_BUDGET = 250;

/**
 * The longest a typical step's whole run may take at the default budget on the bench machine, in
 * seconds (SET BY HAND, issue #434): well inside the editor's 5 s safety stop (spec 16 section 7),
 * so a typical run ends on its own result and not "Stopped early".
 */
export const BUDGET_CEILING_S = 3;

/** Where each number above comes from, in the project's provenance vocabulary (CLAUDE.md rule 4). */
export const OPTIMIZE_PROVENANCE = {
  finalistThresholdMs: "SET BY HAND: the 10 ms rule for one scoring-span simulation.",
  finalistCount: "SET BY HAND: the three best candidates by the estimate are re-ranked by the instant sim in finalist mode (spec 16 section 5.2).",
  budgetTargetS: "SET BY HAND: a typical step should finish in about 2 s (spec 16 section 5.3).",
  budgetStep: "SET BY HAND: the budget is rounded down to a multiple of 50 so it reads as a chosen number.",
  bench:
    "MEASURED by scripts/bench-optimizer.ts on 2026-10-11, 15 runs per path step, Node v22.23.3, the middle of three runs (2.48, 2.62 and 2.77 ms per evaluation). Other work was running on the machine, so the figures may be a little slow and the budget a little small. Node v26.2.0 on the same machine was about 40% faster (1.80 ms back to back with the first run), which is why the first bench, run in Node 26, chose 1150.",
  scorerMode: "SET BY HAND from the bench: one simulated span costs 1.13 ms, far below the 10 ms threshold, so every candidate is scored by the instant sim.",
  wholeRun:
    "MEASURED by scripts/bench-optimizer.ts on 2026-10-12, one whole run per path step at 250 evaluations, Node v22.23.3. Other work was running on the machine (the candidate figures read 3.28 ms that day against 2.62 ms on 2026-10-11), so the figure may be a little slow and the budget a little small.",
  defaultBudget:
    "SET BY HAND from the bench: 2 s at 10.72 ms per evaluation of a whole run is 186, which rounds down to 150; raised to 250, the smallest budget at which the OPT-10 Contract holds, about 2.7 s a run (issue #434).",
  budgetCeilingS: "SET BY HAND: a typical run at the default budget stays under 3 s, well inside the editor's 5 s safety stop (issue #434).",
} as const;
