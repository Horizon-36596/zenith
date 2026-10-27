/**
 * Import commands from Java (site/docs/editor.md#import-commands-from-java): read the robot's
 * `NamedCommands` registrations from its own code, show what would change in `robot.json`, and
 * write it only when the person applies. The logic is `app/commandImport.ts`; this is the dialog.
 */
import { useState } from "react";
import type { SourceFile } from "@horizon36596/zenith-import";
import { parseRobot } from "@horizon36596/zenith-schema";
import {
  defaultScanDir,
  planCommandImport,
  sourcesFromDirectory,
  sourcesFromGitHub,
  sourcesFromPickedFiles,
  type CommandImportPlan,
} from "../app/commandImport";
import { say } from "../app/projectActions";
import { Button } from "../components/primitives";
import { TextField } from "../components/fields";
import type { GitHubBackend } from "../github/backend";
import { downloadText } from "../project/fallback";
import { ensureWritable, writeTextAt } from "../project/local";
import { saveProjectRobot } from "../settings/actions";
import { clearStatus, getState, replaceProjectRobot, setBusy, setDialog, setStatus, useEditor } from "../state/store";
import { Modal } from "./Modal";
import styles from "./ImportCommandsDialog.module.css";
import dialogStyles from "./Dialogs.module.css";

interface Planned {
  plan: CommandImportPlan;
  /** Where the sources came from, for the summary line. */
  from: string;
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;
const baseName = (path: string): string => path.split("/").pop() ?? path;

export function ImportCommandsDialog() {
  const { project, backend, busy } = useEditor();
  const [dir, setDir] = useState(() => defaultScanDir(project?.link));
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const close = (): void => {
    setDialog(null);
  };

  if (project === null) {
    return (
      <Modal title="Import commands from Java" testId="import-commands" onClose={close} footer={<Button onClick={close}>Close</Button>}>
        <p className={dialogStyles.prose}>Open a project first.</p>
      </Modal>
    );
  }

  const source = project.source;
  const canScanFolder = source.kind === "directory";
  const canScanRepository = source.kind === "github" && backend?.kind === "github";
  const writesInPlace = source.kind === "directory" || (source.kind === "desktop" && backend?.writeRobot !== undefined);

  const run = async (from: string, read: () => Promise<SourceFile[]>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const sources = await read();
      const current = getState().project;
      if (current === null) return;
      setPlanned({ plan: planCommandImport(current.robot, sources), from });
    } catch (error) {
      setPlanned(null);
      setProblem(say(error));
    } finally {
      // The GitHub scan's progress line is only true while it runs.
      if (getState().status?.message.endsWith("from GitHub…") === true) clearStatus();
      setBusy(false);
    }
  };

