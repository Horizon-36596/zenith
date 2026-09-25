import { canonicalize } from "@horizon36596/zenith-core";
import type { CommandLibrary } from "./commandLibrary.js";
import {
  FORMAT_VERSIONS,
  parseAuto,
  parseLink,
  parseRobot,
  parseWaypoints,
  SCHEMA_ID,
} from "@horizon36596/zenith-schema";

/**
 * The files `zenith init` and `zenith new` write. Each one is parsed before it is canonicalised, so
 * a skeleton that would not validate cannot be written in the first place.
 *
 * Every number here carries a provenance label, because a skeleton is exactly where an invented
 * number would otherwise slip in (CLAUDE.md rule 4).
 */

/**
 * Where the skeleton auto starts, in the field's canonical (RED) frame, which a BLUE auto also
 * uses. NEEDS MEASUREMENT: it is chosen to pass the BIOBUZZ field's `startRules` for
 * `robotSkeleton`'s 18 x 14 in footprint, not measured off a real start. Facing +y, the robot's
 * 18 in length runs along y, so y = -63 puts its back edge on the south wall (y = -72). x = -12
 * keeps its 14 in width (x from -19 to -5) in RED's own half, clear of loadingZoneRed (on the
 * x = -72 wall at y from +24 to +48) and of every flower (the nearest, flower3, stands on the same
 * wall at x = +24, 29 in east of the robot's edge).
 */
const SKELETON_START = { xIn: -12, yIn: -63, headingRad: 1.5708 };

/** How far the skeleton's one leg drives straight out from the wall. PLACEHOLDER. */
const SKELETON_LEG_IN = 24;

/**
 * `zenith.json` for `zenith init`. The command library is written only when the person named one;
 * Zenith never picks it (site/docs/command-libraries.md).
 */
export function linkSkeleton(commandLibrary?: CommandLibrary): string {
  return canonicalize(
    "link",
    parseLink({
      $schema: SCHEMA_ID.link,
      formatVersion: FORMAT_VERSIONS.link,
      autosDir: "autos",
      robot: "autos/robot.json",
      field: "autos/field/biobuzz.field.json",
      waypoints: "autos/waypoints.json",
      deploy: {
        kind: "androidAssets",
        dir: "TeamCode/src/main/assets/autos",
        ...(commandLibrary === undefined ? {} : { commandLibrary }),
      },
    }),
  );
}

export function robotSkeleton(name: string): string {
  const placeholder = "NEEDS MEASUREMENT: written by zenith init";
  return canonicalize(
    "robot",
    parseRobot({
      $schema: SCHEMA_ID.robot,
      formatVersion: FORMAT_VERSIONS.robot,
      name,
      frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
      footprint: {
        startIn: { lengthIn: 18, widthIn: 14, provenance: placeholder },
        expandedIn: { lengthIn: 18, widthIn: 14, provenance: placeholder },
        centreOfRotationIn: { xIn: 0, yIn: 0, provenance: placeholder },
      },
      heightIn: { value: 18, provenance: placeholder },
      kinematics: {
        maxForwardVelInPerS: { value: 60, provenance: placeholder },
        maxStrafeVelInPerS: { value: 50, provenance: placeholder },
        forwardDecelInPerS2: { value: 60, provenance: placeholder },
        strafeDecelInPerS2: { value: 30, provenance: placeholder },
        accelInPerS2: { value: 60, provenance: placeholder },
        maxAngularVelRadPerS: { value: 6, provenance: placeholder },
        defaultPathSpeedFraction: { value: 0.8, provenance: placeholder },
        follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
      },
      commands: [],
      conditions: [],
    }),
  );
}

export function waypointsSkeleton(): string {
  return canonicalize(
    "waypoints",
    parseWaypoints({
      $schema: SCHEMA_ID.waypoints,
      formatVersion: FORMAT_VERSIONS.waypoints,
      waypoints: {
        start: {
          ...SKELETON_START,
          provenance: "NEEDS MEASUREMENT: written by zenith init, a legal BIOBUZZ start for the skeleton robot",
        },
      },
    }),
  );
}

export function autoSkeleton(name: string, alliance: "RED" | "BLUE" = "RED"): string {
  return canonicalize(
    "auto",
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: FORMAT_VERSIONS.auto,
      name,
      title: name,
      alliance,
      start: {
        pose: {
          ...SKELETON_START,
          provenance: "NEEDS MEASUREMENT: written by zenith new, a legal BIOBUZZ start for the skeleton robot",
        },
      },
      steps: [
        {
          id: "leg1",
          kind: "path",
          segments: [
            {
              kind: "line",
              from: "current",
              to: {
                xIn: SKELETON_START.xIn,
                yIn: SKELETON_START.yIn + SKELETON_LEG_IN,
                provenance: "PLACEHOLDER: written by zenith new, 24 in straight out from the start",
              },
            },
          ],
          heading: { mode: "tangent" },
          notes: "Replace this leg with the real opening move.",
        },
      ],
    }),
  );
}
