import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Projection } from "@horizon36596/zenith-schema";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { clearStatus, closeProject, getState, openAuto, openProject } from "../state/store";
import { addPartnerLoads, getAllianceState, resetAlliance, setOwnOffset } from "./store";

/**
 * The own start offset belongs to one auto of one project (issue #193): opening another auto shows
 * its own offset, going back finds the first one again, and a new project forgets them all while
 * the loaded partners stay.
 */
const fixture = (name: string) =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name,
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [{ id: "shoot", kind: "command", name: "score" }],
  });

const open = (fileName: string): void => {
  const auto = fixture(fileName.replace(/\.auto\.json$/, ""));
  openAuto(fileName, auto, canonicalize("auto", auto));
};

const project = { source: { kind: "example" }, robot: null, field: null, waypoints: undefined } as unknown as Project;
const openNewProject = (): void => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
};

const projection: Projection = {
  $schema: SCHEMA_ID.projection,
  formatVersion: 1,
  kind: "projection",
  level: "view",
  season: "biobuzz",
  alliance: "RED",
  startPose: { xIn: 0, yIn: 0, headingRad: 0 },
  boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
  trajectory: { rateHz: 10, positionQuantumIn: 0.5, headingQuantumRad: 0.0175, poses: [[0, 0, 0]] },
  phases: [],
  claims: [],
  envelopes: [],
  totalS: 0,
};

beforeEach(() => {
  clearStatus();
  closeProject();
  resetAlliance();
  openNewProject();
});

describe("the start offset per auto", () => {
  it("shows the open auto's own offset, and finds the first one's again on the way back", () => {
    open("collect-and-score.auto.json");
    setOwnOffset(3.7);
    expect(getAllianceState().ownOffsetS).toBe(3.7);

    open("first-auto.auto.json");
    expect(getAllianceState().ownOffsetS).toBe(0);
    setOwnOffset(1.2);

    open("collect-and-score.auto.json");
    expect(getAllianceState().ownOffsetS).toBe(3.7);
    open("first-auto.auto.json");
    expect(getAllianceState().ownOffsetS).toBe(1.2);
  });

  it("says where the delay stayed when an auto opens with none and the last one had one", () => {
    open("collect-and-score.auto.json");
    setOwnOffset(3.7);
    open("first-auto.auto.json");
    expect(getState().status?.message).toBe(
      "Your start offset is 0 s for first-auto. The 3.7 s delay stays with collect-and-score.",
    );
  });

  it("says nothing when the last auto had no offset or the new one has its own", () => {
    open("collect-and-score.auto.json");
    open("first-auto.auto.json");
    expect(getState().status?.message ?? "").not.toContain("stays with");
    setOwnOffset(1.2);
    open("collect-and-score.auto.json");
    setOwnOffset(2);
    clearStatus();
    open("first-auto.auto.json");
    expect(getState().status?.message ?? "").not.toContain("stays with");
    open("collect-and-score.auto.json");
    expect(getState().status?.message ?? "").not.toContain("stays with");
  });

  it("forgets the offsets for a new project and a closed one, and keeps the partners", () => {
    addPartnerLoads([{ ok: true, fileName: "a.json", projection }]);
    open("collect-and-score.auto.json");
    setOwnOffset(3.7);

    openNewProject();
    open("collect-and-score.auto.json");
    expect(getAllianceState().ownOffsetS).toBe(0);
    expect(getAllianceState().partners).toHaveLength(1);

    setOwnOffset(2);
    closeProject();
    expect(getAllianceState().ownOffsetS).toBe(0);
    openNewProject();
    open("collect-and-score.auto.json");
    expect(getAllianceState().ownOffsetS).toBe(0);
    expect(getAllianceState().partners).toHaveLength(1);
  });
});
