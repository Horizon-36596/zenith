import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMAND_TOKEN_PATTERN,
  CONDITION_TOKEN_PATTERN,
  parseProjection,
  PROJECTION_PHASE_LABELS,
  SCHEMA_ID,
  STEP_ID_PATTERN,
  type Auto,
  type Field,
  type Projection,
  type ProjectionStep,
  type Robot,
  type Step,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { runLedger } from "./ledger.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { listIds } from "./edit/ids.js";
import { ProjectionError, projectionStepIdMap, projectionTokenMap, projectShare, type ProjectShareOptions } from "./projection.js";
import { resolve } from "./resolve.js";
import { noSeasonRules, type SeasonRules } from "./season.js";
import { simulate } from "./sim/simulate.js";
import type { Plan } from "./types.js";

/**
 * The projection's contract (spec 13 sections 8.2 and 16, M-C3): what
 * another team receives is built from an allowlist, so nothing in `robot.json`, no command or
 * condition name, no note, description, author, date or file path, ever reaches it. The SCRUB tests
 * below are that contract, run over every auto of the example project at both levels.
 *
 * The example is `examples/starter`: Horizon's own robot example stays in the private repository
 * and nothing that goes public may read it (`scripts/check-example-deps.mjs`). The starter project
 * is the public copy of the same kind of project, on the same BIOBUZZ field, and its four autos
 * hold every step kind, markers, end conditions, waits on a condition and a branch.
 */

const root = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

const AUTOS = ["first-auto", "collect-and-score", "all-step-kinds", "cycle-and-park"] as const;
const LEVELS = ["view", "propose"] as const;

/**
 * The keys whose values are the format's own fixed words: the kind, the level, the alliance, the
 * phase labels, claim actions, step and segment kinds, heading and parallel modes, and the season
 * and schema ids of the public field and format. A robot file or an author may use one of those
 * words for something of their own (the starter robot has a command called `score`, and an auto has
 * a step called `collect`), and finding the format's word in a projection then says nothing about
 * them. So the search runs over every other string value in the projection: the step ids, the
 * tokens, the element ids, the title. Keys are not searched, since the strict schema fixes every
 * one of them (a waypoint called `start` is not found in `startPose`).
 */
const FORMAT_KEYS: ReadonlySet<string> = new Set(["$schema", "kind", "level", "season", "alliance", "label", "action", "mode"]);

/** Every string value in the projection, except those under `FORMAT_KEYS`. */
function searchableText(projection: Projection): string[] {
  const values: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (Array.isArray(value)) for (const item of value) walk(item, key);
    else if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    } else if (typeof value === "string" && !FORMAT_KEYS.has(key)) values.push(value);
  };
  walk(projection, "");
  return values;
}

/** Fails when `secret` is one of the values, or, when long enough, inside one of them. */
function expectAbsent(values: readonly string[], secret: string, what: string): void {
  if (secret.length === 0) return;
  expect(values, `${what} ${JSON.stringify(secret)} as a whole value`).not.toContain(secret);
  if (secret.length >= MIN_SUBSTRING_LENGTH) {
    const holder = values.find((value) => value.includes(secret));
    expect(holder, `${what} ${JSON.stringify(secret)} inside another string`).toBeUndefined();
  }
}

interface Project {
  robot: Robot;
  field: Field;
  waypoints: Waypoints;
  robotJson: unknown;
  linkJson: unknown;
  waypointsJson: unknown;
}

function project(): Project {
  const linkJson = read("zenith.json");
  const link = loadLink(linkJson);
  const robotJson = read(link.robot);
  const waypointsJson = read(link.waypoints ?? "autos/waypoints.json");
  return {
    robot: loadRobot(robotJson),
    field: loadField(read(link.field)),
    waypoints: loadWaypoints(waypointsJson),
    robotJson,
    linkJson,
    waypointsJson,
  };
}

/** Plans and simulates an auto the way the editor does, from nothing but the files. */
function inputsFor(auto: Auto, files: Project, season: SeasonRules = noSeasonRules) {
  const planned: Plan = plan(resolve(auto, files.waypoints), files.robot, files.field, { memoize: false });
  const ledger = runLedger(planned, files.field, season);
  const trace = simulate(planned, files.robot, files.field, { ledger, season });
  return { plan: planned, trace, robot: files.robot, field: files.field, ledger };
}

