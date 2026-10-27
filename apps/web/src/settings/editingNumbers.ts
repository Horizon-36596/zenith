/**
 * The four editing numbers (`editing.nudgeIn`, `editing.nudgeFarIn`, `editing.rotateDeg` and
 * `editing.scrubStepS`) as one value, and the words that name them. Every site that moves, turns or
 * scrubs by one of them reads `editingNumbers(prefs)`, and every sentence that says how far reads
 * `formatInches`, `formatDegrees` or `formatSeconds`, so the keys, the shortcut sheet and the hints
 * cannot disagree. Pure: the caller passes the preferences.
 */
import { degToRad } from "@horizon36596/zenith-core";
import type { Prefs } from "../state/prefs";
import { getSetting, settingEntry } from "./registry";

export interface EditingNumbers {
  /** An arrow key's step, in inches. */
  nudgeIn: number;
  /** Shift and an arrow key's step, in inches. */
  nudgeFarIn: number;
  /** `R`'s turn, in degrees. */
  rotateDeg: number;
  /** `,` and `.`'s step, in seconds. */
  scrubStepS: number;
}

/** The numbers in `prefs`, each in its registered range or at its default. */
export const editingNumbers = (prefs: Prefs): EditingNumbers => ({
  nudgeIn: getSetting(prefs, "editing.nudgeIn"),
  nudgeFarIn: getSetting(prefs, "editing.nudgeFarIn"),
  rotateDeg: getSetting(prefs, "editing.rotateDeg"),
  scrubStepS: getSetting(prefs, "editing.scrubStepS"),
});

/** The decimals the Settings field shows for these numbers, and so the most it keeps. */
export const EDITING_NUMBER_DIGITS = 2;

/**
 * A number typed into the Settings field, rounded to the decimals the field shows, so the key, the
 * shortcut sheet and the field all say the same number. The range of each entry is whole hundredths,
 * so a value inside it stays inside it.
 */
export const roundEditingNumber = (value: number): number => Number(value.toFixed(EDITING_NUMBER_DIGITS));

/** A number as short as it can be written: 0.5, 1, 0.05, never 0.50 or 0.049999. */
const plain = (value: number): string => String(Number(value.toFixed(3)));

export const formatInches = (inches: number): string => `${plain(inches)} in`;
export const formatDegrees = (degrees: number): string => `${plain(degrees)}°`;
export const formatSeconds = (seconds: number): string => `${plain(seconds)} s`;

/** `R`'s turn in radians, for the edits that write one: files hold radians, the UI degrees. */
export const rotateRadians = (prefs: Prefs): number => degToRad(getSetting(prefs, "editing.rotateDeg"));

/** The numbers with nothing set: the registry's defaults, which are the old constants. */
export const DEFAULT_EDITING_NUMBERS: EditingNumbers = {
  nudgeIn: settingEntry("editing.nudgeIn").defaultValue,
  nudgeFarIn: settingEntry("editing.nudgeFarIn").defaultValue,
  rotateDeg: settingEntry("editing.rotateDeg").defaultValue,
  scrubStepS: settingEntry("editing.scrubStepS").defaultValue,
};
