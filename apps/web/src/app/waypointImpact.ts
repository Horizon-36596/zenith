/**
 * What a waypoint edit does to the project's other autos (issue #191). `waypoints.json` is shared, so
 * moving a waypoint moves every point that follows it in every auto, and an auto that is not open
 * shows nothing of it until someone opens it. This reads each other auto once per project, checks
 * the ones that follow a changed waypoint with the waypoints as saved and with the new ones
 * (`checkOnly`), and counts only the errors the change adds. The Waypoints list's Used by line,
 * Save's status line and the unsaved-changes question all word what this finds.
 */
import { loadAuto, waypointUses } from "@horizon36596/zenith-core";
import type { Auto, Waypoints } from "@horizon36596/zenith-schema";
import { countOf } from "../lib/format";
import { checkOnly, errorCountOf, newErrors } from "../lib/checkOnly";
import { resolveAutoOverrides } from "../project/overrides";
import { getState, type State } from "../state/store";
import { listed } from "./edits";

/** An auto of the project other than the open one, parsed, or null when Zenith could not read it. */
interface Other {
  file: string;
  auto: Auto | null;
}

/**
 * Each other auto parsed once per project: the cache belongs to the project's `autoTexts`, which a
 * project keeps for as long as it is open, and an auto's entry is dropped when Save writes it.
 */
const parsed = new WeakMap<object, Map<string, Promise<Auto | null>>>();