function projectExample(name: string, options: ProjectShareOptions): { projection: Projection; autoJson: unknown } {
  const files = project();
  const autoJson = read(`autos/${name}.auto.json`);
  return { projection: projectShare(inputsFor(loadAuto(autoJson), files), options), autoJson };
}

/** The opaque id `projectShare` gives each of an example auto's steps, looked up by the real id. */
function opaqueIdOf(name: string): (realId: string) => string {
  const inputs = inputsFor(loadAuto(read(`autos/${name}.auto.json`)), project());
  const byRealId = new Map([...projectionStepIdMap(inputs, { level: "propose" })].map(([opaque, real]) => [real, opaque] as const));
  return (realId) => {
    const opaque = byRealId.get(realId);
    if (opaque === undefined) throw new Error(`No step ${realId} in ${name}.`);
    return opaque;
  };
}

/** Every string value in a JSON document, and every key of a `params` table (a command's parameter names). */
function stringsIn(value: unknown, out: Set<string> = new Set(), parentKey = ""): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out, parentKey);
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (parentKey === "params") out.add(key);
      stringsIn(child, out, key);
    }
  }
  return out;
}

/** The values under the given keys, anywhere in a JSON document. */
function valuesUnder(value: unknown, keys: readonly string[], out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) valuesUnder(item, keys, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key)) stringsIn(child, out);
      valuesUnder(child, keys, out);
    }
  }
  return out;
}

/** Every step of a projection's structure, depth first. */
function allSteps(steps: readonly ProjectionStep[]): ProjectionStep[] {
  return steps.flatMap((step) => {
    switch (step.kind) {
      case "sequence":
      case "parallel":
        return [step, ...allSteps(step.steps)];
      case "branch":
        return [step, ...allSteps(step.then), ...allSteps(step.else ?? [])];
      default:
        return [step];
    }
  });
}

/** The shortest secret searched for as a substring; shorter ones are searched as whole strings only. */
const MIN_SUBSTRING_LENGTH = 4;

describe("projectShare: SCRUB (M-C3 contract)", () => {
  for (const name of AUTOS) {
    for (const level of LEVELS) scrubTests(name, level);
  }
});

/** The SCRUB tests for one auto at one level. */
function scrubTests(name: string, level: "view" | "propose"): void {
  it(`${name} at ${level} holds no string from robot.json`, () => {
    const { robotJson } = project();
    const text = searchableText(projectExample(name, { level }).projection);
    const robotStrings = [...stringsIn(robotJson)];
    expect(robotStrings.length).toBeGreaterThan(20);
    for (const secret of robotStrings) expectAbsent(text, secret, "robot.json string");
  });

  it(`${name} at ${level} holds none of the auto's step ids`, () => {
    const { projection, autoJson } = projectExample(name, { level });
    const text = searchableText(projection);
    const ids = listIds((autoJson as { steps: Step[] }).steps);
    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids) expectAbsent(text, id, "step id");
  });

  it(`${name} at ${level} holds no command or condition name, note, description, author or date`, () => {
    const { projection, autoJson } = projectExample(name, { level });
    const text = searchableText(projection);
    const auto = autoJson as Record<string, unknown>;
    const secrets = new Set<string>([
      ...valuesUnder(autoJson, ["notes", "description", "authors", "created", "provenance", "args"]),
      ...valuesUnder(autoJson, ["name", "condition", "until", "deadline", "ref", "robot", "field"]),
      String(auto["name"]),
      String(auto["title"]),
    ]);
    for (const secret of secrets) expectAbsent(text, secret, "auto string");
    expect(JSON.stringify(projection)).not.toMatch(/"(notes|description|authors|created|provenance|name|args|expect|ref|robot|field)"\s*:/);
  });

  it(`${name} at ${level} holds no file path, link setting or waypoint name`, () => {
    const { linkJson, waypointsJson } = project();
    const { projection } = projectExample(name, { level });
    const text = searchableText(projection);
    for (const secret of stringsIn(linkJson)) expectAbsent(text, secret, "zenith.json string");
    for (const waypoint of Object.keys((waypointsJson as { waypoints: Record<string, unknown> }).waypoints)) {
      expectAbsent(text, waypoint, "waypoint name");
    }
    // The one URL a projection carries is its own schema id.
    expect(JSON.stringify(projection).replaceAll(SCHEMA_ID.projection, "")).not.toMatch(/\.json|\.java|autos\/|TeamCode|https?:|\.\//);
  });
}

