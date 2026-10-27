/**
 * The Full sim switch: whether the robot repository's own sim is offered, as the desktop app's
 * high-fidelity sim, the Full sim playback level and loading a trace file. The owner hid it from the
 * beta on 2026-10-08 (issue #207) and turned it back on for 0.1.2 on 2026-10-14, so it is on. No row
 * in Settings changes it: this constant is the switch. Setting it to `false` hides every entry point
 * at once again, the desktop app's native menu included (`apps/desktop/src/main/menu.ts`).
 *
 * Plain data with no DOM, because the desktop app's main process imports it too.
 */
export const FULL_SIM_DEFAULT: boolean = true;
