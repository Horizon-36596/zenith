/**
 * Host mode's backend (site/docs/host-protocol.md): an `open` message becomes a `Project` with a
 * synthesized `zenith.json`, the autos keep the host's own names on the way back, Save goes
 * through the channel and only counts once the host answers, and a new auto starts from core's
 * template and stays unsaved until it is sent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { seasonFor } from "@horizon36596/zenith-seasons";
import type { Heading, Waypoints } from "@horizon36596/zenith-schema";
import { derive } from "../state/derived";
import {
  HostBackend,
  buildHostProject,
  fileNameForHostAuto,
  freshAutoName,
  newAutoStart,
  newHostAuto,
  type HostChannel,
} from "./hostBackend";
import { HOSTS, type HostInfo } from "./hostOrigins";
import { HOST_PROTOCOL, type HostOpenMessage } from "./hostProtocol";

const dsim = HOSTS["dsim"] as HostInfo;

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

function openMessage(patch: Partial<HostOpenMessage["project"]> = {}, open?: string): HostOpenMessage {
  return {
    type: "open",
    protocol: HOST_PROTOCOL,
    project: {
      name: "starter",
      robot: JSON.parse(read("autos/robot.json")) as Record<string, unknown>,
      field: read("autos/field/biobuzz.field.json"),
      waypoints: read("autos/waypoints.json"),
      autos: { "first-auto": read("autos/first-auto.auto.json"), "collect-and-score": read("autos/collect-and-score.auto.json") },
      ...patch,
    },
    ...(open === undefined ? {} : { open }),
  };
}

/** A channel that records every save and answers as told. */
function fakeChannel(answer: (name: string) => Promise<void> = () => Promise.resolve()) {
  const sent: { name: string; text: string }[] = [];
  const channel: HostChannel = {
    save: (name, text) => {
      sent.push({ name, text });
      return answer(name);
    },
  };
  return { sent, channel };
}

describe("buildHostProject", () => {
  it("synthesizes the link file and lists the autos under .auto.json names", () => {
    const { project, hostNames, preferred } = buildHostProject(openMessage({}, "first-auto"), dsim);
    expect(project.source).toEqual({ kind: "host", hostId: "dsim" });
    expect(project.link.autosDir).toBe("autos");
    expect(project.link.robot).toBe("autos/robot.json");
    expect(project.link.field).toBe("autos/field.json");
    expect(project.link.waypoints).toBe("autos/waypoints.json");
    expect(project.link.sim).toBeUndefined();
    expect(project.autoFiles).toEqual(["collect-and-score.auto.json", "first-auto.auto.json"]);
    expect(hostNames.get("first-auto.auto.json")).toBe("first-auto");
    expect(preferred).toBe("first-auto.auto.json");
    expect(project.name).toBe("starter");
  });

  it("uses the host's label as the project name, and leaves waypoints out when none came", () => {
    const { project } = buildHostProject(openMessage({ hostLabel: "Build 3", waypoints: undefined }), dsim);
    expect(project.name).toBe("Build 3");
    expect(project.link.waypoints).toBeUndefined();
    expect(project.waypoints).toBeUndefined();
  });

  it("names the file that is wrong when the robot, field or waypoints do not load", () => {
    expect(() => buildHostProject(openMessage({ robot: "{nope" }), dsim)).toThrow(/robot is not valid JSON/);
    expect(() => buildHostProject(openMessage({ robot: { name: "x" } }), dsim)).toThrow(/robot is not a valid Zenith file/);
    expect(() => buildHostProject(openMessage({ field: {} }), dsim)).toThrow(/field is not a valid Zenith file/);
    expect(() => buildHostProject(openMessage({ waypoints: "[]" }), dsim)).toThrow(/waypoints file/);
  });

  it("refuses two host names that become the same file", () => {
    const text = read("autos/first-auto.auto.json");
    expect(() => buildHostProject(openMessage({ autos: { "first-auto": text, "first-auto.auto.json": text } }), dsim)).toThrow(
      /both become first-auto.auto.json/,
    );
  });

  it("ignores an open that names an auto the host did not send", () => {
    expect(buildHostProject(openMessage({}, "missing"), dsim).preferred).toBeUndefined();
  });
});

