/**
 * A path's Speed in the inspector (issues #144, #409 and #431), shown as a percentage of the
 * robot's velocity cap: `30%`, or, for a path with no `speedFraction` of its own, the robot's
 * `defaultPathSpeedFraction` on a quiet row, `80% default`. The file keeps the fraction; only the
 * row shows percent. The arrow keys and a drag on the empty field start from the default. A path
 * with a speed of its own gets a reset button at the row's end, which removes the key, so the path
 * follows the robot again when its default changes.
 */
import { RotateCcw } from "lucide-react";
import { CompactNumber, FieldRow } from "../components/fields";
import { RowButton } from "../components/primitives";
import { useSelector, type State } from "../state/store";
import styles from "./Inspector.module.css";

/** The default speed fraction of the robot the open auto uses, its own robot file first. */
const selectDefaultSpeed = (state: State): number | undefined =>
  (state.autoRobot ?? state.project?.robot)?.kinematics.defaultPathSpeedFraction.value;

/** The robot's default speed fraction, which a path with no speed of its own drives at. */
export const useRobotDefaultSpeed = (): number | undefined => useSelector(selectDefaultSpeed);

/** A fraction as the row's percent, `0.8` to `80`, without float noise. */
export const fractionToPercent = (fraction: number): number => Math.round(fraction * 10000) / 100;

/** A typed percent back to the file's fraction, `35` to `0.35`. */
export const percentToFraction = (percent: number): number => Math.round(percent * 100) / 10000;

/** The row's words for a fraction, `80%`. */
export const percentText = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;

export function SpeedFractionField({
  value,
  onChange,
}: {
  /** The path's own `speedFraction`, or undefined when it follows the robot's default. */
  value: number | undefined;
  /** A new fraction, or null to remove the path's own and follow the robot's default. */
  onChange: (value: number | null) => void;
}) {
  const robotDefault = useSelector(selectDefaultSpeed);
  const shown = robotDefault === undefined ? "the robot's default" : percentText(robotDefault);
  // At the robot's default the row is quiet, `80% default`; a speed of its own has a reset at the
  // row's right edge (issue #431).
  return (
    <FieldRow
      label="Speed"
      describe="inspector.speed"
      testId="inspector-speed-row"
      quiet={value === undefined}
      action={
        value === undefined ? undefined : (
          <RowButton
            icon={RotateCcw}
            label={`Use the robot default, ${shown}`}
            hint="Removes this path's own speed, so it follows robot.json when that changes."
            testId="inspector-speed-default"
            onClick={() => {
              onChange(null);
            }}
          />
        )
      }
    >
      <CompactNumber<number | null>
        label="Speed"
        narrow
        unit="%"
        value={value === undefined ? null : fractionToPercent(value)}
        step={5}
        digits={0}
        min={1}
        max={100}
        nullable
        emptyStart={robotDefault === undefined ? undefined : fractionToPercent(robotDefault)}
        placeholder={robotDefault === undefined ? "" : String(Math.round(robotDefault * 100))}
        testId="inspector-speed"
        hint={`A share of the robot's velocity cap, applied only if your ZenithRobot implements atSpeed. Empty uses the robot default, ${shown}.`}
        onChange={(percent) => {
          onChange(percent === null ? null : percentToFraction(percent));
        }}
      />
      {value === undefined ? (
        <>
          {robotDefault === undefined ? null : <span className={`unit ${styles.percentSign}`}>%</span>}
          <span className={styles.defaultNote} data-testid="inspector-speed-default-note">
            default
          </span>
        </>
      ) : null}
    </FieldRow>
  );
}
