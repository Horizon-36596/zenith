/**
 * The instant sim's public surface, and the ideal playback level beside it (`ideal.ts`). The
 * follower, the plant and the command ports stay internal: callers get traces, the parameters the
 * sim resolved, and the comparison with a Gradle run.
 */
export { simulate, simulateRun, resimulate, simPoseAt } from "./simulate.js";
export {
  idealTrajectory,
  idealPoseAt,
  idealTimeAt,
  posesDiffer as idealPosesDiffer,
  IDEAL_POSITION_TOLERANCE_IN,
  IDEAL_HEADING_TOLERANCE_RAD,
  type IdealHold,
  type IdealPathMotion,
  type IdealSegment,
  type IdealSpan,
  type IdealTrajectory,
  type IdealTransition,
} from "./ideal.js";
export { simResiduals, type SimResiduals, type StepResidual } from "./residuals.js";
export {
  followerParams as simFollowerParams,
  plantParams as simPlantParams,
  PEDRO_DEFAULTS,
  DEFAULT_TICK_S as SIM_DEFAULT_TICK_S,
  GRADLE_TICK_S as SIM_GRADLE_TICK_S,
} from "./params.js";
export type {
  ConditionQuery,
  ConditionResolver,
  CoastModel,
  FollowerParams,
  PlantParams,
  SimCheckpoint,
  SimEvent,
  SimFidelity,
  SimOptions,
  SimRun,
  SimStepRecord,
  SimTrace,
  TraceVelocityRow,
} from "./types.js";