describe("HostBackend", () => {
  it("reads an auto as canonical text, and saves through the channel under the host's name", async () => {
    const { project, hostNames } = buildHostProject(openMessage(), dsim);
    const { sent, channel } = fakeChannel();
    const backend = new HostBackend(project, hostNames, channel, "DSIM");
    await backend.open();

    const loaded = await backend.readAuto("first-auto.auto.json");
    expect(loaded.canonical).toBe(canonicalize("auto", loadAuto(JSON.parse(read("autos/first-auto.auto.json")))));

    const result = await backend.save("first-auto.auto.json", loaded.canonical);
    expect(sent).toEqual([{ name: "first-auto", text: loaded.canonical }]);
    expect(result).toEqual({ text: loaded.canonical, savedMessage: "Saved to DSIM." });
  });

  it("keeps the old text when the host refuses the save", async () => {
    const { project, hostNames } = buildHostProject(openMessage(), dsim);
    const before = project.autoTexts["first-auto.auto.json"];
    const { channel } = fakeChannel(() => Promise.reject(new Error("DSIM did not save first-auto: full")));
    const backend = new HostBackend(project, hostNames, channel, "DSIM");
    await backend.open();
    await expect(backend.save("first-auto.auto.json", "{}\n")).rejects.toThrow(/full/);
    expect(project.autoTexts["first-auto.auto.json"]).toBe(before);
  });

  it("resolves the host's robot and field for an auto's own robot and field paths, and nothing else", async () => {
    const { project, hostNames } = buildHostProject(openMessage(), dsim);
    const backend = new HostBackend(project, hostNames, fakeChannel().channel, "DSIM");
    await backend.open();
    expect(JSON.parse(await backend.readText("autos/robot.json"))).toEqual(project.robot);
    expect(JSON.parse(await backend.readText("autos/field/biobuzz.field.json"))).toEqual(project.field);
    await expect(backend.readText("autos/other-robot.json")).rejects.toThrow(/not a file this project has/);
  });

  it("names a new auto in the host's own style", async () => {
    const bare = buildHostProject(openMessage(), dsim);
    const suffixed = buildHostProject(
      openMessage({ autos: { "first-auto.auto.json": read("autos/first-auto.auto.json") } }),
      dsim,
    );
    const empty = buildHostProject(openMessage({ autos: {} }), dsim);
    expect(new HostBackend(bare.project, bare.hostNames, fakeChannel().channel, "DSIM").hostNameOf("new-auto.auto.json")).toBe("new-auto");
    expect(new HostBackend(suffixed.project, suffixed.hostNames, fakeChannel().channel, "DSIM").hostNameOf("new-auto.auto.json")).toBe(
      "new-auto.auto.json",
    );
    expect(new HostBackend(empty.project, empty.hostNames, fakeChannel().channel, "DSIM").hostNameOf("new-auto.auto.json")).toBe("new-auto");
    expect(new HostBackend(bare.project, bare.hostNames, fakeChannel().channel, "DSIM").fileNameOf("first-auto")).toBe(
      "first-auto.auto.json",
    );
  });

  it("keeps a new auto unsaved until the host has it", async () => {
    const { project, hostNames } = buildHostProject(openMessage({ autos: {} }), dsim);
    const { sent, channel } = fakeChannel();
    const backend = new HostBackend(project, hostNames, channel, "DSIM");
    await backend.open();

    const { fileName, auto } = newHostAuto(project, tangent);
    const text = canonicalize("auto", auto);
    backend.addAuto(fileName, text, { unsent: true });
    expect(project.autoFiles).toEqual(["new-auto.auto.json"]);
    expect((await backend.readAuto(fileName)).canonical).toBe("");

    await backend.save(fileName, text);
    expect(sent).toEqual([{ name: "new-auto", text }]);
    expect(backend.isUnsent(fileName)).toBe(false);
    expect((await backend.readAuto(fileName)).canonical).toBe(text);
  });
});

