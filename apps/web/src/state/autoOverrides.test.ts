/**
 * An auto may name its own robot and field (finding 23), and derive() plans and checks it against
 * them. Issue #403: the Inspector's commands and conditions, the Timeline's auto budget, the Ledger's
 * capacity and a proposal's period read the project's instead, so they disagreed with the findings
 * for such an auto. They now read `autoRobotOf` and `autoFieldOf`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, loadRobot } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import type { Project } from "../project/types";
import { autoFieldOf, autoRobotOf } from "./store";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));
const project = { robot, field } as unknown as Project;

const ownRobot = { ...robot, capacity: { ...robot.capacity, max: 99 } } as typeof robot;
const ownField = { ...field, periods: { ...field.periods, autoS: 15 } } as typeof field;

describe("the robot and field an auto runs with", () => {
  it("are the auto's own when it names them", () => {
    expect(autoRobotOf({ autoRobot: ownRobot, project })).toBe(ownRobot);
    expect(autoFieldOf({ autoField: ownField, project })?.periods?.autoS).toBe(15);
  });

  it("are the project's when the auto names none, and none without a project", () => {
    expect(autoRobotOf({ autoRobot: null, project })).toBe(robot);
    expect(autoFieldOf({ autoField: null, project })).toBe(field);
    expect(autoRobotOf({ autoRobot: null, project: null })).toBeNull();
    expect(autoFieldOf({ autoField: null, project: null })).toBeNull();
  });
});

describe("the panels that showed the project's robot or field (issue #403)", () => {
  const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it.each([
    ["../panels/Inspector.tsx", /const robot = project\?\.robot\b/],
    ["../panels/LedgerPanel.tsx", /project\?\.robot\.capacity/],
    ["../panels/Timeline.tsx", /project\?\.field\.periods/],
    ["../github/actions.ts", /project\.field\.periods/],
  ])("%s reads the auto's own", (file, projectRead) => {
    const text = source(file);
    expect(text).not.toMatch(projectRead);
    expect(text).toMatch(/auto(Robot|Field)Of\(/);
  });
});
