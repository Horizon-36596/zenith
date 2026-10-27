/**
 * Issue #519: a save still waiting for the host when the session ends is rejected, and the bar and
 * the status line already say the session closed. Save writes no line of its own for it, so the
 * close sentence is not on the screen twice; any other refused save still says why.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionEndedError } from "../project/errors";
import { HostBackend, buildHostProject, type HostChannel } from "../project/hostBackend";
import { HOSTS, type HostInfo } from "../project/hostOrigins";
import { HOST_PROTOCOL } from "../project/hostProtocol";
import { getState, openProject, setStatus } from "../state/store";
import { openAutoNamed, save } from "./projectActions";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

async function openWith(channel: HostChannel): Promise<void> {
  const { project, hostNames } = buildHostProject(
    {
      type: "open",
      protocol: HOST_PROTOCOL,
      project: {
        name: "starter",
        robot: JSON.parse(read("autos/robot.json")) as Record<string, unknown>,
        field: read("autos/field/biobuzz.field.json"),
        waypoints: read("autos/waypoints.json"),
        autos: { "first-auto": read("autos/first-auto.auto.json") },
      },
    },
    HOSTS["dsim"] as HostInfo,
  );
  const backend = new HostBackend(project, hostNames, channel, "DSIM");
  openProject(await backend.open(), backend);
  await openAutoNamed("first-auto.auto.json");
}

describe("a save the session end rejected (issue #519)", () => {
  it("leaves the status line the session end wrote", async () => {
    await openWith({
      save: () => {
        // What `endSession` does: reject the waiting save, then say Save is off.
        const rejected = Promise.reject(new SessionEndedError("DSIM closed this session before the save of first-auto was answered."));
        setStatus("warn", "Save to DSIM is off. Save a copy keeps your edits.");
        return rejected;
      },
    });
    await save();
    expect(getState().status).toMatchObject({ kind: "warn", message: "Save to DSIM is off. Save a copy keeps your edits." });
  });

  it("still says why any other refused save failed", async () => {
    await openWith({ save: () => Promise.reject(new Error("DSIM did not save first-auto: full")) });
    await save();
    expect(getState().status).toMatchObject({ kind: "error", message: "DSIM did not save first-auto: full" });
  });
});