/**
 * "Include command names" (owner ruling 2026-09-27). With the option on, the one thing a projection
 * adds is its `commands` list, which names each command token and the call's arguments. The SCRUB
 * contract is kept by proving two things: the projection without that list is exactly the one made
 * with the option off, which the SCRUB tests above already hold to everything; and the list holds
 * nothing but each call's own name and arguments, copied from the auto, with no condition name and
 * no other string from `robot.json`.
 */
describe("projectShare: include command names", () => {
  const NAMED_KEYS = new Set(["token", "kind", "name", "args", "startS", "endS"]);

  for (const name of AUTOS) {
    for (const level of LEVELS) {
      it(`${name} at ${level}: off, or absent, is byte for byte the projection before the option existed`, () => {
        const absent = canonicalize("projection", projectExample(name, { level }).projection);
        const off = projectExample(name, { level, includeCommands: false }).projection;
        expect("commands" in off).toBe(false);
        expect(canonicalize("projection", off)).toBe(absent);
      });

      it(`${name} at ${level}: on adds only the commands list, and the rest is the projection made with it off`, () => {
        const off = projectExample(name, { level }).projection;
        const { commands, ...rest } = projectExample(name, { level, includeCommands: true }).projection;
        expect(commands?.length).toBeGreaterThan(0);
        expect(rest).toEqual(off);
      });

      it(`${name} at ${level}: the commands list holds each call's name and arguments and nothing else`, () => {
        const files = project();
        const autoJson = read(`autos/${name}.auto.json`);
        const inputs = inputsFor(loadAuto(autoJson), files);
        const projection = projectShare(inputs, { level, includeCommands: true });
        const commands = projection.commands ?? [];
        // One entry per command token, in token order, each exactly what the token stands for.
        const sources = [...projectionTokenMap(inputs, { level: "propose" })].filter(([token]) => token.startsWith("cmd"));
        expect(commands.map((entry) => entry.token)).toEqual(sources.map(([token]) => token));
        for (const [index, entry] of commands.entries()) {
          for (const key of Object.keys(entry)) expect(NAMED_KEYS.has(key), `${name} key ${key}`).toBe(true);
          const source = sources[index]?.[1];
          if (source === undefined || !("command" in source)) throw new Error(`${name}: no command behind ${entry.token}`);
          expect(entry.kind).toBe(source.kind === "commandStep" ? "command" : "marker");
          expect(entry.name).toBe(source.command.name);
          expect(entry.args).toEqual(source.command.args);
          expect(entry.token).toMatch(COMMAND_TOKEN_PATTERN);
        }
        // At the propose level every token in the structure is named by the list.
        if (level === "propose") {
          const held = [...JSON.stringify(projection.structure).matchAll(/"token":"(cmd[0-9]+)"/g)].map((match) => match[1]);
          expect([...new Set(held)].sort()).toEqual(commands.map((entry) => entry.token).sort());
        }

        // The only strings the list may hold are the tokens, the two kinds, and the names and
        // arguments the auto itself passes; so no condition name, note, step id, file path or other
        // string from robot.json (a summary, a parameter's description, a provenance) is there.
        const calls = allAuthoredSteps((autoJson as { steps: Step[] }).steps).flatMap((step) => [
          ...(step.kind === "command" ? [{ name: step.name, args: step.args }] : []),
          ...(step.kind === "path" ? (step.markers ?? []).map((marker) => marker.command) : []),
        ]);
        const allowed = new Set<string>(["command", "marker", ...commands.map((entry) => entry.token)]);
        for (const call of calls) {
          allowed.add(call.name);
          for (const [key, value] of Object.entries(call.args ?? {})) {
            allowed.add(key);
            if (typeof value === "string") allowed.add(value);
          }
        }
        const held = new Set<string>();
        for (const entry of commands) {
          for (const [key, value] of Object.entries(entry)) {
            if (typeof value === "string") held.add(value);
            if (key === "args") for (const [arg, argValue] of Object.entries(value as Record<string, unknown>)) {
              held.add(arg);
              if (typeof argValue === "string") held.add(argValue);
            }
          }
        }
        for (const value of held) expect(allowed.has(value), `${name} holds ${JSON.stringify(value)}`).toBe(true);
        const conditions = valuesUnder(autoJson, ["condition", "until"]);
        for (const condition of conditions) expect(held.has(condition), `${name} condition ${condition}`).toBe(false);
        // So every other robot.json string is absent as a value. (A substring search is not made:
        // a name such as `intakeOn` holds the subsystem `intake` it requires, and the name is what
        // the sharer chose to send.)
        const robotStrings = [...stringsIn(files.robotJson)].filter((value) => !allowed.has(value));
        expect(robotStrings.length).toBeGreaterThan(20);
        for (const secret of robotStrings) expect(held.has(secret), `${name} robot.json string ${secret}`).toBe(false);
      });
    }
  }

  it("names a command step and a marker, with the span its step ran in the instant sim", () => {
    const files = project();
    const inputs = inputsFor(loadAuto(read("autos/collect-and-score.auto.json")), files);
    const projection = projectShare(inputs, { level: "view", includeCommands: true });
    const commands = projection.commands ?? [];
    const record = (id: string) => inputs.trace.steps.find((step) => step.id === id);
    const marker = commands.find((entry) => entry.token === "cmd2");
    expect(marker).toMatchObject({ kind: "marker", name: "intakeOn" });
    expect(marker?.args).toBeUndefined();
    expect(marker?.startS).toBeCloseTo(record("collectFlower")?.startS ?? Number.NaN, 3);
    const score = commands.find((entry) => entry.kind === "command" && entry.name === "score");
    expect(score?.args).toEqual({ count: 4 });
    expect(score?.startS).toBeDefined();
    expect(score?.endS ?? 0).toBeGreaterThanOrEqual(score?.startS ?? 0);
    // A view projection still carries no structure: the list is the only place a token appears.
    expect("structure" in projection).toBe(false);
  });

  it("round-trips byte-identically through parse and canonicalize, coarsened too", () => {
    for (const name of AUTOS) {
      for (const coarsen of [false, true]) {
        const { projection } = projectExample(name, { level: "propose", includeCommands: true, coarsen });
        const text = canonicalize("projection", projection);
        expect(canonicalize("projection", parseProjection(JSON.parse(text)))).toBe(text);
        expect(JSON.parse(text)).toEqual(projection);
      }
    }
  });
});

