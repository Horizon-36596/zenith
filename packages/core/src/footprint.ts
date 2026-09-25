import type { Field, Mouth, Robot } from "@horizon36596/zenith-schema";
import { rectCorners, type Box2, type Rect } from "./geometry/sat.js";
import { add, rotate, type Pose, type Vec2 } from "./geometry/vec.js";

/** The robot's footprint at one pose: the expanded box plus a box per mouth. */
export interface FootprintAtPose {
  /** The expanded rectangle, four corners counter-clockwise. */
  bodyIn: Vec2[];
  /** One polygon per mouth in `robot.json`, in the same order. */
  mouthsIn: Vec2[][];
}

/**
 * The footprint box, in the field frame, for a pose.
 *
 * `centreOfRotationIn` is where the centre of rotation sits inside the footprint, in the robot
 * frame, so the box centre is the path point minus that offset rotated into the field frame. A
 * robot whose centre of rotation is the middle of its box (the default, 0, 0) is unaffected.
 */
export function bodyRect(pose: Pose, robot: Robot, which: "startIn" | "expandedIn"): Rect {
  const box = robot.footprint[which];
  const offset = robot.footprint.centreOfRotationIn;
  const centreIn = add(pose, rotate({ xIn: -offset.xIn, yIn: -offset.yIn }, pose.headingRad));
  return {
    centreIn,
    lengthIn: box.lengthIn,
    widthIn: box.widthIn,
    headingRad: pose.headingRad,
  };
}

/** A mouth's box: `widthIn` across the robot, `depthIn` out along the side it is on. */
export function mouthRect(pose: Pose, mouth: Mouth): Rect {
  const alongX = mouth.side === "FRONT" || mouth.side === "BACK";
  return {
    centreIn: add(pose, rotate(mouth.offsetIn, pose.headingRad)),
    lengthIn: alongX ? mouth.depthIn : mouth.widthIn,
    widthIn: alongX ? mouth.widthIn : mouth.depthIn,
    headingRad: pose.headingRad,
  };
}

export function footprintAt(
  pose: Pose,
  robot: Robot,
  which: "startIn" | "expandedIn" = "expandedIn",
): FootprintAtPose {
  return {
    bodyIn: rectCorners(bodyRect(pose, robot, which)),
    mouthsIn: (robot.mouths ?? []).map((mouth) => rectCorners(mouthRect(pose, mouth))),
  };
}

/** Every polygon of a footprint, body first, for the checks that sweep all of them. */
export const footprintPolygons = (footprint: FootprintAtPose): Vec2[][] => [
  footprint.bodyIn,
  ...footprint.mouthsIn,
];

/**
 * The axis-aligned bounds of the whole footprint at a pose: the body and every mouth, which is the
 * exact set of polygons the PERIMETER and STRUCTURE checks test. The canvas wall snap reads this,
 * so a pose snapped flush to a wall is flush by the same measure the check uses and never reports
 * PERIMETER (the snap once read the body alone and left a mouth hanging over the wall).
 */
export function footprintBoundsIn(
  pose: Pose,
  robot: Robot,
  which: "startIn" | "expandedIn" = "expandedIn",
): Box2 {
  let minXIn = Infinity;
  let maxXIn = -Infinity;
  let minYIn = Infinity;
  let maxYIn = -Infinity;
  for (const polygon of footprintPolygons(footprintAt(pose, robot, which))) {
    for (const corner of polygon) {
      minXIn = Math.min(minXIn, corner.xIn);
      maxXIn = Math.max(maxXIn, corner.xIn);
      minYIn = Math.min(minYIn, corner.yIn);
      maxYIn = Math.max(maxYIn, corner.yIn);
    }
  }
  return { minXIn, maxXIn, minYIn, maxYIn };
}

/** The field perimeter as a box, from `sizeIn` and where the frame puts the origin. */
export function fieldBounds(field: Field): Box2 {
  const { xIn, yIn } = field.sizeIn;
  if (field.frame.origin === "centre") {
    return { minXIn: -xIn / 2, maxXIn: xIn / 2, minYIn: -yIn / 2, maxYIn: yIn / 2 };
  }
  return { minXIn: 0, maxXIn: xIn, minYIn: 0, maxYIn: yIn };
}
