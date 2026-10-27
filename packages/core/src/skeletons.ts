/**
 * The files `zenith init` and `zenith new` write, and the editor's Set up writes into a robot
 * repository with no `zenith.json` yet (issue #159). They live in core, which is pure, so the CLI
 * and the app write exactly the same files. Each one is parsed before it is canonicalised, so a
 * skeleton that would not validate cannot be written in the first place.
 *
 * Every number here carries a provenance label, because a skeleton is exactly where an invented
 * number would otherwise slip in (CLAUDE.md rule 4). The label says what wrote it: `zenith init`,
 * `zenith new`, or whatever the caller passes as `writtenBy`.
 */
import { FORMAT_VERSIONS, parseAuto, parseLink, parseRobot, parseWaypoints, SCHEMA_ID, type Robot } from "@horizon36596/zenith-schema";
import { canonicalize } from "./canonicalize.js";
import { STARTER_CODEGEN_SECTION, type CommandLibrary } from "./codegen/javaCodegen.js";
import { mirrorAuto, type MirrorMode } from "./mirror.js";

/**
 * Where the skeleton auto starts, in RED's frame. A BLUE skeleton is this one mirrored, because a
 * file's poses are in its own alliance's frame (site/docs/file-format.md). NEEDS MEASUREMENT: it is
 * chosen to pass the BIOBUZZ field's `startRules` for `robotSkeleton`'s 18 x 14 in footprint, not
 * measured off a real start. Facing +y, the robot's 18 in length runs along y, so y = -63 puts its
 * back edge on the south wall (y = -72). x = -12 keeps its 14 in width (x from -19 to -5) in RED's
 * own half, clear of loadingZoneRed (on the x = -72 wall at y from +24 to +48) and of every flower
 * (the nearest, flower3, stands on the same wall at x = +24, 29 in east of the robot's edge).
 */
const SKELETON_START = { xIn: -12, yIn: -63, headingRad: 1.5708 };

/** How far the skeleton's one leg drives straight out from the wall. PLACEHOLDER. */
const SKELETON_LEG_IN = 24;

/** The season field file a skeleton project names, which `zenith init` copies out of the season package. */
export const SKELETON_FIELD_PATH = "autos/field/biobuzz.field.json";

export interface LinkSkeletonOptions {
  /** `deploy.commandLibrary`. Left out of the file when not given: Zenith never picks one. */
  commandLibrary?: CommandLibrary;
  /** `deploy.robotClass`, fully qualified. Left out of the file when not given. */
  robotClass?: string;
  /**
   * Whether to write the `codegen` section. `zenith init` always does, because without one
   * `zenith deploy` writes no OpMode (issue #156); the editor's Set up writes it only with a robot
   * class, since every OpMode deploy writes constructs one. Defaults to true.
   */
  codegen?: boolean;
}

/**
 * `zenith.json` for a new project. The command library and the robot class are written only when
 * the person named them; Zenith never picks either (site/docs/command-libraries.md). It never has a
 * `sim` section: that names a test in the robot's own code, which a new project does not have yet.
 */
export function linkSkeleton(options: LinkSkeletonOptions = {}): string {
  const { commandLibrary, robotClass } = options;
  return canonicalize(
    "link",
    parseLink({
      $schema: SCHEMA_ID.link,
      formatVersion: FORMAT_VERSIONS.link,
      autosDir: "autos",
      robot: "autos/robot.json",
      field: SKELETON_FIELD_PATH,
      waypoints: "autos/waypoints.json",
      deploy: {
        kind: "androidAssets",
        dir: "TeamCode/src/main/assets/autos",
        ...(commandLibrary === undefined ? {} : { commandLibrary }),
        ...(robotClass === undefined ? {} : { robotClass }),
      },
      ...(options.codegen === false ? {} : { codegen: { ...STARTER_CODEGEN_SECTION } }),
    }),
  );
}

/** The skeleton robot, parsed: a robot named `name` with no commands, every number NEEDS MEASUREMENT. */
export function skeletonRobot(name: string, writtenBy = "zenith init"): Robot {
  const placeholder = `NEEDS MEASUREMENT: written by ${writtenBy}`;
  return parseRobot({
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
  });
}

/** `robot.json` for a new project, in canonical form. */
export function robotSkeleton(name: string, writtenBy = "zenith init"): string {
  return canonicalize("robot", skeletonRobot(name, writtenBy));
}

/** `waypoints.json` for a new project: one `start` waypoint, a legal BIOBUZZ start for the skeleton robot. */
export function waypointsSkeleton(writtenBy = "zenith init"): string {
  return canonicalize(
    "waypoints",
    parseWaypoints({
      $schema: SCHEMA_ID.waypoints,
      formatVersion: FORMAT_VERSIONS.waypoints,
      waypoints: {
        start: {
          ...SKELETON_START,
          provenance: `NEEDS MEASUREMENT: written by ${writtenBy}, a legal BIOBUZZ start for the skeleton robot`,
        },
      },
    }),
  );
}

/**
 * The skeleton auto `zenith new` writes. It is laid out for RED; a BLUE one is the same routine
 * mirrored by the field's own symmetry, `mirror`, so it starts on BLUE's half where the robot run as
 * BLUE starts it.
 */
export function autoSkeleton(
  name: string,
  alliance: "RED" | "BLUE" = "RED",
  mirror: MirrorMode = "pointSymmetry",
  writtenBy = "zenith new",
): string {
  const red = parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name,
    title: name,
    alliance: "RED",
    start: {
      pose: {
        ...SKELETON_START,
        provenance: `NEEDS MEASUREMENT: written by ${writtenBy}, a legal BIOBUZZ start for the skeleton robot`,
      },
    },
    steps: [
      {
        id: "path1",
        kind: "path",
        segments: [
          {
            kind: "line",
            from: "current",
            to: {
              xIn: SKELETON_START.xIn,
              yIn: SKELETON_START.yIn + SKELETON_LEG_IN,
              provenance: `PLACEHOLDER: written by ${writtenBy}, 24 in straight out from the start`,
            },
          },
        ],
        heading: { mode: "tangent" },
        notes: "Replace this path with the real opening move.",
      },
    ],
  });
  return canonicalize("auto", alliance === "RED" ? red : mirrorAuto(red, mirror));
}
