import { describe, expect, it } from "vitest";
import { SCHEMA_ID } from "./ids.js";
import { isInsideRootPath, javaDirsOf } from "./link.js";
import { parseLink } from "./parse.js";

const link = (extra: Record<string, unknown> = {}): unknown => ({
  $schema: SCHEMA_ID.link,
  formatVersion: 1,
  autosDir: "autos",
  robot: "autos/robot.json",
  field: "autos/field/biobuzz.field.json",
  ...extra,
});

describe("zenith.json's javaDir", () => {
  it("is optional, and a file without it reads as before", () => {
    expect(parseLink(link()).javaDir).toBeUndefined();
    expect(javaDirsOf(parseLink(link()))).toEqual([]);
  });

  it("takes one directory or a list", () => {
    expect(javaDirsOf(parseLink(link({ javaDir: "TeamCode/src/main/java" })))).toEqual(["TeamCode/src/main/java"]);
    expect(javaDirsOf(parseLink(link({ javaDir: ["TeamCode", "../robot/TeamCode"] })))).toEqual(["TeamCode", "../robot/TeamCode"]);
  });

  it("refuses an empty directory or an empty list", () => {
    expect(() => parseLink(link({ javaDir: "" }))).toThrow();
    expect(() => parseLink(link({ javaDir: [] }))).toThrow();
  });
});

describe("zenith.json's sim.server", () => {
  const sim = (server: unknown): unknown =>
    link({ sim: { command: "./gradlew test -Dzenith.auto={auto}", trace: "TeamCode/build/sim/{auto}.trace.json", server } });

  it("is optional, and a sim section without it reads as before", () => {
    expect(parseLink(sim(undefined)).sim?.server).toBeUndefined();
  });

  it("takes the prepare command, the args file, the working folder and the watched paths", () => {
    const server = {
      prepare: "./gradlew :TeamCode:prepareSimServer",
      args: "TeamCode/build/sim/server.args",
      cwd: "TeamCode",
      watch: ["TeamCode/src", "TeamCode/build.gradle"],
    };
    expect(parseLink(sim(server)).sim?.server).toEqual(server);
    expect(parseLink(sim({ prepare: "./gradlew a", args: "a.args" })).sim?.server?.watch).toBeUndefined();
  });

  it("needs a prepare command and an args file", () => {
    expect(() => parseLink(sim({ args: "a.args" }))).toThrow();
    expect(() => parseLink(sim({ prepare: "./gradlew a" }))).toThrow();
  });

  it("refuses a path that leaves the repository", () => {
    for (const bad of ["../server.args", "C:\\server.args", "/etc/server.args", "TeamCode/../../x", "a\\..\\..\\b"]) {
      expect(() => parseLink(sim({ prepare: "./gradlew a", args: bad })), bad).toThrow(/inside the repository/);
      expect(() => parseLink(sim({ prepare: "./gradlew a", args: "a.args", cwd: bad })), bad).toThrow();
      expect(() => parseLink(sim({ prepare: "./gradlew a", args: "a.args", watch: [bad] })), bad).toThrow();
    }
    expect(isInsideRootPath("TeamCode/build/sim/server.args")).toBe(true);
    expect(isInsideRootPath("TeamCode\\src")).toBe(true);
    expect(isInsideRootPath("..hidden/file")).toBe(true);
  });
});
