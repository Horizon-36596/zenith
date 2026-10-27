/**
 * How far a typed pose may go (issue #502): the field, and past each wall by the robot's
 * half-diagonal, so a pose whose robot still touches the field is kept and a typo such as an x of
 * 99999 is refused with the range. A curve's control points are shape handles and are not held.
 */
import { useSelector, autoFieldOf, autoRobotOf, type State } from "../state/store";
import { robotReachIn } from "../canvas/footprintBounds";
import type { Field, Robot } from "@horizon36596/zenith-schema";
import type { NumberRange } from "../components/numberStep";

export interface PoseBounds {
  x: NumberRange;
  y: NumberRange;
}

/** No field or robot yet: a pose is not held. */
const OPEN: PoseBounds = { x: {}, y: {} };

/** Rounded out to a whole inch, so the range reads `-84 to 84 in` rather than a long decimal. */
const out = (value: number, direction: 1 | -1): number => {
  const rounded = direction === 1 ? Math.ceil(value) : Math.floor(value);
  return rounded === 0 ? 0 : rounded;
};

/** The range of x and y a pose may take on `field` for `robot`, in the field's own frame. */
export function poseBounds(field: Field | null, robot: Robot | null): PoseBounds {
  if (field === null) return OPEN;
  const reach = robot === null ? 0 : robotReachIn(robot);
  const axis = (sizeIn: number): NumberRange =>
    field.frame.origin === "centre"
      ? { min: out(-sizeIn / 2 - reach, -1), max: out(sizeIn / 2 + reach, 1) }
      : { min: out(-reach, -1), max: out(sizeIn + reach, 1) };
  return { x: axis(field.sizeIn.xIn), y: axis(field.sizeIn.yIn) };
}

let lastField: Field | null = null;
let lastRobot: Robot | null = null;
let lastBounds: PoseBounds = OPEN;

/** The bounds for the open auto's field and robot, kept while neither changes. */
const selectPoseBounds = (state: State): PoseBounds => {
  const field = autoFieldOf(state);
  const robot = autoRobotOf(state);
  if (field !== lastField || robot !== lastRobot) {
    lastField = field;
    lastRobot = robot;
    lastBounds = poseBounds(field, robot);
  }
  return lastBounds;
};

/** The range a pose field in the Inspector takes, for the open auto's field and robot. */
export const usePoseBounds = (): PoseBounds => useSelector(selectPoseBounds);
