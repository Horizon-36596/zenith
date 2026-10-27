/**
 * Issue #502 (F8): the line under Set up's robot class follows what is typed there, so a class typed
 * into an empty field is no longer told that there is none.
 */
import { describe, expect, it } from "vitest";
import { robotClassNote } from "./SetupDialog";

const plan = (robotClasses: string[]) => ({ plan: { robotClasses } }) as unknown as Parameters<typeof robotClassNote>[0];
const TEAM_ROBOT = "org.firstinspires.ftc.teamcode.robot.TeamRobot";

describe("robotClassNote", () => {
  it("says the class was found when the field holds the one TeamCode has", () => {
    expect(robotClassNote(plan([TEAM_ROBOT]), TEAM_ROBOT)).toBe("Found in TeamCode: it implements ZenithRobot.");
  });

  it("says what an empty field means, and stops saying it once a class is typed", () => {
    expect(robotClassNote(plan([]), "")).toMatch(/^No class in TeamCode implements ZenithRobot yet\. Leave it empty/);
    expect(robotClassNote(plan([]), "org.team.Robot")).toBe(
      "No class in TeamCode implements ZenithRobot, so Zenith cannot check this one. Set up writes it as typed.",
    );
    expect(robotClassNote(plan([TEAM_ROBOT]), "  ")).toMatch(/^Left empty, zenith\.json then has no codegen section/);
  });

  it("names the class TeamCode has when another is typed, and lists several", () => {
    expect(robotClassNote(plan([TEAM_ROBOT]), "org.team.Other")).toBe(`TeamCode's ZenithRobot is ${TEAM_ROBOT}. Set up writes the class typed here instead.`);
    expect(robotClassNote(plan(["a.A", "b.B"]), "")).toBe("2 classes implement ZenithRobot: a.A, b.B. Type the one that is your robot.");
    expect(robotClassNote(plan(["a.A", "b.B"]), "b.B")).toBe("Found in TeamCode: it implements ZenithRobot.");
  });
});
