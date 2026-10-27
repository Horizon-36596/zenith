/**
 * @horizon36596/zenith-import: bring paths from other planners into Zenith
 * (the facts it rests on are recorded in Zenith's ADR 0008).
 *
 * - `importPedroProject` turns a Pedro Pathing Visualizer `.pp` project into an auto.
 * - `importTrajectory` and `readTrajectory` turn an interchange `trajectory.json` (the file the
 *   MeepMeep exporter writes, or any planner's own) into a view projection at 10 Hz, and
 *   `importTrajectoryAsAuto` turns one into an auto, so a team can share it like any other.
 * - `importPath` turns an interchange `path.json` (lines, Bézier segments and heading modes) into
 *   an auto that can be edited.
 * - `interchangeKindOf` and `checkInterchange` tell the two interchange files apart and check one
 *   the way importing it would, for `zenith validate`.
 * - `scanCommands` reads a robot's `NamedCommands` registrations out of its Java or Kotlin source,
 *   `checkCommandRegistry` compares them with `robot.json`, and `mergeCommandScan` adds what
 *   `robot.json` is missing without touching what a person wrote (ADR 0014).
 *
 * Pure, like `@horizon36596/zenith-core`: no DOM, no clock, no randomness, no Node APIs. Reading the
 * bytes is the caller's job.
 */
export * from "./errors.js";
export * from "./frame.js";
export * from "./bezier.js";
export * from "./pedro/format.js";
export * from "./pedro/importPedro.js";
export * from "./trajectory/schema.js";
export * from "./trajectory/importTrajectory.js";
export * from "./trajectory/trajectoryAuto.js";
export * from "./path/schema.js";
export * from "./path/importPath.js";
export * from "./interchange.js";
export * from "./java/scanCommands.js";
export * from "./java/mergeCommands.js";
export * from "./java/projectScan.js";
export * from "./textDiff.js";
