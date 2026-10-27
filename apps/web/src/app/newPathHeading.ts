/**
 * The heading a new path gets from the person's settings (`editing.defaultHeading` and
 * `editing.newPathKeepsHeading`, issue #435). Every place that creates a path calls this, so none
 * is missed: `edits.ts` (the add-path tool, Add a path here, Insert, a sequence or group's first
 * path), `optimize/clearPath.ts`, and the new-auto flows (`app/newAuto.ts`, `project/hostSession.ts`).
 * Core and the file never see the preferences.
 */
import type { Heading } from "@horizon36596/zenith-schema";
import { heldPathHeadingFor, newPathHeadingFor } from "../lib/headingModes";
import { getState } from "../state/store";

/** `arrivalRad` is the heading the robot has where the path starts, `endRad` where it would end otherwise. */
export const newPathHeading = (arrivalRad: number, endRad: number): Heading =>
  newPathHeadingFor(getState().prefs, arrivalRad, endRad);

/**
 * The heading of a new path that holds `headingRad`, the heading the robot arrives with, along a
 * leg that does not drive the way it faces (issue #445): Linear from it to itself, Constant only
 * when the person's setting is Constant.
 */
export const heldPathHeading = (headingRad: number): Heading => heldPathHeadingFor(getState().prefs, headingRad);
