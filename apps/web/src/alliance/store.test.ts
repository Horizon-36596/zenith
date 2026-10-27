import { SCHEMA_ID, type Projection } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  addPartnerLoads,
  getAllianceState,
  removePartner,
  resetAlliance,
  setOwnOffset,
  setPartnerOffset,
  setPartnerVisible,
} from "./store";

const projection = (title?: string): Projection => ({
  $schema: SCHEMA_ID.projection,
  formatVersion: 1,
  kind: "projection",
  level: "view",
  season: "biobuzz",
  alliance: "RED",
  ...(title === undefined ? {} : { title }),
  startPose: { xIn: 0, yIn: 0, headingRad: 0 },
  boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
  trajectory: { rateHz: 10, positionQuantumIn: 0.5, headingQuantumRad: 0.0175, poses: [[0, 0, 0]] },
  phases: [],
  claims: [],
  envelopes: [],
  totalS: 0,
});

afterEach(resetAlliance);

describe("the alliance store", () => {
  it("adds what loaded with a label, a free colour and no offset, and opens the panel", () => {
    const { added, failed } = addPartnerLoads([
      { ok: true, fileName: "near.projection.json", projection: projection() },
      { ok: false, fileName: "broken.json", reason: "The file is not JSON." },
      { ok: true, fileName: "far.json", projection: projection("Far side") },
    ]);
    expect(failed.map((load) => load.fileName)).toEqual(["broken.json"]);
    expect(added.map((entry) => [entry.label, entry.colour, entry.visible, entry.offsetS])).toEqual([
      ["near", 0, true, 0],
      ["Far side", 1, true, 0],
    ]);
    expect(new Set(added.map((entry) => entry.id)).size).toBe(2);
    expect(getAllianceState().open).toBe(true);
  });

  it("replaces the same file a second time instead of loading it twice, keeping its colour", () => {
    const [first] = addPartnerLoads([{ ok: true, fileName: "partners/near.projection.json", projection: projection("Near") }]).added;
    const { added, replaced, failed } = addPartnerLoads([
      { ok: true, fileName: "partners/near.projection.json", projection: projection("Near") },
      { ok: true, fileName: "partners/near.projection.json", projection: projection("Near, moved") },
    ]);
    expect(added.map((entry) => entry.label)).toEqual(["Near, moved"]);
    expect(replaced.map((entry) => [entry.id, entry.colour])).toEqual([[first?.id, first?.colour]]);
    expect(failed).toEqual([]);
    expect(getAllianceState().partners).toHaveLength(2);
  });

  it("hides, offsets on the 0.1 s grid, and removes one partner without touching the other", () => {
    const { added } = addPartnerLoads([
      { ok: true, fileName: "a.json", projection: projection() },
      { ok: true, fileName: "b.json", projection: projection() },
    ]);
    const [a, b] = added;
    if (a === undefined || b === undefined) throw new Error("two partners expected");
    setPartnerVisible(a.id, false);
    setPartnerOffset(b.id, 1.26);
    setOwnOffset(0.44);
    let state = getAllianceState();
    expect(state.partners.map((entry) => [entry.visible, entry.offsetS])).toEqual([
      [false, 0],
      [true, 1.3],
    ]);
    expect(state.ownOffsetS).toBe(0.4);
    removePartner(a.id);
    state = getAllianceState();
    expect(state.partners.map((entry) => entry.id)).toEqual([b.id]);
    // A partner loaded after a removal takes the colour that was freed.
    const { added: again } = addPartnerLoads([{ ok: true, fileName: "c.json", projection: projection() }]);
    expect(again[0]?.colour).toBe(0);
  });

  it("replaces a file loaded again instead of loading it twice, keeping its colour, offset and visibility", () => {
    const { added } = addPartnerLoads([
      { ok: true, fileName: "a.json", projection: projection("Near") },
      { ok: true, fileName: "b.json", projection: projection() },
    ]);
    const [a] = added;
    if (a === undefined) throw new Error("a partner expected");
    setPartnerVisible(a.id, false);
    setPartnerOffset(a.id, 1.5);
    const again = addPartnerLoads([{ ok: true, fileName: "a.json", projection: projection("Near") }]);
    expect(again.added).toEqual([]);
    expect(again.replaced.map((entry) => [entry.id, entry.colour, entry.visible, entry.offsetS])).toEqual([
      [a.id, a.colour, false, 1.5],
    ]);
    expect(getAllianceState().partners.map((entry) => entry.fileName)).toEqual(["a.json", "b.json"]);

    // The same name with another projection, or the same projection under another name, is new.
    const other = addPartnerLoads([
      { ok: true, fileName: "a.json", projection: projection("Far") },
      { ok: true, fileName: "c.json", projection: projection("Near") },
    ]);
    expect(other.added).toHaveLength(2);
    expect(other.replaced).toEqual([]);

    // A file picked twice in one go is added once.
    const twice = addPartnerLoads([
      { ok: true, fileName: "d.json", projection: projection() },
      { ok: true, fileName: "d.json", projection: projection() },
    ]);
    expect(twice.added).toHaveLength(1);
    expect(twice.replaced).toEqual([]);
    expect(getAllianceState().partners).toHaveLength(5);
  });
});