describe("projectShare: levels", () => {
  it("a view projection carries no structure", () => {
    for (const name of AUTOS) {
      const { projection } = projectExample(name, { level: "view" });
      expect(projection.level).toBe("view");
      expect("structure" in projection).toBe(false);
    }
  });

  it("a propose projection carries the structure, with every command a token and nothing else", () => {
    for (const name of AUTOS) {
      const { projection, autoJson } = projectExample(name, { level: "propose" });
      expect(projection.level).toBe("propose");
      const steps = allSteps(projection.structure?.steps ?? []);
      const authored = allAuthoredSteps((autoJson as { steps: Step[] }).steps);
      expect(steps.map((step) => step.kind)).toEqual(authored.map((step) => step.kind));

      // Every step is named s1 to sN in step order, whatever the author called it.
      expect(steps.map((step) => step.id)).toEqual(steps.map((_, index) => `s${String(index + 1)}`));
      for (const step of steps) expect(step.id).toMatch(STEP_ID_PATTERN);

      const commands = steps.filter((step) => step.kind === "command");
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(Object.keys(command).sort()).toEqual(
          ["estimateS", "id", "kind", "movesRobot", "stationary", "token", ...("timeoutS" in command ? ["timeoutS"] : [])].sort(),
        );
        expect(command.token).toMatch(COMMAND_TOKEN_PATTERN);
      }
      const tokens = [
        ...steps.flatMap((step) => (step.kind === "path" ? (step.markers ?? []).map((marker) => marker.token) : [])),
        ...commands.map((command) => command.token),
      ];
      // Tokens are distinct: one per call, not one per command name.
      expect(new Set(tokens).size).toBe(tokens.length);
      for (const step of steps) {
        if (step.kind === "path" && step.endCondition !== undefined) {
          expect(step.endCondition.token).toMatch(CONDITION_TOKEN_PATTERN);
        }
        if (step.kind === "path") {
          for (const segment of step.segments) {
            expect(typeof segment.from).toBe("object");
            expect(typeof segment.to).toBe("object");
          }
        }
      }
    }
  });

  it("turns markers, end conditions, branch conditions and deadlines into opaque names, keeping where a marker fires", () => {
    const { projection } = projectExample("cycle-and-park", { level: "propose" });
    const steps = allSteps(projection.structure?.steps ?? []);
    const opaque = opaqueIdOf("cycle-and-park");
    const byRealId = (id: string): ProjectionStep | undefined => steps.find((step) => step.id === opaque(id));
    expect(byRealId("driveOut")).toMatchObject({ id: "s1", kind: "path", markers: [{ at: { t: 0.25 }, token: "cmd1" }] });
    expect(byRealId("scorePreload")).toMatchObject({ kind: "command", token: "cmd2" });
    expect(byRealId("sweepGarden")).toMatchObject({ endCondition: { token: "cond1" } });
    expect(byRealId("scoreIfCollected")).toMatchObject({ kind: "branch", condition: { token: "cond2" } });
    // The deadline names the drive by its opaque id too.
    expect(byRealId("returnToScore")).toMatchObject({ kind: "parallel", deadline: opaque("driveBack") });
    expect(byRealId("driveBack")?.kind).toBe("path");
  });

  it("numbers command tokens from cmd1 in step order, a path's markers counted with the path", () => {
    const { projection } = projectExample("cycle-and-park", { level: "propose" });
    const steps = allSteps(projection.structure?.steps ?? []);
    const tokens = steps.flatMap((step) => {
      if (step.kind === "command") return [step.token];
      if (step.kind === "path") return (step.markers ?? []).map((marker) => marker.token);
      return [];
    });
    expect(tokens.length).toBeGreaterThan(4);
    expect(tokens).toEqual(tokens.map((_, index) => `cmd${String(index + 1)}`));
    const commands = steps.filter((step) => step.kind === "command");
    // score: 0.5 + count * 0.5 with count 4, and stationary.
    expect(commands.find((command) => command.id === opaqueIdOf("cycle-and-park")("scorePreload"))).toMatchObject({
      estimateS: 2.5,
      stationary: true,
      movesRobot: false,
      timeoutS: 3,
    });
  });

  it("refuses, by name, a projection its own schema would refuse", () => {
    expect(() => projectExample("first-auto", { level: "view", title: "x".repeat(201) })).toThrow(ProjectionError);
    expect(() => projectExample("first-auto", { level: "view", title: "x".repeat(201) })).toThrow(/title/);
  });

  it("keeps the auto's title only when the sharer passes one", () => {
    expect("title" in projectExample("first-auto", { level: "view" }).projection).toBe(false);
    expect(projectExample("first-auto", { level: "view", title: "Our first auto" }).projection.title).toBe("Our first auto");
  });
});

