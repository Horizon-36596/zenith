/**
 * `parseHostMessage`, the one gate every host message goes through (site/docs/host-protocol.md):
 * the five host messages in their exact shapes, and null for everything else, so a malformed or
 * foreign message can never reach the editor.
 */
import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  RUN_FAILED_REASON_MAX,
  byeMessage,
  isSafeAutoName,
  otherOpenProtocol,
  parseHostMessage,
  readyMessage,
  runMessage,
  saveMessage,
} from "./hostProtocol";

const project = {
  name: "My robot",
  robot: { name: "robot" },
  field: "{}",
  autos: { "first-auto": "{}" },
};

const open = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "open",
  protocol: HOST_PROTOCOL,
  project,
  ...patch,
});

describe("parseHostMessage: open", () => {
  it("accepts a minimal open and copies only the protocol's fields", () => {
    const parsed = parseHostMessage({ ...open(), extra: "ignored", project: { ...project, secret: "x" } });
    expect(parsed).toEqual({ type: "open", protocol: HOST_PROTOCOL, project });
  });

  it("keeps the optional fields when they have the right types", () => {
    const parsed = parseHostMessage(
      open({
        project: { ...project, hostLabel: "Horizon build 3", waypoints: { waypoints: {} } },
        open: "first-auto",
        readOnlyRobot: true,
        capabilities: { simulate: true, other: 1 },
      }),
    );
    expect(parsed).toEqual({
      type: "open",
      protocol: HOST_PROTOCOL,
      project: { ...project, hostLabel: "Horizon build 3", waypoints: { waypoints: {} } },
      open: "first-auto",
      readOnlyRobot: true,
      capabilities: { simulate: true },
    });
  });

  it("keeps the optional newAuto flag and host build, which older hosts leave out", () => {
    const parsed = parseHostMessage(open({ newAuto: true, hostBuild: 42 }));
    expect(parsed).toEqual({ type: "open", protocol: HOST_PROTOCOL, project, newAuto: true, hostBuild: 42 });
    expect(parseHostMessage(open({ newAuto: false, hostBuild: 0 }))).toEqual({
      type: "open",
      protocol: HOST_PROTOCOL,
      project,
      newAuto: false,
      hostBuild: 0,
    });
    // Without them the open is exactly what it was before either field existed.
    expect(parseHostMessage(open())).toEqual({ type: "open", protocol: HOST_PROTOCOL, project });
  });

  it("keeps the optional start for new autos, copying only its four fields", () => {
    const newAutoStart = { alliance: "BLUE", xIn: 34, yIn: 65.4, headingRad: -1.5708 };
    expect(parseHostMessage(open({ newAuto: true, newAutoStart: { ...newAutoStart, note: "dropped" } }))).toEqual({
      type: "open",
      protocol: HOST_PROTOCOL,
      project,
      newAuto: true,
      newAutoStart,
    });
  });

  it.each([
    ["a start with no alliance", { newAutoStart: { xIn: 0, yIn: 0, headingRad: 0 } }],
    ["a start for an alliance that does not exist", { newAutoStart: { alliance: "GREEN", xIn: 0, yIn: 0, headingRad: 0 } }],
    ["a start with a text coordinate", { newAutoStart: { alliance: "RED", xIn: "0", yIn: 0, headingRad: 0 } }],
    ["a start with no heading", { newAutoStart: { alliance: "RED", xIn: 0, yIn: 0 } }],
    ["a start off any field", { newAutoStart: { alliance: "RED", xIn: 5000, yIn: 0, headingRad: 0 } }],
    ["a start at NaN", { newAutoStart: { alliance: "RED", xIn: Number.NaN, yIn: 0, headingRad: 0 } }],
    ["a start that is not an object", { newAutoStart: "start" }],
  ])("drops an open with %s", (_what, patch) => {
    expect(parseHostMessage(open(patch))).toBeNull();
  });

  it.each([
    ["newAuto as a string", { newAuto: "yes" }],
    ["newAuto as a number", { newAuto: 1 }],
    ["hostBuild as a string", { hostBuild: "42" }],
    ["a negative hostBuild", { hostBuild: -1 }],
    ["a fractional hostBuild", { hostBuild: 4.2 }],
    ["an unsafe hostBuild", { hostBuild: 2 ** 60 }],
    ["hostBuild as NaN", { hostBuild: Number.NaN }],
  ])("drops an open with %s", (_what, patch) => {
    expect(parseHostMessage(open(patch))).toBeNull();
  });

  it("serialises an auto sent as an object, since every auto is re-read and canonicalized anyway", () => {
    const parsed = parseHostMessage(open({ project: { ...project, autos: { a: { name: "a" } } } }));
    expect(parsed?.type === "open" ? parsed.project.autos : null).toEqual({ a: '{"name":"a"}' });
  });

  it("keeps an auto named __proto__", () => {
    const autos = JSON.parse('{"__proto__": "{}", "b": "{}"}') as Record<string, string>;
    const parsed = parseHostMessage(open({ project: { ...project, autos } }));
    const kept = parsed?.type === "open" ? parsed.project.autos : {};
    expect(Object.keys(kept)).toEqual(["__proto__", "b"]);
    expect(Object.getOwnPropertyDescriptor(kept, "__proto__")?.value).toBe("{}");
  });

  it("accepts an empty autos map, which opens a new auto", () => {
    const parsed = parseHostMessage(open({ project: { ...project, autos: {} } }));
    expect(parsed?.type).toBe("open");
  });

  it("refuses a missing or different protocol", () => {
    expect(parseHostMessage(open({ protocol: undefined }))).toBeNull();
    expect(parseHostMessage(open({ protocol: "zenith-host/2" }))).toBeNull();
  });

  it("refuses a project with a missing or mistyped part", () => {
    const without = (key: string): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...project };
      delete copy[key];
      return copy;
    };
    expect(parseHostMessage(open({ project: without("name") }))).toBeNull();
    expect(parseHostMessage(open({ project: without("robot") }))).toBeNull();
    expect(parseHostMessage(open({ project: without("field") }))).toBeNull();
    expect(parseHostMessage(open({ project: without("autos") }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, name: "" } }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, robot: 3 } }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, robot: [] } }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, waypoints: null } }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, hostLabel: 7 } }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, autos: [] } }))).toBeNull();
    expect(parseHostMessage(open({ project: { ...project, autos: { a: 1 } } }))).toBeNull();
    expect(parseHostMessage(open({ project: "text" }))).toBeNull();
  });

  it("refuses auto names that would leave the autos folder", () => {
    for (const name of ["../escape", "a/b", "a\\b", "..", ".", "", " ", "tab\there"]) {
      expect(isSafeAutoName(name), JSON.stringify(name)).toBe(false);
      expect(parseHostMessage(open({ project: { ...project, autos: { [name]: "{}" } } }))).toBeNull();
    }
    expect(isSafeAutoName("first-auto.auto.json")).toBe(true);
    expect(isSafeAutoName("Close side 2")).toBe(true);
  });

  it("refuses mistyped options", () => {
    expect(parseHostMessage(open({ open: 3 }))).toBeNull();
    expect(parseHostMessage(open({ readOnlyRobot: "yes" }))).toBeNull();
    expect(parseHostMessage(open({ capabilities: true }))).toBeNull();
    expect(parseHostMessage(open({ capabilities: { simulate: "yes" } }))).toBeNull();
  });
});

