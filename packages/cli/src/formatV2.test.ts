import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FINDING_HELP } from "@horizon36596/zenith-core";
import { parseField } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runValidate } from "./commands/validate.js";
import { fieldImageFor, imageSizePx } from "./fieldImage.js";
import { loadProject } from "./project.js";
import { autoSkeleton } from "./skeletons.js";
import { makeProject, simpleAuto, TEST_FIELD, writeAuto } from "./testSupport.js";

/** Items 1, 4 and 5 as the CLI sees them: v1 and v2 in, v2 out, `--explain`, the field image. */

let root = "";
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-v2-"));
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("format version 2 in the CLI", () => {
  it("validates a v1 auto and a v2 auto with a sequence the same way", () => {
    makeProject(root);
    writeAuto(root, "autos", "old", simpleAuto("old"));
    writeAuto(
      root,
      "autos",
      "new",
      simpleAuto("new", {
        formatVersion: 2,
        steps: [
          {
            id: "grp",
            kind: "sequence",
            steps: [
              {
                id: "drive",
                kind: "path",
                segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
                heading: { mode: "tangent" },
                speedFraction: 0.8,
              },
              { id: "shoot1", kind: "command", name: "shootAll", args: { count: 3 } },
            ],
          },
        ],
      }),
    );
    const code = runValidate(["autos/old.auto.json", "autos/new.auto.json"], { json: true, cwd: root });
    const parsed = JSON.parse(out.join("")) as { files: { findings: { code: string }[] }[] };
    const codes = parsed.files.map((file) => file.findings.map((finding) => finding.code).sort());
    expect(codes[0]).toEqual(codes[1]);
    expect(code).toBe(0);
  });

  it("writes a new auto at the current formatVersion", () => {
    expect(JSON.parse(autoSkeleton("fresh")) as { formatVersion: number }).toMatchObject({ formatVersion: 3 });
  });
});

describe("validate --explain", () => {
  const brokenProject = (): void => {
    makeProject(root);
    writeAuto(
      root,
      "autos",
      "gap",
      simpleAuto("gap", {
        steps: [
          {
            id: "jump",
            kind: "path",
            segments: [{ kind: "line", from: { xIn: 0, yIn: 0 }, to: { ref: "shoot" } }],
            heading: { mode: "tangent" },
          },
        ],
      }),
    );
  };

  it("says what each code in the table means and how to fix it, once per code", () => {
    brokenProject();
    runValidate(["autos/gap.auto.json"], { explain: true, cwd: root });
    const text = out.join("");
    expect(text).toContain("What these findings mean");
    expect(text).toContain(`CONTINUITY: ${FINDING_HELP.CONTINUITY.title}`);
    expect(text).toContain(FINDING_HELP.CONTINUITY.means);
    expect(text).toContain(`To fix it: ${FINDING_HELP.CONTINUITY.fix}`);
    expect(text.split("CONTINUITY:").length - 1).toBe(1);
  });

  it("adds the help for the codes present to --json", () => {
    brokenProject();
    runValidate(["autos/gap.auto.json"], { explain: true, json: true, cwd: root });
    const parsed = JSON.parse(out.join("")) as {
      files: { findings: { code: string }[] }[];
      help: Record<string, unknown>;
    };
    expect(parsed.help["CONTINUITY"]).toEqual(FINDING_HELP.CONTINUITY);
    const present = new Set(parsed.files.flatMap((file) => file.findings.map((finding) => finding.code)));
    expect(Object.keys(parsed.help).sort()).toEqual([...present].sort());
  });

  it("prints no help without the flag", () => {
    brokenProject();
    runValidate(["autos/gap.auto.json"], { cwd: root });
    expect(out.join("")).not.toContain("What these findings mean");
  });
});

describe("the field image for render", () => {
  const webp = fileURLToPath(new URL("../../../apps/web/public/fields/biobuzz/biobuzz-dark.webp", import.meta.url));

  it("reads the size of the BIOBUZZ WebP images and of a PNG", () => {
    expect(imageSizePx(readFileSync(webp))).toEqual({ widthPx: 1080, heightPx: 1080 });
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    png.set([0, 0, 4, 0, 0, 0, 2, 0], 16);
    expect(imageSizePx(png)).toEqual({ widthPx: 1024, heightPx: 512 });
    expect(imageSizePx(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("embeds a picture beside the field file and skips an app asset or a missing file", () => {
    makeProject(root);
    mkdirSync(join(root, "autos/field/img"), { recursive: true });
    writeFileSync(join(root, "autos/field/img/field.webp"), readFileSync(webp));
    const project = loadProject(root);
    const local = parseField({
      ...TEST_FIELD,
      formatVersion: 2,
      image: { src: "img/field.webp", credit: "c", pxBoundsIn: "fullBleed", rotationDeg: 90 },
    });
    const image = fieldImageFor(project, local, "autos/field/field.json");
    expect(image?.href.startsWith("data:image/webp;base64,")).toBe(true);
    expect(image).toMatchObject({ widthPx: 1080, heightPx: 1080 });

    const app = parseField({ ...local, image: { ...local.image, src: "app:fields/biobuzz/biobuzz-dark.webp" } });
    expect(fieldImageFor(project, app, "autos/field/field.json")).toBeUndefined();
    const missing = parseField({ ...local, image: { ...local.image, src: "img/none.webp" } });
    expect(fieldImageFor(project, missing, "autos/field/field.json")).toBeUndefined();
    const outside = parseField({ ...local, image: { ...local.image, src: "../../../escape.webp" } });
    expect(fieldImageFor(project, outside, "autos/field/field.json")).toBeUndefined();
  });
});
