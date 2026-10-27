/**
 * The branch a proposal goes from when the dialog's field is left empty (issue #407): the branch
 * Save commits to, so a custom work branch and what was saved there are what the pull request
 * carries.
 *
 * And the error gate: Propose counts every error, one in a feature the settings hide too, as
 * Validate and the CLI do, and says where a hidden one is.
 */
import type { Auto } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it } from "vitest";
import { loadExample } from "../app/projectActions";
import { presetSettings } from "../settings/presets";
import { closeProject, commit, currentDerived, getState, setSettings, type State } from "../state/store";
import { proposalBranch, proposeBlockedReason } from "./actions";
import { proposeWarningsLine } from "./ProposeDialog";

describe("proposalBranch", () => {
  it("uses the custom work branch when the field is empty", () => {
    expect(proposalBranch(undefined, "custom-work", "main")).toBe("custom-work");
    expect(proposalBranch("   ", "custom-work", "main")).toBe("custom-work");
  });

  it("uses what was typed over the work branch", () => {
    expect(proposalBranch(" typed ", "custom-work", "main")).toBe("typed");
  });

  it("leaves the choice to propose before an auto has named a branch", () => {
    expect(proposalBranch("", "main", "main")).toBeUndefined();
  });
});

/**
 * The example's collect-and-score, opened, with forty pollen held at the start where the robot holds
 * at most four: CAPACITY, an error the ledger raises, which Essential's Ledger switch hides.
 */
async function openWithHiddenLedgerError(): Promise<void> {
  closeProject();
  setSettings(presetSettings("essential"));
  await loadExample();
  const auto = getState().auto as Auto;
  commit({ ...auto, start: { ...auto.start, holds: { ...auto.start.holds, pollen: 40 } } });
}

describe("proposeBlockedReason", () => {
  afterEach(() => {
    setSettings(presetSettings("essential"));
    closeProject();
  });

  /** The store's state as a project opened from GitHub would have it. */
  const fromGitHub = (): State => ({ ...getState(), backend: { canPropose: true } as State["backend"] });

  it("refuses an auto whose only error is in a hidden feature, and says where it is (0.1.2 batch review)", async () => {
    await openWithHiddenLedgerError();
    expect(currentDerived().findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(proposeBlockedReason(fromGitHub())).toBe(
      "Validation has 3 errors, in a feature your settings hide (Ledger and ball counting); fix them or turn the feature on, and propose again.",
    );
  });

  it("says nothing of hidden features once the feature is on", async () => {
    await openWithHiddenLedgerError();
    setSettings(presetSettings("full"));
    expect(proposeBlockedReason(fromGitHub())).toBe("Validation has 3 errors; fix them and propose again.");
  });
});

describe("the Propose dialog's warnings line", () => {
  it("counts the hidden warnings the body lists", () => {
    expect(proposeWarningsLine(1, 0)).toBe("The 1 warning on this auto does not block the proposal; it is listed for the reviewer.");
    expect(proposeWarningsLine(3, 1)).toBe(
      "The 3 warnings on this auto do not block the proposal; they are listed for the reviewer. 1 of them is in features your settings hide, so Problems does not show it.",
    );
    expect(proposeWarningsLine(2, 2)).toContain("All of them are in features your settings hide, so Problems does not show them.");
  });
});