describe("parseHostMessage: trace, saved and close", () => {
  it("accepts a trace with an auto name and a trace object", () => {
    const trace = { formatVersion: 1, steps: [] };
    expect(parseHostMessage({ type: "trace", auto: "first-auto", trace })).toEqual({
      type: "trace",
      auto: "first-auto",
      trace,
    });
    expect(parseHostMessage({ type: "trace", auto: "", trace })).toBeNull();
    expect(parseHostMessage({ type: "trace", auto: "a", trace: "text" })).toBeNull();
    expect(parseHostMessage({ type: "trace", auto: "a", trace: [] })).toBeNull();
  });

  it("accepts a saved answer, with an error only when it is text", () => {
    expect(parseHostMessage({ type: "saved", name: "a", ok: true })).toEqual({ type: "saved", name: "a", ok: true });
    expect(parseHostMessage({ type: "saved", name: "a", ok: false, error: "No room" })).toEqual({
      type: "saved",
      name: "a",
      ok: false,
      error: "No room",
    });
    expect(parseHostMessage({ type: "saved", name: "a", ok: "true" })).toBeNull();
    expect(parseHostMessage({ type: "saved", ok: true })).toBeNull();
    expect(parseHostMessage({ type: "saved", name: "a", ok: false, error: 404 })).toBeNull();
  });

  it("accepts runFailed with a reason, and the auto it answers when that is named (sweep W4-2)", () => {
    expect(parseHostMessage({ type: "runFailed", auto: "first-auto", reason: "The auto is formatVersion 4." })).toEqual({
      type: "runFailed",
      auto: "first-auto",
      reason: "The auto is formatVersion 4.",
    });
    expect(parseHostMessage({ type: "runFailed", reason: "  No robot selected  " })).toEqual({
      type: "runFailed",
      reason: "No robot selected",
    });
    // Control characters become spaces, and a page of text is cut to what the status line can show.
    expect(parseHostMessage({ type: "runFailed", reason: "line one\nline two" })).toEqual({
      type: "runFailed",
      reason: "line one line two",
    });
    // A host that does not know which auto failed may send null; the message is kept, with no auto.
    expect(parseHostMessage({ type: "runFailed", auto: null, reason: "Crashed" })).toEqual({ type: "runFailed", reason: "Crashed" });
    const long = parseHostMessage({ type: "runFailed", reason: "x".repeat(RUN_FAILED_REASON_MAX + 50) });
    expect(long?.type === "runFailed" ? long.reason.length : 0).toBe(RUN_FAILED_REASON_MAX);
  });

  it("refuses runFailed without a reason, or with an auto that is not a name", () => {
    expect(parseHostMessage({ type: "runFailed" })).toBeNull();
    expect(parseHostMessage({ type: "runFailed", reason: "   " })).toBeNull();
    expect(parseHostMessage({ type: "runFailed", reason: 500 })).toBeNull();
    expect(parseHostMessage({ type: "runFailed", auto: "", reason: "no" })).toBeNull();
    expect(parseHostMessage({ type: "runFailed", auto: 3, reason: "no" })).toBeNull();
    expect(parseHostMessage({ type: "runFailed", protocol: "other/1", reason: "no" })).toBeNull();
  });

  it("accepts close, and a protocol field on any message only when it is this protocol", () => {
    expect(parseHostMessage({ type: "close" })).toEqual({ type: "close" });
    expect(parseHostMessage({ type: "close", protocol: HOST_PROTOCOL })).toEqual({ type: "close" });
    expect(parseHostMessage({ type: "close", protocol: "other/1" })).toBeNull();
  });

  it("refuses anything that is not a host message", () => {
    for (const data of [null, undefined, 1, "open", [], {}, { type: "ready" }, { type: "save" }, { type: "bye" }]) {
      expect(parseHostMessage(data), JSON.stringify(data)).toBeNull();
    }
  });
});

