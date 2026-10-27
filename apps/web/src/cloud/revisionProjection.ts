/**
 * A share's projection rebuilt from a team library revision (spec 13
 * sections 8.2 and 8.3), not from whatever the editor has open: what a change of level on the
 * Sharing page and a follow-latest share on publish send. The revision is planned and run through
 * the instant sim exactly as the editor would run it (`resolve`, `plan`, `simulateRun`), and the
 * projection is built by the same `buildProjection` the share dialog uses, so a share rebuilt from
 * the revision it was made from is byte for byte the projection the dialog showed.
 *
 * The robot and field are the ones published with the revision. A revision published without them
 * is rebuilt against the open project's, which is the robot it was made for when the team keeps
 * its robot repository open; with neither, the reason says to open that project.
 */
import { loadAuto, loadField, loadRobot, loadWaypoints, plan, resolve, simulateRun } from "@horizon36596/zenith-core";
import type { Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { buildProjection, type ProjectionChoice } from "./projectionModel";
import type { RevisionFiles } from "./types";
import { previewSimOptions } from "../state/ledgerRun";

/** The open project's robot, field and waypoints, for a revision published without its own. */
export interface ProjectFiles {
  robot: Robot;
  field: Field;
  waypoints?: Waypoints | undefined;
}

/** Builds one projection of a revision at a level and coarseness, or null when it cannot. */
export type RevisionBuilder = (choice: ProjectionChoice) => string | null;

export type RevisionProjector = { ok: true; build: RevisionBuilder } | { ok: false; reason: string };

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Plans and simulates a revision once, and returns a builder for its projection at any choice; or
 * the reason, as a sentence, when the revision cannot be projected here.
 */
export function revisionProjector(files: RevisionFiles, fallback: ProjectFiles | null, revisionN: number): RevisionProjector {
  const which = `Revision ${String(revisionN)}`;
  try {
    const robot = files.robot !== undefined ? loadRobot(JSON.parse(files.robot)) : fallback?.robot;
    const field = files.field !== undefined ? loadField(JSON.parse(files.field)) : fallback?.field;
    if (robot === undefined || field === undefined) {
      return {
        ok: false,
        reason: `${which} was published without robot.json and a field, so its projection cannot be rebuilt here. Open the robot's project first, then try again.`,
      };
    }
    const waypoints = files.waypoints !== undefined ? loadWaypoints(JSON.parse(files.waypoints)) : fallback?.waypoints;
    const auto = loadAuto(JSON.parse(files.content));
    const planned = plan(resolve(auto, waypoints, robot), robot, field);
    // The same run the editor's preview makes, ledger and all, so the rebuilt projection is the
    // one the share dialog showed.
    const trace = simulateRun(planned, robot, field, previewSimOptions(planned, field)).trace;
    // A share that keeps the auto's name shows the revision's own title when it has one, so a
    // rename published since reaches the partner; otherwise the name the share already carries.
    const ownTitle = auto.title?.trim() ?? "";
    return {
      ok: true,
      build: (choice) => {
        const named = choice.title !== undefined && ownTitle !== "" ? { ...choice, title: ownTitle } : choice;
        const built = buildProjection({ plan: planned, trace }, named);
        return built.ok ? built.canonical : null;
      },
    };
  } catch (error) {
    return { ok: false, reason: `${which} could not be projected: ${say(error)}` };
  }
}
