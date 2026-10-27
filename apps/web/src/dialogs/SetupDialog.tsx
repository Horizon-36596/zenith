/**
 * Set up Zenith in a folder (issue #159): the question Open folder asks about a robot repository
 * with no `zenith.json`, then what was written and the Gradle lines to add. A folder that has autos
 * already is offered `zenith.json` alone, pointing at them where they are (issue #496).
 * `app/setupProject.ts` scans, writes and opens; this only shows it. One primary button (UI_GUIDE
 * section 9.14).
 */
import { useRef, useState } from "react";
import { LIBRARY_LABEL, type CommandLibrary } from "@horizon36596/zenith-core";
import { Button } from "../components/primitives";
import { FieldRow, TextField } from "../components/fields";
import { Segmented } from "../components/Segmented";
import { existingLine, inPlacePaths, SETUP_PATHS } from "../project/setupFiles";
import { hideSetup, setSetupProblem, useSetupView, type SetupDone, type SetupPrompt } from "../app/setupView";
import { useEditor } from "../state/store";
import { useCopy } from "../app/copyText";
import { Modal } from "./Modal";
import dialogs from "./Dialogs.module.css";
import styles from "./SetupDialog.module.css";

type LibraryChoice = CommandLibrary | "none";

/** The command library as a three-way choice, so the control is plain to see (issue #414). */
const LIBRARY_OPTIONS: ReadonlyArray<{ value: LibraryChoice; label: string; does: string }> = [
  { value: "solverslib", label: LIBRARY_LABEL.solverslib, does: "The generated Java uses SolversLib's command classes." },
  { value: "ivy", label: LIBRARY_LABEL.ivy, does: "The generated Java uses Ivy's command classes." },
  { value: "none", label: "Decide later", does: "Leave the library out of zenith.json. Zenith does not pick one for you; Settings, Robot sets it later." },
];

const countOf = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;
const listed = (names: readonly string[]): string => (names.length === 0 ? "" : ` (${names.join(", ")})`);

/** Loaded on demand, like the flow it starts. */
const flow = () => import("../app/setupProject");

export function SetupDialog() {
  const { prompt, done } = useSetupView();
  if (prompt !== null) return <SetupQuestion key={prompt.folder} prompt={prompt} />;
  if (done !== null) return <SetupWritten done={done} />;
  return null;
}

const NO_CODEGEN = "zenith.json then has no codegen section, so Deploy writes no OpMode until it has one.";

/**
 * The line under the robot class, about what is typed there now (issue #502): it follows the field,
 * so a class typed into an empty one is no longer told that there is none.
 */
export function robotClassNote(prompt: Pick<SetupPrompt, "plan">, typed: string): string {
  const found = prompt.plan.robotClasses;
  const name = typed.trim();
  if (name !== "" && found.includes(name)) return "Found in TeamCode: it implements ZenithRobot.";
  if (found.length > 1) return `${String(found.length)} classes implement ZenithRobot: ${found.join(", ")}. Type the one that is your robot.`;
  if (name === "") {
    return found.length === 0
      ? `No class in TeamCode implements ZenithRobot yet. Leave it empty to add it later: ${NO_CODEGEN}`
      : `Left empty, ${NO_CODEGEN}`;
  }
  if (found.length === 1) return `TeamCode's ZenithRobot is ${found[0] as string}. Set up writes the class typed here instead.`;
  return "No class in TeamCode implements ZenithRobot, so Zenith cannot check this one. Set up writes it as typed.";
}

function libraryNote(prompt: SetupPrompt): string {
  const { library, libraryImports } = prompt.plan;
  const first = libraryImports[0];
  if (library !== null && first !== undefined) {
    return `From the import of ${first.name} in ${first.at.path}, line ${String(first.at.line)}.`;
  }
  if (libraryImports.length > 0) return "The code imports both SolversLib and Ivy, so Zenith did not choose. Pick the one your robot code uses.";
  return "No import names SolversLib or Ivy, so Zenith did not choose one. Pick the one your robot code uses, or decide later.";
}

function commandsLine(prompt: SetupPrompt): string | null {
  // A folder with a robot file of its own keeps it as it is; Import commands from Java adds to it.
  if (prompt.existing !== null && prompt.existing.robot !== null) return null;
  const { commands, conditions } = prompt.plan;
  if (commands.length === 0 && conditions.length === 0) {
    return "The code registers no NamedCommands, so robot.json starts with none. Import commands from Java adds them later.";
  }
  return `robot.json gets ${countOf(commands.length, "command")}${listed(commands)} and ${countOf(conditions.length, "condition")}${listed(conditions)} from the code. Each starting value is marked needs measurement.`;
}

/** What Set up writes, as the dialog's last line says it. */
function filesLine(prompt: SetupPrompt): string {
  if (prompt.existing === null) return `It writes ${SETUP_PATHS.join(", ")}.`;
  const paths = inPlacePaths(prompt.existing);
  return `It writes only ${paths.join(" and ")}, and moves or writes over nothing that is there.`;
}

