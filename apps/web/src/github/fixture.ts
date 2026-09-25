/**
 * A review of two versions of the bundled example, built entirely in the browser: no repository,
 * no token, no request. It exists so review mode's layout can be opened, looked at and
 * screenshotted while developing, and so the view model can be exercised by hand.
 *
 * Dev only — `route.ts` reaches it behind `import.meta.env.DEV`, so it is not in a production
 * bundle. The two versions differ the way a real proposal does: one leg's endpoint moved and one
 * step dropped, which gives a changed row, a removed row and a total that moves.
 */
import { canonicalize, removeStep, setPose } from "@horizon36596/zenith-core";
import { diffAnchor } from "@horizon36596/zenith-github";
import type { Auto } from "@horizon36596/zenith-schema";
import { LocalBackend } from "../project/backend";
import { loadExampleProject } from "../project/example";
import { openAuto, openProject, setReview, setStatus } from "../state/store";
import { buildReviewModel, type ReviewState } from "./reviewModel";

const AUTO = "first-auto.auto.json";

/** The head version: the first leg lands a foot further out, and the park leg is gone. */
function head(base: Auto): Auto {
  const moved = setPose(
    base,
    "driveOut",
    { segmentIndex: 0, pointKind: "to" },
    { xIn: -12, yIn: -24, headingRad: 1.5708, provenance: "SET FROM EDITOR: review fixture" },
  );
  return removeStep(moved, "park");
}

export async function openFixtureReview(): Promise<void> {
  const project = loadExampleProject();
  const backend = LocalBackend.of(project);
  await backend.open();
  openProject(project, backend);

  const base = (await backend.readAuto(AUTO)).auto;
  const headAuto = head(base);
  const headText = canonicalize("auto", headAuto);
  const path = `${project.link.autosDir}/${AUTO}`;

  const model = buildReviewModel({
    base,
    head: headAuto,
    robot: project.robot,
    field: project.field,
    waypoints: project.waypoints,
  });
  for (const row of model.rows) {
    row.anchor = await diffAnchor(path, headText, row.stepId, row.kind === "removed" ? "base" : "head");
  }

  const review: ReviewState = {
    owner: "example-team",
    repo: "robot",
    number: 0,
    htmlUrl: "https://github.com/example-team/robot/pull/0",
    title: "first-auto: drive out further and drop the park",
    path,
    baseRef: "main",
    headRef: "auto/first-auto/fixture",
    files: [path, `${project.link.autosDir}/.renders/first-auto.svg`],
    head: headAuto,
    base,
    model,
  };
  openAuto(AUTO, headAuto, headText);
  setReview(review);
  setStatus("info", "Review fixture: two versions of the bundled example, with no network.");
}