describe("projectionStepIdMap", () => {
  it("maps every opaque step id back to the auto's own step id, in step order", () => {
    const files = project();
    for (const name of AUTOS) {
      const autoJson = read(`autos/${name}.auto.json`);
      const inputs = inputsFor(loadAuto(autoJson), files);
      const projection = projectShare(inputs, { level: "propose" });
      const map = projectionStepIdMap(inputs, { level: "propose" });
      const opaqueIds = allSteps(projection.structure?.steps ?? []).map((step) => step.id);
      expect([...map.keys()]).toEqual(opaqueIds);
      expect([...map.values()]).toEqual(listIds((autoJson as { steps: Step[] }).steps));
    }
  });

  it("is the same map for the same inputs, however often it is built, and is not stored", () => {
    const files = project();
    const auto = loadAuto(read("autos/all-step-kinds.auto.json"));
    const first = projectionStepIdMap(inputsFor(auto, files), { level: "propose" });
    const second = projectionStepIdMap(inputsFor(auto, files), { level: "propose" });
    expect([...second]).toEqual([...first]);
    const text = searchableText(projectShare(inputsFor(auto, files), { level: "propose" }));
    for (const realId of first.values()) expectAbsent(text, realId, "step id");
  });

  it("gives each of two steps that share an id its own opaque id", () => {
    const files = project();
    const auto = loadAuto(read("autos/first-auto.auto.json"));
    const twice: Auto = { ...auto, steps: [...auto.steps, { id: "pause", kind: "wait", seconds: 0.5 }, { id: "pause", kind: "wait", seconds: 0.5 }] };
    const map = projectionStepIdMap(inputsFor(twice, files), { level: "propose" });
    expect([...map.entries()].slice(-2)).toEqual([
      ["s4", "pause"],
      ["s5", "pause"],
    ]);
  });

  it("is empty for a view projection, which holds no step ids", () => {
    const files = project();
    const auto = loadAuto(read("autos/first-auto.auto.json"));
    expect(projectionStepIdMap(inputsFor(auto, files), { level: "view" }).size).toBe(0);
  });
});

