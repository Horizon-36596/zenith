/**
 * The small dialogs of issue #103. `SaveChoiceDialog` asks where Save puts a read-only project's
 * auto: the full project, or just this auto into a project the person already has.
 * `WaypointCheckDialog` (issue #158) follows Just this auto when the project picked lacks, or has
 * somewhere else, waypoints the auto follows. `LoneAutoDialog` answers someone who opened an auto on
 * its own: which files it needs, and two ways on. `app/saveReadOnly.ts` decides and acts; these only
 * show the question.
 *
 * Each choice is one row: what it is and where it goes on the left edge, its button on the right
 * (UI_GUIDE section 9.14, one primary button).
 */
import { Button } from "../components/primitives";
import { openFolder } from "../app/projectActions";
import { answerSaveChoice, answerWaypointCheck, dismissLoneAuto, useSaveChoiceView } from "../app/saveChoice";
import { isDesktop } from "../project/desktop";
import { loneAutoLines } from "../project/projectFiles";
import { supportsDirectoryPicker } from "../project/types";
import { Modal } from "./Modal";
import dialogs from "./Dialogs.module.css";
import styles from "./SaveChoiceDialog.module.css";

/**
 * How each choice reads, in one line (issue #414): what it is and where it goes. The full project is a
 * new project to try Zenith out in, never the way into a team's own robot repository, which Open
 * project sets up instead (issue #159), so that is one link under the choices. How many waypoints the
 * auto follows is for the next step, which shows only when the project picked does not match them.
 */
const projectDetail = (folder: boolean, opens: boolean): string =>
  folder
    ? `A new folder with a copy of everything.${opens ? "" : " Open it later with Open project."}`
    : "A .zip with a copy of everything. Unzip it, then open the folder.";

const autoDetail = (folder: boolean, fileName: string): string =>
  folder ? "Add it to a project you already have." : `Downloads ${fileName}, for the autos folder of your project.`;

export function SaveChoiceDialog() {
  const { saveChoice } = useSaveChoiceView();
  if (saveChoice === null) return null;
  const { fileName, isExample, where } = saveChoice;
  const folder = where === "folder";
  const waypointsChanged = saveChoice.waypointsChanged === true;
  const canOpenFolder = isDesktop() || supportsDirectoryPicker();
  const autoText = waypointsChanged
    ? "Your waypoint changes are saved only with the full project. Save that, or undo them first."
    : autoDetail(folder, fileName);

  return (
    <Modal
      title={isExample ? "Save the example" : "Save a copy"}
      testId="save-choice"
      width={520}
      onClose={() => {
        answerSaveChoice("cancel");
      }}
      footer={
        <Button testId="save-choice-cancel" onClick={() => answerSaveChoice("cancel")}>
          Cancel
        </Button>
      }
    >
      <p className={dialogs.prose}>
        {isExample ? "The example is read only." : "These files were opened read only."} Choose where{" "}
        <code className={`mono ${styles.file}`}>{fileName}</code> goes.
      </p>
      <div className={styles.choices}>
        <div className={styles.choice} data-testid="save-choice-project-row">
          <div className={styles.text}>
            <p className={styles.name}>Full project</p>
            <p className={styles.detail} data-testid="save-choice-project-detail">
              {projectDetail(folder, saveChoice.opensProject !== false)}
            </p>
          </div>
          <Button kind="primary" testId="save-choice-project" onClick={() => answerSaveChoice("project")}>
            {folder ? "Save project…" : "Download project"}
          </Button>
        </div>
        <div className={styles.choice} data-testid="save-choice-auto-row">
          <div className={styles.text}>
            <p className={styles.name}>Just this auto</p>
            <p className={styles.detail} data-testid="save-choice-auto-detail">
              {autoText}
            </p>
          </div>
          <Button
            testId="save-choice-auto"
            whyDisabled={waypointsChanged ? "Your waypoint changes are saved only with the full project." : null}
            onClick={() => answerSaveChoice("auto")}>
            {folder ? "Save auto…" : "Download auto"}
          </Button>
        </div>
      </div>
      {canOpenFolder ? (
        <div className={dialogs.linkRow}>
          <button
            type="button"
            className={dialogs.textLink}
            data-testid="save-choice-open-own"
            onClick={() => {
              answerSaveChoice("cancel");
              void openFolder();
            }}
          >
            For your own robot, open its folder.
          </button>
        </div>
      ) : null}
    </Modal>
  );
}

const isOrAre = (count: number): string => (count === 1 ? "is" : "are");

/**
 * The step after Just this auto picked a project whose waypoints lack, or have somewhere else, some
 * the auto follows (issue #158). It lists each such name with its pose here and in that project, and
 * offers what to do; nothing is written until the person picks one, and Cancel writes nothing.
 */
