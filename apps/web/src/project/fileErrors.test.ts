/**
 * What Zenith says about a project file that does not load (the 0.1.2 UX sweep, W3-4 and W3-5): the
 * file's path, what is wrong with it, and what to do, in one or two plain sentences.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { FORMAT_VERSIONS } from "@horizon36596/zenith-schema";
import { DesktopBackend } from "./desktop";
import type { ZenithDesktopBridge } from "./desktopBridge";
import { projectFromFiles } from "./fallback";
import {
  ProjectFileError,
  jsonErrorPlace,
  loadProjectFile,
  missingFileMessage,
  newerFormatMessage,
  notJsonMessage,
  parseProjectJson,
  tooLargeFileMessage,
  unreadableJsonMessage,
} from "./fileErrors";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const thrown = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("It did not throw.");
};

describe("project file errors", () => {
  it("names a file that is not valid JSON, with its line and column, and says what to do", () => {
    const error = thrown(() => parseProjectJson("autos/robot.json", "{ x: 1 }"));
    expect(error).toBeInstanceOf(ProjectFileError);
    expect(error.message).toBe("autos/robot.json is not valid JSON (line 1, column 3). Fix it, or restore it from git.");
    expect((error as ProjectFileError).path).toBe("autos/robot.json");
  });

  it("finds the line and column in each browser's wording, and from a bare position", () => {
    const text = '{\n  "a": 1,\n  oops\n}';
    expect(jsonErrorPlace(text, new SyntaxError("Expected property name or '}' in JSON at position 2 (line 1 column 3)"))).toEqual({ line: 1, column: 3 });
    expect(jsonErrorPlace(text, new SyntaxError("JSON.parse: expected double-quoted property name at line 3 column 3 of the JSON data"))).toEqual({ line: 3, column: 3 });
    expect(jsonErrorPlace(text, new SyntaxError("Unexpected token o in JSON at position 14"))).toEqual({ line: 3, column: 3 });
    expect(jsonErrorPlace("{", new SyntaxError("Unexpected end of JSON input"))).toEqual({ line: 1, column: 2 });
    expect(jsonErrorPlace("{", new SyntaxError("JSON Parse error: Unexpected EOF"))).toEqual({ line: 1, column: 2 });
  });

  it("never reads a place out of the snippet Chromium quotes from the file", () => {
    const text = '{"note": "at position 3 (line 9 column 9) unexpected end"} x';
    const snippet = new SyntaxError(`Unexpected token 'x', "${text}" is not valid JSON`);
    expect(jsonErrorPlace(text, snippet)).toBeNull();
    expect(notJsonMessage("autos/robot.json", text, snippet)).toBe("autos/robot.json is not valid JSON. Fix it, or restore it from git.");
    // The real place, when Chromium gives one, is at the end of its message.
    const placed = new SyntaxError(`Unexpected non-whitespace character after JSON at position 59 (line 1 column 60)`);
    expect(jsonErrorPlace(text, placed)).toEqual({ line: 1, column: 60 });
    expect(notJsonMessage("zenith.json", text, new SyntaxError("JSON Parse error: Expected '}'"))).toBe(
      "zenith.json is not valid JSON. Fix it, or restore it from git.",
    );
  });

  it("names the file and the value a schema refuses, not the schema's whole list", () => {
    const waypoints = JSON.parse(read("autos/waypoints.json")) as { waypoints: Record<string, { xIn: unknown }> };
    const [name] = Object.keys(waypoints.waypoints);
    (waypoints.waypoints[name as string] as { xIn: unknown }).xIn = "12";
    const error = thrown(() => loadProjectFile("waypoints", "autos/waypoints.json", JSON.stringify(waypoints), loadWaypoints));
    expect(error.message).toBe(
      `autos/waypoints.json has a value Zenith cannot read, at waypoints.${name as string}.xIn (expected number, received string). Fix it, or restore it from git.`,
    );
  });

  it("counts the values a schema refuses when there is more than one", () => {
    const robot = JSON.parse(read("autos/robot.json")) as Record<string, unknown>;
    delete robot["kinematics"];
    delete robot["footprint"];
    const error = thrown(() => loadProjectFile("robot", "autos/robot.json", JSON.stringify(robot), loadRobot));
    expect(error.message).toMatch(/^autos\/robot\.json has \d+ values Zenith cannot read; the first is at \S+ \(.+\)\. Fix them, or restore the file from git\.$/);
  });

  it("says a file from a newer Zenith needs a newer Zenith", () => {
    const field = JSON.parse(read("autos/field/biobuzz.field.json")) as Record<string, unknown>;
    field["formatVersion"] = 77;
    const error = thrown(() => loadProjectFile("field", "autos/field/biobuzz.field.json", JSON.stringify(field), loadField));
    expect(error.message).toBe(
      `autos/field/biobuzz.field.json was made by a newer Zenith (field format 77; this Zenith reads format ${String(FORMAT_VERSIONS.field)}). Update Zenith to open it.`,
    );
  });

  it("says an empty file is empty, a picture is a picture, and a file that stops part way is cut off", () => {
    const reason = (text: string): string => {
      try {
        JSON.parse(text);
      } catch (error) {
        return unreadableJsonMessage("a.json", text, error, "Next.");
      }
      throw new Error("It parsed.");
    };
    expect(reason("")).toBe("a.json is empty. Next.");
    expect(reason("  \n ")).toBe("a.json is empty. Next.");
    expect(reason("�PNG\r\n\u001a\n\0\0\0\rIHDR")).toBe("a.json is a picture, not a JSON file. Next.");
    expect(reason("GIF89a\u0001\0")).toBe("a.json is a picture, not a JSON file. Next.");
    expect(reason("PK\u0003\u0004\0\0")).toBe("a.json is not a text file, so it is not JSON. Next.");
    expect(reason('{"a": "abc')).toBe("a.json is cut off: the JSON in it stops part way. Next.");
    expect(reason('{"a": [1, 2,\n')).toBe("a.json is cut off: the JSON in it stops part way. Next.");
    expect(reason("{ x: 1 }")).toBe("a.json is not valid JSON (line 1, column 3). Next.");
    // Each browser's words for running out of input.
    const text = '{"a": 1';
    for (const message of ["Unexpected end of JSON input", "JSON Parse error: Unexpected EOF", "JSON.parse: end of data after property value in object at line 1 column 8 of the JSON data", "JSON.parse: unexpected end of data at line 1 column 8 of the JSON data"]) {
      expect(unreadableJsonMessage("a.json", text, new SyntaxError(message), "Next."), message).toBe("a.json is cut off: the JSON in it stops part way. Next.");
    }
  });

  it("says a file is too large with both sizes, and a newer one in the reader's own words", () => {
    expect(tooLargeFileMessage("big.json", 5_000_000, 2_000_000, "a share file", "Check it.")).toBe(
      "big.json is 5.0 MB, larger than the 2.0 MB a share file may be, so it was not read. Check it.",
    );
    expect(newerFormatMessage("p.json", "projection", 99, "share file", "load")).toBe(
      `p.json was made by a newer Zenith (share file format 99; this Zenith reads format ${String(FORMAT_VERSIONS.projection)}). Update Zenith to load it.`,
    );
  });

  it("says which key of zenith.json names a file that is not there", () => {
    expect(missingFileMessage("autos/robot.json", "robot")).toBe(
      'autos/robot.json is not in this folder, but zenith.json\'s "robot" names it. Fix that path in zenith.json, or add the file.',
    );
  });

  it("names the file in picked files and in the desktop app too", async () => {
    const file = (name: string, text: string) => ({ name, text: () => Promise.resolve(text) }) as unknown as File;
    await expect(
      projectFromFiles([
        file("zenith.json", read("zenith.json")),
        file("robot.json", "{ broken"),
        file("biobuzz.field.json", read("autos/field/biobuzz.field.json")),
      ]),
    ).rejects.toThrow(/^robot\.json is not valid JSON \(line 1, column 3\)\. Fix it, or restore it from git\.$/);

    const files: Record<string, string> = {
      "zenith.json": read("zenith.json"),
      "autos/robot.json": read("autos/robot.json"),
      "autos/field/biobuzz.field.json": read("autos/field/biobuzz.field.json"),
      "autos/waypoints.json": read("autos/waypoints.json"),
      "autos/broken.auto.json": "{ ",
    };
    const bridge = {
      project: {
        read: (_root: string, path: string) => Promise.resolve(files[path] as string),
        listAutos: () => Promise.resolve(["broken.auto.json"]),
        watch: () => Promise.resolve(),
      },
    } as unknown as ZenithDesktopBridge;
    const backend = new DesktopBackend(bridge, { root: "C:/repo", name: "repo" });
    await backend.open();
    await expect(backend.readAuto("broken.auto.json")).rejects.toThrow(
      /^autos\/broken\.auto\.json is cut off: the JSON in it stops part way\. Fix it, or restore it from git\.$/,
    );
  });
});
