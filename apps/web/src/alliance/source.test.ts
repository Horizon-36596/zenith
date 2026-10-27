import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadField } from "@horizon36596/zenith-core";
import { importTrajectory } from "@horizon36596/zenith-import";
import { fileSource, readPartnerFile, readPartnerText } from "./source";

/**
 * A partner that paths on the fly or plans in RoadRunner hands over a trajectory.json instead of a
 * projection (spec 13 section 11). The Partners panel reads it against the open auto's field into
 * the same view projection `zenith import` writes, through the schema's own validator.
 */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repo}${path}`, "utf8");
const field = loadField(JSON.parse(read("examples/starter/autos/field/biobuzz.field.json")));
const MEEPMEEP = "packages/import/fixtures/trajectory/meepmeep-line-and-turn.trajectory.json";

describe("readPartnerFile", () => {
  it("reads a trajectory.json as a view projection, pose for pose what zenith import writes", () => {
    const text = read(MEEPMEEP);
    const load = readPartnerFile("meepmeep.trajectory.json", text, field);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.projection.level).toBe("view");
    expect(load.projection.title).toBe("MeepMeep line and turn");
    expect(load.projection.trajectory.poses).toEqual(importTrajectory(JSON.parse(text) as unknown, field).trajectory.poses);
  });

  it("names the first wrong field of a broken trajectory.json", () => {
    const load = readPartnerFile("bad.trajectory.json", read("packages/import/fixtures/trajectory/broken/pose-row-too-short.trajectory.json"), field);
    expect(load).toMatchObject({ ok: false });
    if (!load.ok) {
      expect(load.reason).toMatch(/^bad\.trajectory\.json has a value Zenith cannot read at poses\[1\]: /);
      expect(load.reason).toMatch(/\. Check the file, or export it again from the planner that wrote it\.$/);
    }
  });

  it("needs a field for a trajectory, but not for a projection", () => {
    const load = readPartnerFile("meepmeep.trajectory.json", read(MEEPMEEP), null);
    expect(load).toMatchObject({
      ok: false,
      reason: "meepmeep.trajectory.json is a trajectory.json, which is read against the open auto's field. Open an auto first.",
    });
    const partner = read("examples/starter/partners/starter-partner.projection.json");
    expect(readPartnerFile("starter-partner.projection.json", partner, null).ok).toBe(true);
  });

  it("is what the file source uses, with the field it is handed", async () => {
    const text = read(MEEPMEEP);
    const loads = await fileSource([{ name: "meepmeep.trajectory.json", size: text.length, text: () => Promise.resolve(text) }], field).load();
    expect(loads[0]?.ok).toBe(true);
  });
});

describe("readPartnerText", () => {
  it("says in one sentence that a project file is not a share file (the 0.1.2 UX sweep, W3-6)", () => {
    const load = readPartnerFile("robot.json", read("examples/starter/autos/robot.json"), field);
    expect(load).toEqual({
      ok: false,
      fileName: "robot.json",
      reason: "robot.json is a Zenith robot file, not a share file. Ask your partner for the file Download share file makes in their Zenith.",
    });
  });

  it("names only the first thing wrong with a broken share file, and counts the rest", () => {
    const partner = JSON.parse(read("examples/starter/partners/starter-partner.projection.json")) as Record<string, unknown>;
    partner["level"] = "edit";
    partner["unknownKey"] = 1;
    const load = readPartnerText("partner.projection.json", JSON.stringify(partner));
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.reason).not.toContain("\n");
      expect(load.reason).toMatch(/^partner\.projection\.json is a damaged share file: .+ \(and \d+ more values?\)\. Ask your partner to download it again\.$/);
    }
  });
});

/**
 * Every bad share file gets one true sentence that names the file and says what to do (the 0.1.2
 * UX review, K5 and K6), never the parser's or the validator's own words.
 */
describe("a bad share file", () => {
  const partner = read("examples/starter/partners/starter-partner.projection.json");
  const reasonOf = (name: string, text: string): string => {
    const load = readPartnerFile(name, text, field);
    if (load.ok) throw new Error(`${name} loaded.`);
    return load.reason;
  };
  const AGAIN = "Ask your partner to download it again.";

  it("is never told its name is wrong when the name is right", () => {
    expect(reasonOf("wrong-schema.projection.json", '{"hello":"world"}')).toBe(
      "wrong-schema.projection.json is not a share file Zenith wrote. Ask your partner for the file Download share file makes in their Zenith.",
    );
  });

  it("says empty, cut off or a picture rather than not JSON", () => {
    expect(reasonOf("empty.projection.json", "")).toBe(`empty.projection.json is empty. ${AGAIN}`);
    expect(reasonOf("truncated.projection.json", partner.slice(0, 400))).toBe(
      `truncated.projection.json is cut off: the JSON in it stops part way. ${AGAIN}`,
    );
    expect(reasonOf("image.projection.json", "�PNG\r\n\u001a\n\0\0\0\rIHDR")).toBe(
      `image.projection.json is a picture, not a JSON file. ${AGAIN}`,
    );
  });

  it("names a damaged value without the validator's words", () => {
    const wrongKind = partner.replace('"kind": "projection"', '"kind": "auto"').replace('"kind":"projection"', '"kind":"auto"');
    expect(wrongKind).not.toBe(partner);
    expect(reasonOf("wrong-kind.projection.json", wrongKind)).toBe(
      `wrong-kind.projection.json is a damaged share file: Zenith cannot read the value at kind. ${AGAIN}`,
    );
  });

  it("says a newer one needs a newer Zenith, and a large one the limit", async () => {
    const future = JSON.stringify({ ...(JSON.parse(partner) as object), formatVersion: 99 });
    expect(reasonOf("future-version.projection.json", future)).toBe(
      "future-version.projection.json was made by a newer Zenith (share file format 99; this Zenith reads format 1). Update Zenith to load it.",
    );
    const big = JSON.stringify({ kind: "projection", pad: "x".repeat(5_000_000) });
    expect(reasonOf("big5mb.projection.json", big)).toBe(
      "big5mb.projection.json is 5.0 MB, larger than the 2.0 MB a share file may be, so it was not read. Check that this is the file you meant.",
    );
    const loads = await fileSource([{ name: "huge.json", size: 20_000_000, text: () => Promise.resolve("") }], field).load();
    expect(loads[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/^huge\.json is 20\.0 MB, so it was not read\. A share file may be 2\.0 MB at most/) as unknown });
  });

  it("names a cloud share by who shared it, and says to ask that team", () => {
    const words = { subject: "The auto shared by Team 12345", again: "Ask that team to share it again." };
    expect(readPartnerText("Team 12345", "{", words)).toMatchObject({
      ok: false,
      reason: "The auto shared by Team 12345 is cut off: the JSON in it stops part way. Ask that team to share it again.",
    });
  });
});