  const pick = (folder: boolean): void => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.accept = ".java,.kt";
    if (folder) input.setAttribute("webkitdirectory", "");
    input.dataset["testid"] = folder ? "import-commands-folder-input" : "import-commands-files-input";
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length > 0) {
        void run(folder ? "the folder you picked" : "the files you picked", () =>
          sourcesFromPickedFiles(files, source.kind === "directory" ? source.handle.name : null),
        );
      }
    });
    input.addEventListener("cancel", () => {
      input.remove();
    });
    document.body.append(input);
    input.click();
  };

  const apply = async (): Promise<void> => {
    if (planned === null) return;
    const { after } = planned.plan;
    setBusy(true);
    try {
      const robot = parseRobot(JSON.parse(after));
      if (source.kind === "directory") {
        if (!(await ensureWritable(source.handle))) {
          setProblem("The browser did not allow writing to this folder, so robot.json was not changed.");
          return;
        }
        await writeTextAt(source.handle, project.link.robot, after);
        replaceProjectRobot(robot);
        setStatus("ok", `Wrote ${project.link.robot} with ${plural(planned.plan.merge.changes.length, "addition")}.`);
      } else if (source.kind === "desktop" && backend?.writeRobot !== undefined) {
        // The desktop app writes robot.json through its one narrow channel (`writeRobot`).
        const outcome = await saveProjectRobot(robot);
        if (!outcome.ok) {
          setProblem(outcome.message);
          return;
        }
        setStatus("ok", `Wrote ${project.link.robot} with ${plural(planned.plan.merge.changes.length, "addition")}.`);
      } else {
        downloadText(baseName(project.link.robot), after);
        replaceProjectRobot(robot);
        setStatus(
          "info",
          `Downloaded the new ${baseName(project.link.robot)}. Put it at ${project.link.robot} in the robot repository and commit it; the editor uses it until the project is reopened.`,
        );
      }
      setDialog(null);
    } catch (error) {
      setProblem(say(error));
    } finally {
      setBusy(false);
    }
  };

  const changes = planned?.plan.merge.changes ?? [];
  const findings = planned?.plan.merge.findings ?? [];

  return (
    <Modal
      title="Import commands from Java"
      width={720}
      tall
      testId="import-commands"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          {/* Before a scan the scan is the one primary; Write takes it once there is something to write. */}
          <Button
            kind={planned === null ? "secondary" : "primary"}
            whyDisabled={
              busy
                ? "Wait for the scan to finish."
                : planned === null
                  ? "Scan the robot code first, to see what it adds."
                  : changes.length === 0
                    ? `${baseName(project.link.robot)} already has every command the scan found.`
                    : null
            }
            testId="import-commands-apply"
            onClick={() => {
              void apply();
            }}
          >
            {writesInPlace ? `Write ${baseName(project.link.robot)}` : `Download ${baseName(project.link.robot)}`}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={dialogStyles.prose}>
          Adds what <code className="mono">{project.link.robot}</code> is missing from your robot&apos;s registered
          commands and conditions. Nothing you wrote there changes. New commands get an estimate of
          &quot;unknown&quot;.
        </p>
        {canScanFolder || canScanRepository ? (
          <TextField
            label="Folder to scan"
            value={dir}
            onChange={setDir}
            testId="import-commands-dir"
            hint="The folder, inside the project, that holds the robot code: zenith.json's javaDir when it is set. Leave it empty to scan the whole project."
          />
        ) : null}
        <div className={dialogStyles.row}>
          {canScanFolder ? (
            <Button
              kind={planned === null ? "primary" : "secondary"}
              whyDisabled={busy ? "A scan is already running." : null}
              testId="import-commands-scan-folder"
              onClick={() => {
                if (source.kind === "directory") void run(dir.trim() === "" ? "the project folder" : dir.trim(), () => sourcesFromDirectory(source.handle, dir));
              }}
            >
              Scan this folder
            </Button>
          ) : null}
          {canScanRepository ? (
            <Button
              kind={planned === null ? "primary" : "secondary"}
              whyDisabled={busy ? "A scan is already running." : null}
              testId="import-commands-scan-repository"
              onClick={() => {
                const github = backend as GitHubBackend;
                void run(`${github.owner}/${github.repo}`, () =>
                  sourcesFromGitHub(github, dir, (read) => {
                    setStatus("info", `Read ${plural(read, "source file")} from GitHub…`);
                  }),
                );
              }}
            >
              Scan the repository
            </Button>
          ) : null}
          <Button
            whyDisabled={busy ? "A scan is already running." : null}
            testId="import-commands-pick-folder"
            onClick={() => {
              pick(true);
            }}
          >
            Pick a folder…
          </Button>
          <Button
            whyDisabled={busy ? "A scan is already running." : null}
            testId="import-commands-pick-files"
            onClick={() => {
              pick(false);
            }}
          >
            Pick files…
          </Button>
        </div>

        {problem === null ? null : (
          <p className={dialogStyles.warn} data-testid="import-commands-problem">
            {problem}
          </p>
        )}

        {planned === null ? null : (
          <>
            <p className={styles.summary} data-testid="import-commands-summary">
              Read {plural(planned.plan.scan.filesScanned, "file")} from {planned.from}:{" "}
              {plural(planned.plan.scan.commands.length, "command")} and{" "}
              {plural(planned.plan.scan.conditions.length, "condition")} registered.{" "}
              {changes.length === 0
                ? `${project.link.robot} already declares all of them.`
                : `${plural(changes.length, "addition")} to ${project.link.robot}.`}
            </p>
            {changes.length === 0 ? null : (
              <ul className={styles.list} data-testid="import-commands-changes">
                {changes.map((change) => (
                  <li key={`${change.kind}:${change.name}:${change.key ?? ""}`}>{change.message}</li>
                ))}
              </ul>
            )}
            {findings.length === 0 ? null : (
              <>
                <h3 className={styles.heading}>Still to settle by hand</h3>
                <div data-testid="import-commands-findings">
                  {findings.map((finding, index) => (
                    <div className={styles.finding} key={index}>
                      <span className={`${styles.severity} ${styles[finding.severity] ?? ""}`}>{finding.severity}</span>
                      <span>
                        {finding.subject === "scan" && finding.at !== undefined ? `${finding.at.path}:${String(finding.at.line)}: ` : ""}
                        {finding.message}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {planned.plan.hunks.length === 0 ? null : (
              <>
                <h3 className={styles.heading}>What changes in {project.link.robot}</h3>
                <pre className={styles.diff} data-testid="import-commands-diff">
                  {planned.plan.hunks.map((line, index) =>
                    line === null ? (
                      <span className={styles.gap} key={index}>
                        …
                      </span>
                    ) : (
                      <span
                        className={line.op === "+" ? styles.added : line.op === "-" ? styles.removed : styles.line}
                        key={index}
                      >
                        {`${line.op} ${line.text}`}
                      </span>
                    ),
                  )}
                </pre>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