async function parseOther(state: State, file: string): Promise<Auto | null> {
  const { project, backend } = state;
  if (project === null) return null;
  try {
    const dir = project.link.autosDir.replace(/\/+$/, "");
    const text = project.autoTexts[file] ?? (backend === null ? undefined : await backend.readText(`${dir}/${file}`));
    if (text === undefined) return null;
    return loadAuto(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Every auto of the open project but the open one, each read and parsed once. */
export async function otherAutos(state: State = getState()): Promise<Other[]> {
  const { project, fileName } = state;
  if (project === null) return [];
  let cache = parsed.get(project.autoTexts);
  if (cache === undefined) {
    cache = new Map();
    parsed.set(project.autoTexts, cache);
  }
  const files = project.autoFiles.filter((file) => file !== fileName);
  return Promise.all(
    files.map(async (file) => {
      let entry = cache.get(file);
      if (entry === undefined) {
        entry = parseOther(state, file);
        cache.set(file, entry);
      }
      const auto = await entry;
      // A read that failed is tried again next time rather than remembered.
      if (auto === null) cache.delete(file);
      return { file, auto };
    }),
  );
}

/** Save wrote `file`, so what the project's cache holds of it is out of date. */
export function forgetOtherAuto(file: string): void {
  const project = getState().project;
  if (project !== null) parsed.get(project.autoTexts)?.delete(file);
}

/** An auto's file name as a person says it: `cycle-and-park.auto.json` is cycle-and-park. */
export const autoNameOf = (file: string): string => file.replace(/\.auto\.json$/, "");

/** The waypoints file's own name, for the sentences that name it: `waypoints.json`. */
export const waypointsFileName = (state: State = getState()): string =>
  state.project?.link.waypoints?.split("/").pop() ?? "waypoints.json";

const sameWaypoint = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The waypoints whose pose or label differs from the saved file, added and removed ones included. */
export function changedWaypointNames(state: State = getState()): string[] {
  const now = state.project?.waypoints?.waypoints;
  const saved = state.savedWaypoints?.waypoints;
  if (now === undefined || saved === undefined) return [];
  const names = new Set([...Object.keys(saved), ...Object.keys(now)]);
  return [...names].filter((name) => !sameWaypoint(saved[name], now[name]));
}

/** One other auto that follows a changed waypoint, and what the change does to its checks. */
export interface AutoImpact {
  file: string;
  /** `cycle-and-park`, as the sentences name it. */
  name: string;
  /** The errors the change adds, or null when they were not counted or could not be. */
  newErrors: number | null;
  /** The errors it has with the new waypoints, or null when they were not counted or could not be. */
  errorsNow: number | null;
}

export interface Impact {
  /** The other autos that follow at least one of the waypoints, by file name. */
  followers: AutoImpact[];
  /** Autos Zenith could not read, so it cannot say whether they follow them. */
  unreadable: string[];
  /** Followers whose checks did not run. */
  unchecked: string[];
}

/**
 * Which other autos follow any of waypoints `names`. With `count`, each is checked against the saved
 * waypoints and against the saved ones with `names` as they are now, and `newErrors` is what the
 * change adds. Without it nothing is checked: the autos are only named.
 */
export async function waypointImpact(names: readonly string[], count: boolean, state: State = getState()): Promise<Impact> {
  const { project, backend } = state;
  const impact: Impact = { followers: [], unreadable: [], unchecked: [] };
  if (project === null || names.length === 0) return impact;
  const now = project.waypoints?.waypoints ?? {};
  const savedFile = state.savedWaypoints;
  const others = await otherAutos(state);
  for (const { file, auto } of others) {
    if (auto === null) {
      impact.unreadable.push(file);
      continue;
    }
    if (!names.some((name) => waypointUses(auto, name).length > 0)) continue;
    const row: AutoImpact = { file, name: autoNameOf(file), newErrors: null, errorsNow: null };
    impact.followers.push(row);
    if (!count || savedFile === undefined) continue;
    try {
      const after: Record<string, Waypoints["waypoints"][string]> = { ...savedFile.waypoints };
      for (const name of names) {
        const moved = now[name];
        if (moved === undefined) delete after[name];
        else after[name] = moved;
      }
      const overrides = backend === null ? { robot: project.robot, field: project.field } : await resolveAutoOverrides(project, backend, auto);
      const was = checkOnly(auto, overrides.robot, overrides.field, savedFile);
      const is = checkOnly(auto, overrides.robot, overrides.field, { ...savedFile, waypoints: after });
      if (!was.ok || !is.ok) {
        impact.unchecked.push(file);
        continue;
      }
      row.newErrors = newErrors(was.value, is.value);
      row.errorsNow = errorCountOf(is.value);
    } catch {
      impact.unchecked.push(file);
    }
  }
  impact.followers.sort((a, b) => a.file.localeCompare(b.file));
  impact.unreadable.sort((a, b) => a.localeCompare(b));
  return impact;
}

/** The other autos that follow the changed waypoints and break, for Save's status line. */
export const brokenBy = (impact: Impact): AutoImpact[] => impact.followers.filter((row) => (row.newErrors ?? 0) > 0);

/**
 * The sentence Save adds after what it wrote: "cycle-and-park now has 4 errors.", or an empty string
 * when the change adds no error to any other auto.
 */
export function saveImpactSentence(impact: Impact): string {
  const broken = brokenBy(impact);
  if (broken.length === 0) return "";
  const each = broken.map((row) => `${row.name} now has ${countOf(row.errorsNow ?? row.newErrors ?? 0, "error")}`);
  return ` ${each.length === 1 ? each[0] ?? "" : `${each.slice(0, -1).join(", ")} and ${each.at(-1) ?? ""}`}.`;
}

/** The other autos in the Used by line's hint: the followers, each with the errors the change adds. */
export function otherAutosRow(impact: Impact): string {
  if (impact.followers.length === 0 && impact.unreadable.length === 0) return "no other auto follows it";
  const rows = [...impact.followers].sort((a, b) => (b.newErrors ?? 0) - (a.newErrors ?? 0) || a.file.localeCompare(b.file));
  const shown = rows.slice(0, 3).map((row) => ((row.newErrors ?? 0) > 0 ? `${row.name} (${countOf(row.newErrors ?? 0, "new error")})` : row.name));
  const more = rows.length - shown.length;
  const parts = [more > 0 ? `${listed(shown)} and ${countOf(more, "more")}` : listed(shown)].filter((text) => text !== "");
  if (impact.unreadable.length > 0 || impact.unchecked.length > 0) {
    const missed = [...impact.unreadable, ...impact.unchecked].map(autoNameOf);
    parts.push(`could not check ${listed(missed)}`);
  }
  return parts.join("; ");
}

/**
 * The parenthesis of the unsaved-changes question: "2 other autos follow gardenSweepStart". Empty
 * when no other auto follows a changed waypoint.
 */
export function followedNote(names: readonly string[], impact: Impact): string {
  const count = impact.followers.length;
  if (count === 0 || names.length === 0) return "";
  const which = names.length === 1 ? (names[0] ?? "") : names.length === 2 ? `${names[0] ?? ""} or ${names[1] ?? ""}` : `one of the ${String(names.length)} changed waypoints`;
  return `${countOf(count, "other auto")} ${count === 1 ? "follows" : "follow"} ${which}`;
}
