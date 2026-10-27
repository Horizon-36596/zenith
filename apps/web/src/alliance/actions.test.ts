import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints, plan, resolve, type Plan } from "@horizon36596/zenith-core";
import { afterEach, describe, expect, it } from "vitest";
import { getState } from "../state/store";
import { delayMyStart, leftWords, loadPartnersFrom, removePartnerAndSay, replacedWords } from "./actions";
import { readPartnerText, type PartnerSource } from "./source";
import { getAllianceState, resetAlliance, setOwnOffset } from "./store";
import { allianceView } from "./useAlliance";

/**
 * What the alliance view's controls say on the status line: what Delay my start leaves and how to
 * take it back, a file loaded again, and a partner removed. None of these is an edit, so Undo
 * cannot take them back; the status line says what can.
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
const PARTNER_TEXT = readFileSync(`${starter}partners/starter-partner.projection.json`, "utf8");

function starterPlan(name: string): Plan {
  const link = loadLink(read("zenith.json"));
  const robot = loadRobot(read(link.robot));
  const field = loadField(read(link.field));
  const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
  return plan(resolve(loadAuto(read(`autos/${name}.auto.json`)), waypoints, robot), robot, field);
}

const partnerSource: PartnerSource = {
  description: "the files you picked",
  load: () => Promise.resolve([readPartnerText("starter-partner.projection.json", PARTNER_TEXT)]),
};

const status = () => getState().status?.message ?? "";

afterEach(resetAlliance);

describe("leftWords", () => {
  it("names what is left, one code at a time, and says when nothing is", () => {
    expect(leftWords([])).toBe("No predicted conflicts are left.");
    expect(leftWords([{ code: "ALLIANCE_NEAR_MISS" }])).toBe("One near miss is left.");
    expect(leftWords([{ code: "ALLIANCE_NEAR_MISS" }, { code: "ALLIANCE_NEAR_MISS" }])).toBe("2 near misses are left.");
    expect(
      leftWords([{ code: "ALLIANCE_COLLISION" }, { code: "ALLIANCE_ELEMENT_CONFLICT" }, { code: "ALLIANCE_ELEMENT_CONFLICT" }]),
    ).toBe("One collision and 2 element conflicts are left.");
  });
});

describe("Delay my start", () => {
  it("says what is left after the delay and how to set the offset back", async () => {
    await loadPartnersFrom(partnerSource);
    const planned = starterPlan("collect-and-score");
    const before = allianceView(planned, getAllianceState()).result;
    const offsetS = before?.clearingOffsets.ALLIANCE_COLLISION?.offsetS;
    if (offsetS === undefined) throw new Error("the example collision has a clearing offset");

    delayMyStart(planned, offsetS);
    expect(getAllianceState().ownOffsetS).toBe(offsetS);
    const after = allianceView(planned, getAllianceState()).result?.findings.map((row) => row.finding) ?? [];
    expect(after.some((finding) => finding.code === "ALLIANCE_COLLISION")).toBe(false);
    expect(status()).toBe(
      `Your start is delayed by ${offsetS.toFixed(1)} s in the alliance view. ${leftWords(after)} To undo it, set Your start offset back to 0.0 s.`,
    );
  }, 30_000);

  it("names the offset it replaced as the one to go back to", async () => {
    await loadPartnersFrom(partnerSource);
    setOwnOffset(0.5);
    delayMyStart(starterPlan("collect-and-score"), 4);
    expect(status()).toContain("To undo it, set Your start offset back to 0.5 s.");
  }, 30_000);
});

describe("loading the same file again", () => {
  it("replaces the partner, keeps one, and says so", async () => {
    await loadPartnersFrom(partnerSource);
    expect(status()).toBe("Loaded Starter partner into the alliance view. Its findings are predictions.");
    await loadPartnersFrom(partnerSource);
    expect(getAllianceState().partners).toHaveLength(1);
    expect(status()).toBe("Replaced Starter partner with the file loaded again, so it is not loaded twice.");
  });

  it("names every partner it replaced", () => {
    expect(replacedWords([])).toBe("");
    expect(replacedWords([{ label: "A" }, { label: "B" }])).toBe(
      "Replaced A and B with the files loaded again, so none is loaded twice.",
    );
  });
});

describe("Remove on a partner", () => {
  it("unloads it and says how to bring it back", async () => {
    await loadPartnersFrom(partnerSource);
    const [partner] = getAllianceState().partners;
    if (partner === undefined) throw new Error("one partner expected");
    removePartnerAndSay(partner);
    expect(getAllianceState().partners).toHaveLength(0);
    expect(status()).toBe("Removed Starter partner. Load its file again to bring it back.");
  });

  it("says to load the share again for a partner from a cloud share", () => {
    removePartnerAndSay({ id: "partner9", label: "Shared link", share: {} as never });
    expect(status()).toBe("Removed Shared link. Load its share again to bring it back.");
  });
});