export function WaypointCheckDialog() {
  const { waypointCheck } = useSaveChoiceView();
  if (waypointCheck === null) return null;
  const { fileName, project, followed, rows, addTo } = waypointCheck;
  const missing = rows.filter((row) => row.match === "missing").length;
  const differs = rows.filter((row) => row.match === "differs").length;
  const counts =
    missing > 0 && differs > 0
      ? `In ${project}, ${String(missing)} ${isOrAre(missing)} missing and ${String(differs)} ${isOrAre(differs)} somewhere else.`
      : missing > 0
        ? `In ${project}, ${String(missing)} ${isOrAre(missing)} missing.`
        : `In ${project}, ${String(differs)} ${isOrAre(differs)} somewhere else.`;
  const missingOwn = missing === 0 ? "" : missing === 1 ? " The missing one gets its own pose." : " The missing ones get their own poses.";
  const differsOwn = differs === 0 ? "" : differs === 1 ? " The one somewhere else gets its own pose." : " The ones somewhere else get their own poses.";

  return (
    <Modal
      title={`Check the waypoints in ${project}`}
      testId="waypoint-check"
      width={640}
      tall
      onClose={() => {
        answerWaypointCheck("cancel");
      }}
      footer={
        <Button testId="waypoint-check-cancel" onClick={() => answerWaypointCheck("cancel")}>
          Cancel
        </Button>
      }
    >
      <p className={dialogs.prose}>
        <code className={`mono ${styles.file}`}>{fileName}</code> follows {followed === 1 ? "1 waypoint" : `${String(followed)} waypoints`} by
        name. {counts}
      </p>
      <table className={styles.poses}>
        <thead>
          <tr>
            <th scope="col">Waypoint</th>
            <th scope="col">Here</th>
            <th scope="col">In {project}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} data-testid={`waypoint-check-row-${row.name}`} data-match={row.match}>
              <th scope="row" className="mono">
                {row.name}
              </th>
              <td className="mono">{row.here}</td>
              <td className={row.there === null ? styles.absent : "mono"}>{row.there ?? `Not in ${project}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.choices}>
        <div className={styles.choice} data-testid="waypoint-check-own-row">
          <div className={styles.text}>
            <p className={styles.name}>Give these points their own poses</p>
            <p className={styles.detail}>
              The auto drives where it does now. {project}&apos;s waypoints.json is not changed.
            </p>
          </div>
          <Button kind="primary" testId="waypoint-check-own" onClick={() => answerWaypointCheck("own")}>
            Save auto
          </Button>
        </div>
        {addTo !== null ? (
          <div className={styles.choice} data-testid="waypoint-check-add-row">
            <div className={styles.text}>
              <p className={styles.name}>Add the missing waypoints to {addTo}</p>
              <p className={styles.detail}>
                With the poses they have here. None already there change.{differsOwn}
              </p>
            </div>
            <Button testId="waypoint-check-add" onClick={() => answerWaypointCheck("add")}>
              Add and save
            </Button>
          </div>
        ) : null}
        {differs > 0 ? (
          <div className={styles.choice} data-testid="waypoint-check-follow-row">
            <div className={styles.text}>
              <p className={styles.name}>Follow {project}&apos;s own</p>
              <p className={styles.detail}>
                The {differs === 1 ? "one" : "ones"} somewhere else follow{differs === 1 ? "s" : ""} {project}&apos;s, so there the robot
                drives to the {differs === 1 ? "pose" : "poses"} listed for {project}.{missingOwn}
              </p>
            </div>
            <Button testId="waypoint-check-follow" onClick={() => answerWaypointCheck("follow")}>
              Follow and save
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function LoneAutoDialog() {
  const { loneAuto } = useSaveChoiceView();
  if (loneAuto === null) return null;
  const names = Object.keys(loneAuto.autoTexts).sort((a, b) => a.localeCompare(b));
  const [what, needs, next] = loneAutoLines(names);
  const canOpenFolder = isDesktop() || supportsDirectoryPicker();

  return (
    <Modal
      title="This is only an auto"
      testId="lone-auto"
      width={560}
      onClose={dismissLoneAuto}
      footer={
        <>
          <Button testId="lone-auto-cancel" onClick={dismissLoneAuto}>
            Cancel
          </Button>
          {canOpenFolder ? (
            <Button
              testId="lone-auto-open-folder"
              onClick={() => {
                dismissLoneAuto();
                void openFolder();
              }}
            >
              Open a folder…
            </Button>
          ) : null}
          <Button kind="primary" testId="lone-auto-example" onClick={() => {
              // Loaded on demand, like the rest of Save's read-only path (app/projectActions.ts).
              void import("../app/saveReadOnly").then((module) => module.openOnExample(loneAuto.autoTexts));
            }}>
            Open with the example robot and field
          </Button>
        </>
      }
    >
      <p className={dialogs.prose} data-testid="lone-auto-message">
        {what} {needs}
      </p>
      <p className={dialogs.prose}>{next}</p>
      <p className={styles.note}>The example's robot and field may differ from the ones this auto was made for. It opens read only.</p>
    </Modal>
  );
}