/** What a person who chose Tangent gets, as the editor's helper would build it. */
const tangent = (): Heading => ({ mode: "tangent" });

describe("a new auto", () => {
  it("gives its first path the heading the person's setting builds, from the start's own heading, not core's Tangent (issue #435)", () => {
    const { project } = buildHostProject(openMessage({ waypoints: undefined, autos: {} }), dsim);
    const calls: Array<[number, number]> = [];
    const { auto } = newHostAuto(project, (arrivalRad, endRad) => {
      calls.push([arrivalRad, endRad]);
      return { mode: "linear", fromRad: arrivalRad, toRad: endRad };
    });
    const start = newAutoStart(project).pose as { headingRad: number };
    expect(calls).toEqual([[start.headingRad, start.headingRad]]);
    const first = auto.steps[0];
    expect(first?.kind === "path" && first.heading).toEqual({ mode: "linear", fromRad: start.headingRad, toRad: start.headingRad });
  });


  it("gives its first path the person's heading from 0 when the start's pose does not resolve (issue #435)", () => {
    const { project: loaded } = buildHostProject(openMessage({ autos: {} }), dsim);
    // The loader requires a heading on every waypoint, so a start that names one without is built past it.
    const waypoints = { ...loaded.waypoints, waypoints: { start: { xIn: -60, yIn: -36, provenance: "PLACEHOLDER: test" } } } as unknown as Waypoints;
    const project = { ...loaded, waypoints };
    const calls: Array<[number, number]> = [];
    const { auto } = newHostAuto(project, (arrivalRad, endRad) => {
      calls.push([arrivalRad, endRad]);
      return { mode: "constant", headingRad: 0.5 };
    });
    expect(calls).toEqual([[0, 0]]);
    const first = auto.steps[0];
    expect(first?.kind === "path" && first.heading).toEqual({ mode: "constant", headingRad: 0.5 });
  });

  it("takes a fresh name", () => {
    expect(freshAutoName([])).toBe("new-auto");
    expect(freshAutoName(["new-auto.auto.json"])).toBe("new-auto-2");
    expect(freshAutoName(["new-auto.auto.json", "new-auto-2.auto.json"])).toBe("new-auto-3");
    expect(fileNameForHostAuto("new-auto")).toBe("new-auto.auto.json");
    expect(fileNameForHostAuto("a.auto.json")).toBe("a.auto.json");
  });

  it("starts at a start waypoint when there is one, with the field's preload", () => {
    const { project } = buildHostProject(openMessage(), dsim);
    const start = newAutoStart(project);
    expect(start.pose).toEqual({ ref: "start" });
    expect(start.holds).toEqual(project.field.startRules?.holds);
  });

  it("falls back to the first waypoint whose name says it is a start", () => {
    const pose = { xIn: -60, yIn: -36, headingRad: 0, provenance: "PLACEHOLDER: test" };
    const waypoints = { $schema: "https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json", formatVersion: 1, waypoints: { shoot: pose, farStart: pose } };
    const { project } = buildHostProject(openMessage({ waypoints }), dsim);
    expect(newAutoStart(project).pose).toEqual({ ref: "farStart" });
  });

  it("starts at a legal pose for the field's alliance when there is no waypoint to start from", () => {
    const { project } = buildHostProject(openMessage({ waypoints: undefined }), dsim);
    const start = newAutoStart(project);
    const pose = start.pose as { xIn: number; yIn: number; headingRad: number; provenance?: string };
    expect(pose.xIn === 0 && pose.yIn === 0).toBe(false);
    expect(pose.provenance).toMatch(/^NEEDS MEASUREMENT: a legal RED start /);
    expect(seasonFor(project.field).startLegal(project.field, pose, project.robot, "RED")).toEqual([]);
  });

  it("opens with no error finding: a legal start and a path straight out from it", () => {
    const { project } = buildHostProject(openMessage({ waypoints: undefined, autos: {} }), dsim);
    const { auto } = newHostAuto(project, tangent);
    const findings = derive(auto, project.robot, project.field, project.waypoints).findings;
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
    const first = auto.steps[0];
    expect(first?.kind === "path" && first.segments[0]?.to).toMatchObject({ xIn: -12, yIn: -39 });
  });

  it("falls back to the labelled centre placeholder when the field has no start rule", () => {
    const field = JSON.parse(read("autos/field/biobuzz.field.json")) as Record<string, unknown>;
    delete field["startRules"];
    const { project } = buildHostProject(openMessage({ waypoints: undefined, field }), dsim);
    const start = newAutoStart(project);
    expect(start.pose).toMatchObject({ xIn: 0, yIn: 0, headingRad: 0 });
    expect((start.pose as { provenance?: string }).provenance).toMatch(/^PLACEHOLDER: /);
  });

  it("starts where the host's robot starts when the host offers a start, ahead of a start waypoint (sweep W4-7)", () => {
    const { project } = buildHostProject(openMessage(), dsim);
    const alliance = project.field.frame.canonicalAlliance;
    const start = newAutoStart(project, { alliance, xIn: -34, yIn: -63.17, headingRad: Math.PI / 2 }, "DSIM");
    expect(start.pose).toEqual({
      xIn: -34,
      yIn: -63.17,
      headingRad: 1.5708,
      provenance: "SET BY HAND: the start picked in DSIM when this auto was made",
    });
    expect(start.holds).toEqual(project.field.startRules?.holds);
  });

  it("mirrors a start the host offers for the other alliance onto the field's own alliance", () => {
    const { project } = buildHostProject(openMessage({ waypoints: undefined, autos: {} }), dsim);
    const alliance = project.field.frame.canonicalAlliance;
    const other = alliance === "RED" ? "BLUE" : "RED";
    const own = newAutoStart(project, { alliance, xIn: -34, yIn: -63.17, headingRad: Math.PI / 2 }, "DSIM").pose as { xIn: number; yIn: number; headingRad: number };
    // the same robot seen from the other side of BIOBUZZ's point symmetry
    const mirrored = newAutoStart(project, { alliance: other, xIn: 34, yIn: 63.17, headingRad: -Math.PI / 2 }, "DSIM").pose as {
      xIn: number;
      yIn: number;
      headingRad: number;
      provenance: string;
    };
    expect([mirrored.xIn, mirrored.yIn, mirrored.headingRad]).toEqual([own.xIn, own.yIn, own.headingRad]);
    expect(mirrored.provenance).toBe(`SET BY HAND: the ${other} start picked in DSIM when this auto was made, mirrored for ${alliance}`);
    const { auto } = newHostAuto(project, tangent, { alliance: other, xIn: 34, yIn: 63.17, headingRad: -Math.PI / 2 }, "DSIM");
    expect(auto.alliance).toBe(alliance);
    // the first path still drives straight out the way that start faces
    const first = auto.steps[0];
    expect(first?.kind === "path" && first.segments[0]?.to).toMatchObject({ xIn: -34, yIn: -39.17 });
  });

  it("is a valid auto from core's template, on the field's own alliance", () => {
    const { project } = buildHostProject(openMessage({ autos: {} }), dsim);
    const { fileName, auto } = newHostAuto(project, tangent);
    expect(fileName).toBe("new-auto.auto.json");
    expect(auto.name).toBe("new-auto");
    expect(auto.alliance).toBe(project.field.frame.canonicalAlliance);
    expect(loadAuto(JSON.parse(canonicalize("auto", auto)))).toEqual(auto);
  });
});
