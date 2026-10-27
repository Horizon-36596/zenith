import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { derive } from "../state/derived";

/**
 * "Alliance findings never block anything" (spec 13 section 9). The
 * editor's save, deploy, commit and propose paths read `derive()`'s findings; the alliance view's
 * findings live in their own store and never reach them. These tests hold that line: nothing that
 * saves, deploys or proposes imports the alliance modules, and `derive()` never carries an
 * ALLIANCE_ code, whatever partners are loaded.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("alliance findings never block anything", () => {
  it("are not imported by anything that saves, deploys, commits or proposes", () => {
    const gated = [
      "state/derived.ts",
      "app/projectActions.ts",
      "project/desktopActions.ts",
      "github/actions.ts",
      "github/ProposeDialog.tsx",
      "github/CommitDialog.tsx",
      "project/backend.ts",
      "project/local.ts",
      // Saving or sending a proposal is gated on the proposal's own findings only.
      "proposals/proposerActions.ts",
      "proposals/ownerActions.ts",
      "proposals/sink.ts",
    ];
    for (const relative of gated) {
      const text = readFileSync(join(SRC, relative), "utf8");
      expect(text, relative).not.toMatch(/from\s+["'][^"']*alliance\//);
    }
    // And nothing outside the view's own panels reads the alliance store.
    const readers = files(SRC)
      .filter((path) => !path.includes(`${join("src", "alliance")}`))
      .filter((path) => /from\s+["'][^"']*alliance\/(store|useAlliance|actions)["']/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(SRC.length).split("\\").join("/"));
    // The proposal views show the alliance view's predictions beside a proposal; they never gate it.
    expect(readers.sort()).toEqual([
      "app/App.tsx",
      // Play from here starts the playhead at the step on the alliance clock; it only reads the offset.
      "app/playFromHere.ts",
      "panels/FindingsPanel.tsx",
      "panels/Timeline.tsx",
      // The Steps list's running highlight follows the robot's start delay; it only reads.
      "panels/useActiveSteps.ts",
      // The Ledger's running step is the Steps list's, on the same clock; it only reads the offset
      // and returns display phases, and only LedgerPanel imports it.
      "panels/useLedgerPhases.ts",
      "proposals/ProposalEditView.tsx",
      "proposals/ProposalReviewView.tsx",
    ]);
  });

  it("never appear among the findings derive() gives the save and propose paths", () => {
    const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
    const json = (name: string): unknown => JSON.parse(readFileSync(`${examples}${name}`, "utf8"));
    const derived = derive(
      loadAuto(json("collect-and-score.auto.json")),
      loadRobot(json("robot.json")),
      loadField(json("field/biobuzz.field.json")),
      loadWaypoints(json("waypoints.json")),
    );
    expect(derived.findings.some((finding) => finding.code.startsWith("ALLIANCE_"))).toBe(false);
  });
});
