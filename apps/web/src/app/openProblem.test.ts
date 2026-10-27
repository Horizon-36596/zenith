/**
 * Issue #520: the empty canvas names what did not open, a folder, a repository, files, the example
 * or a host's project, and offers to open another of the same kind, not always another folder.
 */
import { describe, expect, it } from "vitest";
import { openProblemView, type OpenKind } from "./openProblem";

const view = (kind: OpenKind, name: string | null = null) => openProblemView({ kind, name, message: "Why." });

describe("openProblemView (issue #520)", () => {
  it("names a folder, and offers the folder picker", () => {
    expect(view("folder", "robot-repo")).toEqual({ title: "robot-repo did not open", retry: { label: "Open another folder…", via: "folder" } });
    expect(view("folder").title).toBe("The folder did not open");
  });

  it("names a repository, and offers another through the Open project dialog", () => {
    expect(view("repo", "horizon/robot")).toEqual({
      title: "horizon/robot did not open",
      retry: { label: "Open another repository…", via: "dialog" },
    });
    expect(view("repo").title).toBe("The repository did not open");
  });

  it("says files did not open, and offers others through the dialog", () => {
    expect(view("files")).toEqual({ title: "The files did not open", retry: { label: "Open other files…", via: "dialog" } });
  });

  it("offers nothing of its own for the example or a host's project", () => {
    expect(view("example")).toEqual({ title: "The example did not open", retry: null });
    expect(view("host", "DSIM")).toEqual({ title: "The project from DSIM did not open", retry: null });
  });
});
