/**
 * The live run: Zenith's command tree and Pedro follower driven by another program's robot
 * (`liveRun.ts`).
 */
export {
  createLiveRun,
  type LiveBelief,
  type LiveCommand,
  type LiveHost,
  type LiveOptions,
  type LiveRun,
  type LiveTick,
} from "./liveRun.js";
export type { DrivePowers } from "../sim/follower.js";