describe("projectionTokenMap", () => {
  it("says what every token in the structure stands for, by the real step that holds it", () => {
    const files = project();
    for (const name of AUTOS) {
      const inputs = inputsFor(loadAuto(read(`autos/${name}.auto.json`)), files);
      const projection = projectShare(inputs, { level: "propose" });
      const map = projectionTokenMap(inputs, { level: "propose" });
      const text = JSON.stringify(projection.structure);
      const held = [...text.matchAll(/"token":"(c(?:md|ond)[0-9]+)"/g)].map((match) => match[1]);
      expect([...map.keys()].sort()).toEqual([...new Set(held)].sort());
      const realIds = new Set(projectionStepIdMap(inputs, { level: "propose" }).values());
      for (const [token, source] of map) {
        expect(realIds.has(source.stepId), `${name} ${token}`).toBe(true);
        expect(token.startsWith("cmd")).toBe("command" in source);
      }
    }
  });

  it("names the command of a marker and the condition a path ends on", () => {
    const inputs = inputsFor(loadAuto(read("autos/collect-and-score.auto.json")), project());
    const map = projectionTokenMap(inputs, { level: "propose" });
    expect(map.get("cmd2")).toEqual({ kind: "marker", stepId: "collectFlower", markerIndex: 0, command: { name: "intakeOn" } });
    expect(map.get("cond1")).toEqual({ kind: "endCondition", stepId: "collectFlower", condition: "hopperFull" });
    expect(map.get("cond2")).toEqual({ kind: "waitUntil", stepId: "waitForFull", condition: "hopperFull" });
    // The garden sweep's marker and end condition get their own tokens, numbered after the flower's.
    expect(map.get("cmd5")).toEqual({ kind: "marker", stepId: "sweepGarden", markerIndex: 0, command: { name: "intakeOn" } });
    expect(map.get("cond3")).toEqual({ kind: "endCondition", stepId: "sweepGarden", condition: "hopperFull" });
    expect(projectionTokenMap(inputs, { level: "view" }).size).toBe(0);
  });
});

describe("projectShare: determinism and canonical form", () => {
  for (const level of LEVELS) {
    it(`gives byte-identical canonical text for the same inputs (${level})`, () => {
      for (const name of AUTOS) {
        const first = canonicalize("projection", projectExample(name, { level }).projection);
        const second = canonicalize("projection", projectExample(name, { level }).projection);
        expect(second).toBe(first);
      }
    });

    it(`round-trips byte-identically through parse and canonicalize (${level})`, () => {
      for (const name of AUTOS) {
        const { projection } = projectExample(name, { level, title: "Shared auto" });
        const text = canonicalize("projection", projection);
        const reparsed = parseProjection(JSON.parse(text));
        expect(canonicalize("projection", reparsed)).toBe(text);
        // Every number is already at canonical precision, so writing loses nothing.
        expect(JSON.parse(text)).toEqual(projection);
      }
    });
  }
});

