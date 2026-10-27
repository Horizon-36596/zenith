/**
 * Full sim speed (site/docs/full-sim-simloop.md, "Full sim speed"): how the desktop app runs the
 * robot repository's own sim, the person's choice in Settings, General. What each speed does and
 * what it costs the computer is said once, here, and the Settings row and the docs read it.
 *
 * Plain data with no DOM, like `fullSimSwitch.ts`, so the desktop app's main process may import it.
 */
import type { DesktopSimSpeed } from "../project/desktopBridge";

export type SimSpeed = DesktopSimSpeed;

/** In the order the control lists them. */
export const SIM_SPEEDS: readonly SimSpeed[] = ["basic", "fast", "ultrafast"];

/** Fast: SET BY HAND, the agreed plan. It is the default because it costs nothing until the first run. */
export const DEFAULT_SIM_SPEED: SimSpeed = "fast";

export const SIM_SPEED_LABEL: Readonly<Record<SimSpeed, string>> = {
  basic: "Basic",
  fast: "Fast",
  ultrafast: "Ultrafast",
};

/** What each speed does, in a sentence or two. */
export const SIM_SPEED_DOES: Readonly<Record<SimSpeed, string>> = {
  basic: "Builds and runs the robot code with Gradle for every run. Nothing keeps running afterwards.",
  fast: "Starts a sim server on the first run and keeps it for 10 minutes after the last one. Each run plays as it is simulated.",
  ultrafast:
    "Starts the sim server when the project opens. Runs an auto again in the background after you save it.",
};

/**
 * What each speed costs, roughly. MEASURED on one team's robot code on a team laptop, 2026-10-15
 * (8 logical processors, on mains power), with two autos, a 30 s one and a shorter one, warm: Basic
 * took 6 to 10 s a click; the sim server took about 3 s to prepare and under 1 s to start, then 0.1 to
 * 0.3 s to the first rows and 0.8 to 2 s to the whole run, using one to two cores, and held about 0.3 GB
 * of memory after eight runs. Another robot's code, or a slower computer, will differ.
 */
export const SIM_SPEED_COST: Readonly<Record<SimSpeed, { wait: string; computer: string }>> = {
  basic: {
    wait: "Roughly 6 to 10 s before a run starts to play.",
    computer: "Uses the computer only while a run is going.",
  },
  fast: {
    wait: "Roughly 4 s for the first run while the sim server starts, then well under 1 s.",
    computer: "Roughly 0.3 GB of memory while the sim server is up, and one or two processor cores for a second or two each run.",
  },
  ultrafast: {
    wait: "A run of a saved auto plays at once.",
    computer: "Roughly 0.3 GB of memory while the project is open, and one or two processor cores for a second or two after each save.",
  },
};

/** Why a project only has Basic, or null when it has a sim server. */
export const simSpeedLimit = (link: { sim?: { server?: unknown } | undefined } | null | undefined): string | null =>
  link?.sim?.server === undefined
    ? "This project runs Basic only: its zenith.json has no sim.server section, so there is no sim server to keep warm."
    : null;

/** The speed a run actually goes at: the chosen one, or Basic for a project without a sim server. */
export const effectiveSimSpeed = (chosen: SimSpeed, link: { sim?: { server?: unknown } | undefined } | null | undefined): SimSpeed =>
  simSpeedLimit(link) === null ? chosen : "basic";