function SetupQuestion({ prompt }: { prompt: SetupPrompt }) {
  const { busy } = useEditor();
  const [robotClass, setRobotClass] = useState(prompt.plan.robotClass);
  const [library, setLibrary] = useState<LibraryChoice>(prompt.plan.library ?? "none");
  const { folder, teamCode, plan, taken, problem, existing } = prompt;
  const classProblem = prompt.problemAt === "robotClass" ? problem : null;
  const footProblem = prompt.problemAt === "robotClass" ? null : problem;
  const commands = commandsLine(prompt);
  // A problem with the robot class was about what was typed then: editing it takes the problem away.
  const editRobotClass = (next: string): void => {
    if (classProblem !== null && next !== robotClass) setSetupProblem(null);
    setRobotClass(next);
  };
  const cancel = (): void => {
    void flow().then((module) => {
      module.cancelSetup();
    });
  };

  return (
    <Modal
      title={`Set up Zenith in ${folder}`}
      testId="setup-project"
      width={620}
      tall
      onClose={cancel}
      footer={
        <>
          <Button testId="setup-cancel" onClick={cancel}>
            Cancel
          </Button>
          <Button
            kind="primary"
            testId="setup-run"
            whyDisabled={
              busy ? "Setting up now." : taken.length > 0 ? `${folder} already has ${taken.join(", ")}. Move ${taken.length === 1 ? "it" : "them"} out of the way first.` : null
            }
            onClick={() => {
              void flow().then((module) => module.runSetup({ robotClass, library: library === "none" ? null : library }));
            }}
          >
            {existing === null ? "Set up" : "Write zenith.json"}
          </Button>
        </>
      }
    >
      <div className={styles.lead}>
        {existing === null ? (
          <p className={dialogs.prose}>
            <code className="mono">{folder}</code> has no <code className="mono">zenith.json</code>, so Zenith is not set up
            there yet.
          </p>
        ) : (
          <p className={dialogs.prose} data-testid="setup-existing">
            {existingLine(folder, existing)} Set up points zenith.json at the autos where they are.
          </p>
        )}
        <p className={styles.note} data-testid="setup-scan">
          {teamCode
            ? `Read ${countOf(plan.filesScanned, "Java or Kotlin file", "Java and Kotlin files")} in TeamCode.`
            : `${folder} has no TeamCode folder, so there was no robot code to read.`}
        </p>
      </div>
      <div className={styles.fields}>
        <TextField
          label="Robot class"
          wide
          value={robotClass}
          onChange={editRobotClass}
          onDraft={editRobotClass}
          placeholder="org.firstinspires.ftc.teamcode.robot.TeamRobot"
          testId="setup-robot-class"
          hint="Your class that implements ZenithRobot, fully qualified. Every OpMode Deploy writes constructs it."
          note={robotClassNote(prompt, robotClass)}
          problem={classProblem}
        />
        <div className={styles.choice}>
          <FieldRow label="Command library">
            <Segmented<LibraryChoice> label="Command library" options={LIBRARY_OPTIONS} value={library} onChange={setLibrary} testId="setup-library" />
          </FieldRow>
          <p className={styles.note} data-testid="setup-library-note">
            {libraryNote(prompt)}
          </p>
        </div>
      </div>
      {commands === null ? null : (
        <p className={dialogs.prose} data-testid="setup-commands">
          {commands}
        </p>
      )}
      <p className={dialogs.prose} data-testid="setup-files">
        {filesLine(prompt)}
      </p>
      {taken.length > 0 ? (
        <p className={dialogs.warn} data-testid="setup-taken">
          {folder} already has {taken.join(", ")}, so Set up would write over {taken.length === 1 ? "it" : "them"}. Move{" "}
          {taken.length === 1 ? "it" : "them"} out of the way first.
        </p>
      ) : null}
      {footProblem === null ? null : (
        <p className={dialogs.warn} data-testid="setup-problem" role="alert">
          {footProblem}
        </p>
      )}
    </Modal>
  );
}

function SetupWritten({ done }: { done: SetupDone }) {
  const { copy, label } = useCopy();
  const linesBox = useRef<HTMLPreElement | null>(null);
  const { folder, written, library, robotClass, gradle } = done;
  return (
    <Modal
      title={`Zenith is set up in ${folder}`}
      testId="setup-done"
      width={620}
      tall
      onClose={hideSetup}
      footer={
        <Button kind="primary" testId="setup-close" onClick={hideSetup}>
          Done
        </Button>
      }
    >
      <p className={dialogs.prose} data-testid="setup-written">
        Wrote {written.join(", ")}.
      </p>
      <p className={dialogs.prose}>
        {library === null
          ? "Add these lines to build.dependencies.gradle, with your command library's own line (Robot runtime, Install, has both), then sync Gradle."
          : `Add these lines to build.dependencies.gradle for the ${LIBRARY_LABEL[library]} runtime, then sync Gradle.`}
      </p>
      <pre ref={linesBox} className={dialogs.code} data-testid="setup-gradle">
        {gradle}
      </pre>
      <div className={dialogs.row}>
        <Button
          testId="setup-copy-gradle"
          onClick={() => {
            void copy("the Gradle lines", gradle, { select: linesBox.current });
          }}
        >
          {label("Copy lines")}
        </Button>
      </div>
      {robotClass === null ? (
        <p className={styles.note} data-testid="setup-no-robot-class">
          No robot class yet, so Deploy writes no OpMode.
        </p>
      ) : null}
    </Modal>
  );
}
