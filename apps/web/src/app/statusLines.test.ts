/**
 * UI_GUIDE 9.15: every action answers once, and an old answer goes away. Opening another auto says
 * which one opened, and after Discard it says the edits went, never the "Kept the unsaved edits"
 * line a Cancel before it wrote. Validate answers with what it found.
 */
import type { Auto } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { problemsListed } from "../panels/findingRows";
import { findingStepId } from "../panels/FindingsPanel";
import { severityCounts, sortFindings } from "../state/derived";
import { clearStatus, closeProject, commit, currentDerived, getState, setStatus } from "../state/store";
import { loadExample, openAutoNamed, validate } from "./projectActions";
import { answerUnsaved } from "./unsaved";

/** Gives the open a few turns to read the auto and the question to show. */
async function turns(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  answerUnsaved("cancel");
  closeProject();
  clearStatus();
  vi.stubGlobal("document", { querySelector: () => null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const retitled = (title: string): void => {
  commit({ ...(getState().auto as Auto), title });
};

describe("opening another auto (F1, F2, X2)", () => {
  it("says which auto opened, in place of the line the example left", async () => {
    await loadExample();
    expect(getState().status?.message).toBe("Example loaded, read only.");
    await openAutoNamed("first-auto.auto.json");
    expect(getState().status).toMatchObject({ kind: "ok", message: "Opened first-auto.auto.json." });
  });

  it("after Cancel and then Discard, says the edits were discarded, not kept", async () => {
    await loadExample();
    const first = getState().fileName;
    retitled("Edited");

    const cancelled = openAutoNamed("first-auto.auto.json");
    await turns();
    answerUnsaved("cancel");
    await cancelled;
    expect(getState().status?.message).toBe(`Kept the unsaved edits in ${String(first)}.`);

    const discarded = openAutoNamed("first-auto.auto.json");
    await turns();
    answerUnsaved("discard");
    await discarded;
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(getState().status).toMatchObject({
      kind: "ok",
      message: `Discarded the edits to ${String(first)}. Opened first-auto.auto.json.`,
    });
  });
});

describe("Validate (K1, S17)", () => {
  it("answers with the counts, or No problems found.", async () => {
    await loadExample();
    setStatus("ok", "Downloaded new-auto.red.png.");
    await validate();
    const counts = severityCounts(problemsListed(currentDerived().findings));
    const status = getState().status;
    if (counts.error + counts.warning === 0) expect(status).toMatchObject({ kind: "ok", message: "No problems found." });
    else expect(status?.message).toMatch(/^\d+ (error|warning)/);
  });

  it("opens the first error of an auto that has one", async () => {
    await loadExample();
    const auto = getState().auto as Auto;
    const [step] = auto.steps;
    if (step?.kind !== "path") throw new Error("expected the example to start with a path");
    // A path that drives far off the field is an error.
    const far = { ...step, segments: step.segments.map((segment) => ({ ...segment, to: { xIn: 900, yIn: 900, headingRad: 0 } })) };
    commit({ ...auto, steps: [far, ...auto.steps.slice(1)] } as Auto);
    await validate();
    const counts = severityCounts(problemsListed(currentDerived().findings));
    expect(counts.error).toBeGreaterThan(0);
    expect(getState().status).toMatchObject({ kind: "info", hint: "Opened the first error." });
    expect(getState().status?.message).toMatch(/^\d+ errors?\b/);
    const first = sortFindings(problemsListed(currentDerived().findings))[0];
    if (first === undefined) throw new Error("expected a problem");
    if (first.stepId === "start") expect(getState().selection.start).toBe(true);
    else expect(getState().selection.stepId).toBe(findingStepId(first));
  }, 30_000);
});