describe("Zenith's own messages", () => {
  it("are the protocol's shapes exactly", () => {
    expect(readyMessage()).toEqual({ type: "ready", protocol: "zenith-host/1" });
    expect(saveMessage("a", "{}\n")).toEqual({ type: "save", name: "a", text: "{}\n" });
    expect(runMessage("a", "{}\n")).toEqual({ type: "run", name: "a", text: "{}\n" });
    expect(byeMessage()).toEqual({ type: "bye" });
  });
});

describe("otherOpenProtocol", () => {
  it("names the protocol of an open this build does not speak", () => {
    expect(otherOpenProtocol({ type: "open", protocol: "zenith-host/2", project })).toBe("zenith-host/2");
    expect(parseHostMessage({ type: "open", protocol: "zenith-host/2", project })).toBeNull();
  });

  it("is null for this protocol, for other messages and for no protocol at all", () => {
    expect(otherOpenProtocol({ type: "open", protocol: HOST_PROTOCOL, project })).toBeNull();
    expect(otherOpenProtocol({ type: "saved", protocol: "zenith-host/2", name: "a", ok: true })).toBeNull();
    expect(otherOpenProtocol({ type: "open", project })).toBeNull();
    expect(otherOpenProtocol("open")).toBeNull();
  });

  it("never returns text too long or unprintable to show", () => {
    expect(otherOpenProtocol({ type: "open", protocol: "x".repeat(41) })).toBeNull();
    expect(otherOpenProtocol({ type: "open", protocol: "zenith\nhost" })).toBeNull();
    expect(otherOpenProtocol({ type: "open", protocol: "   " })).toBeNull();
  });
});
