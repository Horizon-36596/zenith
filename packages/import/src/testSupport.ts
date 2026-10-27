import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Field, Robot } from "@horizon36596/zenith-schema";

/** Test helpers: the starter example's robot and field, and the fixtures. Never shipped. */
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

export const starterField = (): Field => loadField(readJson(here("../../../examples/starter/autos/field/biobuzz.field.json")));
export const starterRobot = (): Robot => loadRobot(readJson(here("../../../examples/starter/autos/robot.json")));

export const fixturePath = (relative: string): string => here(`../fixtures/${relative}`);

/** The file names in a fixture directory with the given ending, sorted. */
export const fixtureFiles = (dir: string, ending: string): string[] =>
  readdirSync(here(`../fixtures/${dir}`))
    .filter((name) => name.endsWith(ending))
    .sort();