describe("projectShare: the timed layer", () => {
  it("samples the trajectory every 0.1 s from t = 0, rounded to 0.5 in and 1 degree", () => {
    const { projection } = projectExample("collect-and-score", { level: "view" });
    const { trajectory } = projection;
    expect(trajectory.rateHz).toBe(10);
    expect(trajectory.positionQuantumIn).toBe(0.5);
    expect(trajectory.headingQuantumRad).toBe(0.0175);
    expect(trajectory.poses.length).toBe(Math.floor(projection.totalS * 10 + 1e-6) + 1);
    const degree = Math.PI / 180;
    for (const [xIn, yIn, headingRad] of trajectory.poses) {
      expect(Number.isInteger(xIn * 2)).toBe(true);
      expect(Number.isInteger(yIn * 2)).toBe(true);
      expect(Math.abs(headingRad / degree - Math.round(headingRad / degree))).toBeLessThan(0.01);
    }
    const [x0, y0, h0] = trajectory.poses[0] as [number, number, number];
    expect({ xIn: x0, yIn: y0, headingRad: h0 }).toEqual(projection.startPose);
  });

  it("coarsens to 2 in and 5 degrees at the same 10 Hz rate", () => {
    const fine = projectExample("cycle-and-park", { level: "view" }).projection;
    const { projection } = projectExample("cycle-and-park", { level: "view", coarsen: true });
    expect(projection.trajectory.rateHz).toBe(10);
    expect(projection.trajectory.positionQuantumIn).toBe(2);
    expect(projection.trajectory.headingQuantumRad).toBe(0.0873);
    for (const [xIn, yIn] of projection.trajectory.poses) {
      expect(Number.isInteger(xIn / 2)).toBe(true);
      expect(Number.isInteger(yIn / 2)).toBe(true);
    }
    for (const phase of projection.phases) {
      expect(Number.isInteger(phase.startS * 4)).toBe(true);
      expect(Number.isInteger(phase.endS * 4)).toBe(true);
    }
    expect(projection.trajectory.poses.length).toBe(fine.trajectory.poses.length);
  });

  it("carries one bounding box that holds the expanded footprint and every mouth", () => {
    const { robot } = project();
    const { projection } = projectExample("first-auto", { level: "view" });
    const box = projection.boundingBox;
    const halfLength = box.lengthIn / 2;
    const halfWidth = box.widthIn / 2;
    const inside = (xIn: number, yIn: number): boolean =>
      Math.abs(xIn - box.centreOffsetIn.xIn) <= halfLength + 1e-9 && Math.abs(yIn - box.centreOffsetIn.yIn) <= halfWidth + 1e-9;
    expect(box.lengthIn).toBeGreaterThanOrEqual(robot.footprint.expandedIn.lengthIn);
    expect(box.widthIn).toBeGreaterThanOrEqual(robot.footprint.expandedIn.widthIn);
    expect((robot.mouths ?? []).length).toBeGreaterThan(0);
    for (const mouth of robot.mouths ?? []) {
      const alongX = mouth.side === "FRONT" || mouth.side === "BACK";
      const halfX = (alongX ? mouth.depthIn : mouth.widthIn) / 2;
      const halfY = (alongX ? mouth.widthIn : mouth.depthIn) / 2;
      expect(inside(mouth.offsetIn.xIn + halfX, mouth.offsetIn.yIn + halfY)).toBe(true);
      expect(inside(mouth.offsetIn.xIn - halfX, mouth.offsetIn.yIn - halfY)).toBe(true);
    }
  });

  it("labels phases from the fixed list: drive, score from a launch, collect from a collection, park by id", () => {
    const { projection } = projectExample("cycle-and-park", { level: "view" });
    const labels = projection.phases.map((phase) => phase.label);
    for (const label of labels) expect(PROJECTION_PHASE_LABELS).toContain(label);
    expect(labels).toContain("drive");
    expect(labels).toContain("score");
    expect(labels).toContain("collect");
    expect(labels[labels.length - 1]).toBe("park");
    for (const [index, phase] of projection.phases.entries()) {
      expect(phase.endS).toBeGreaterThan(phase.startS);
      const next = projection.phases[index + 1];
      if (next !== undefined) {
        expect(next.startS).toBeGreaterThanOrEqual(phase.endS);
        expect(next.label === phase.label && next.startS === phase.endS).toBe(false);
      }
    }
    expect(projection.totalS).toBeGreaterThanOrEqual(projection.phases[projection.phases.length - 1]?.endS ?? 0);
  });

  it("keeps a park that a closing command follows, and never calls a step park by id alone", () => {
    const files = project();
    const auto = loadAuto(read("autos/first-auto.auto.json"));
    const closing: Auto = { ...auto, steps: [...auto.steps, { id: "stopAll", kind: "command", name: "intakeOff" }] };
    const labels = projectShare(inputsFor(closing, files), { level: "view" }).phases.map((phase) => phase.label);
    // The one-tick intakeOff after the park path does not stop that path being the park.
    expect(labels.slice(-2)).toEqual(["park", "other"]);

    // A step called park that is not the last thing to drive is only a drive.
    const early: Auto = {
      ...auto,
      steps: auto.steps.map((step) => (step.id === "driveOut" ? { ...step, id: "parkFirst" } : step)),
    };
    const earlyLabels = projectShare(inputsFor(early, files), { level: "view" }).phases.map((phase) => phase.label);
    expect(earlyLabels[0]).toBe("drive");
  });

  it("claims the containers the ledger takes from, and the targets it scores into", () => {
    const view = projectExample("collect-and-score", { level: "view" }).projection;
    // The flower is taken from before the garden line, so its claim comes first.
    expect(view.claims).toEqual([
      expect.objectContaining({ elementId: "flower1", action: "take" }),
      expect.objectContaining({ elementId: "gardenRed", action: "take" }),
    ]);

    // With a season that names the current target, every launch becomes a score claim.
    const files = project();
    const scoring: SeasonRules = { ...noSeasonRules, currentTarget: () => "hiveRed" };
    const auto = loadAuto(read("autos/collect-and-score.auto.json"));
    const projection = projectShare(inputsFor(auto, files, scoring), { level: "view" });
    const scores = projection.claims.filter((claim) => claim.action === "score");
    expect(scores.map((claim) => claim.elementId)).toEqual(["hiveRed", "hiveRed", "hiveRed"]);
    const times = projection.claims.map((claim) => claim.atS);
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // A target that is not in the field file is the author's own text and is not carried.
    const invented: SeasonRules = { ...noSeasonRules, currentTarget: () => "ourSecretPlan" };
    const scrubbed = projectShare(inputsFor(auto, files, invented), { level: "view" });
    expect(JSON.stringify(scrubbed)).not.toContain("ourSecretPlan");
  });

  it("reads an envelope off a step defensively and carries its polygon and window, never its provenance", () => {
    const files = project();
    const auto = loadAuto(read("autos/cycle-and-park.auto.json"));
    const polygon = [
      { xIn: -72, yIn: -48 },
      { xIn: -36, yIn: -48 },
      { xIn: -36, yIn: -12 },
      { xIn: -72, yIn: -12 },
    ];
    const withEnvelope: Auto = {
      ...auto,
      steps: auto.steps.map((step) =>
        step.id === "collect"
          ? ({ ...step, envelope: { polygon, maxDurationS: 6, provenance: "SET BY HAND: secret envelope note" } } as unknown as Step)
          : step,
      ),
    };
    const inputs = inputsFor(withEnvelope, files);
    const projection = projectShare(inputs, { level: "propose" });
    const record = inputs.trace.steps.find((step) => step.id === "collect");
    expect(record).toBeDefined();
    expect(projection.envelopes).toEqual([
      { startS: Number(record?.startS.toFixed(3)), endS: Number(((record?.startS ?? 0) + 6).toFixed(3)), polygon },
    ]);
    expect(JSON.stringify(projection)).not.toContain("secret envelope note");

    // A malformed envelope is ignored rather than trusted.
    const broken: Auto = {
      ...auto,
      steps: auto.steps.map((step) =>
        step.id === "collect" ? ({ ...step, envelope: { polygon: [{ xIn: "x" }], maxDurationS: -1 } } as unknown as Step) : step,
      ),
    };
    expect(projectShare(inputsFor(broken, files), { level: "view" }).envelopes).toEqual([]);
  });

  it("builds the result as a new object and leaves its inputs alone", () => {
    const files = project();
    const auto = loadAuto(read("autos/all-step-kinds.auto.json"));
    const inputs = inputsFor(auto, files);
    const before = JSON.stringify([inputs.plan.auto, inputs.trace.steps, inputs.robot]);
    projectShare(inputs, { level: "propose", coarsen: true });
    expect(JSON.stringify([inputs.plan.auto, inputs.trace.steps, inputs.robot])).toBe(before);
  });
});

/** Every step in an authored auto, group members and branch arms included. */
function allAuthoredSteps(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => {
    switch (step.kind) {
      case "sequence":
      case "parallel":
        return [step, ...allAuthoredSteps(step.steps)];
      case "branch":
        return [step, ...allAuthoredSteps(step.then), ...allAuthoredSteps(step.else ?? [])];
      default:
        return [step];
    }
  });
}
