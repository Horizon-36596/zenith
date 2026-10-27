/**
 * The alliance view for the open auto: the user's robot predicted by the instant sim (core's
 * `ownAllianceRobot`, the same call the CLI and the MCP server make, so all three compare the same
 * prediction), the loaded partners in the user's alliance frame, and the predicted findings.
 *
 * Recomputed only when its inputs change: the user's robot is memoised on the plan, which is one
 * object per document, and the findings on `allianceKey`. Dragging the scrubber changes neither.
 */
import { mirrorForField, ownAllianceRobot, type AllianceRobot, type Plan, type Pose } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { allianceKey, computeAlliance, lastValueMemo, type AllianceFrame, type AllianceResult } from "./model";
import { useAllianceState, type AllianceState } from "./store";

/** The user's robot for a plan, or why the instant sim could not predict it. */
export type OwnRobot = { ok: true; robot: AllianceRobot } | { ok: false; reason: string };

const ownCache = new WeakMap<Plan, OwnRobot>();

/** The user's robot for a plan, run once per plan. */
export function ownRobotFor(plan: Plan): OwnRobot {
  const hit = ownCache.get(plan);
  if (hit !== undefined) return hit;
  let result: OwnRobot;
  try {
    const season = resolveSeason(plan.field).rules;
    result = { ok: true, robot: ownAllianceRobot(plan, plan.field, season) };
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  ownCache.set(plan, result);
  return result;
}

/** The frame a partner is put into: the auto's alliance and the field's own mirror. */
export function allianceFrameFor(plan: Plan): AllianceFrame {
  const season = resolveSeason(plan.field).rules;
  const mirrorId = season.mirrorId;
  const claimPlace = season.claimPlace;
  const field = plan.field;
  return {
    alliance: plan.auto.alliance,
    mirror: mirrorForField(plan.field),
    ...(mirrorId === undefined ? {} : { mirrorId: (id: string) => mirrorId.call(season, id) }),
    ...(claimPlace === undefined
      ? {}
      : { claimPlace: (elementId: string, pose: Pose) => claimPlace.call(season, field, elementId, pose) }),
  };
}

export interface AllianceView {
  state: AllianceState;
  /** True while at least one partner is loaded: the scrubber then reads the alliance clock. */
  active: boolean;
  /** The own start offset in force: the chosen one while active, else 0. */
  ownOffsetS: number;
  own: OwnRobot | null;
  result: AllianceResult | null;
}

const memo = lastValueMemo<AllianceResult>();

/** The alliance view's inputs and result, from a plan and the alliance store's state. */
export function allianceView(plan: Plan | null, state: AllianceState): AllianceView {
  const active = state.partners.length > 0;
  const ownOffsetS = active ? state.ownOffsetS : 0;
  if (!active || plan === null) return { state, active, ownOffsetS, own: null, result: null };
  const own = ownRobotFor(plan);
  if (!own.ok) return { state, active, ownOffsetS, own, result: null };
  const frame = allianceFrameFor(plan);
  const key = allianceKey(own.robot, ownOffsetS, frame, state.partners);
  const result = memo(key, () => computeAlliance(own.robot, state.partners, ownOffsetS, frame));
  return { state, active, ownOffsetS, own, result };
}

/** The alliance view for a plan, as a hook. */
export function useAlliance(plan: Plan | null): AllianceView {
  return allianceView(plan, useAllianceState());
}
