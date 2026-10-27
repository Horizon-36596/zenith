/**
 * The shell's dialogs: open a project, run the sim, the auto's
 * metadata, Report a bug (`report/ReportBugDialog.tsx`), the non-modal notice an import leaves, plus GitHub mode's own, which live in `apps/web/src/github/` beside the rest of it
 * (site/docs/github.md).
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { setMeta } from "@horizon36596/zenith-core";
import { firstHold, setFirstHold, startHoldKind } from "./startHolds";
import { loadExample, openFolder, openPickedFiles, simCommand, tracePath } from "../app/projectActions";
import { tryEdit } from "../app/edits";
import { pickImportFile } from "../app/importActions";
import { createAuto } from "../app/newAuto";
import { Button } from "../components/primitives";
import { NumberField, TextAreaField, TextField } from "../components/fields";
import { Tooltip } from "../components/Tooltip";
import { useFeature } from "../state/features";
import { supportsDirectoryPicker } from "../project/types";
import { isDesktop } from "../project/desktop";
import { runHighFidelitySim } from "../project/desktopActions";
import { openAutoNamed, loadTraceFile } from "../app/projectActions";
import { clearReturnToGitHub, returnsToGitHub, useCloneOrigin } from "../github/cloneOffer";
import { CommitDialog } from "../github/CommitDialog";
import { GitHubTab } from "../github/OpenFromGitHub";
import { ProposeDialog } from "../github/ProposeDialog";
import { SignInDialog } from "../github/SignInDialog";
import { setDialog, useEditor } from "../state/store";
import { TraceSummary } from "../panels/TraceSummary";
import { HostAutosDialog } from "../project/hostPanel";
import { hostRunBlockedReason, isHostMode, runInHost } from "../project/hostSession";
import { ReportBugDialog } from "../report/ReportBugDialog";
import { useCopy } from "../app/copyText";
import { Modal } from "./Modal";
import { UnsavedDialog } from "./UnsavedDialog";
import { DeleteHiddenDialog } from "./DeleteHiddenDialog";
import { LoneAutoDialog, SaveChoiceDialog, WaypointCheckDialog } from "./SaveChoiceDialog";
import { SetupDialog } from "./SetupDialog";
import { WaypointDialog } from "./WaypointDialog";
import { ImportNotice } from "./ImportNotice";
import { ImportCommandsDialog } from "./ImportCommandsDialog";
import styles from "./Dialogs.module.css";

export function Dialogs() {
  return (
    <>
      <CurrentDialog />
      <SetupDialog />
      <UnsavedDialog />
      <DeleteHiddenDialog />
      <SaveChoiceDialog />
      <WaypointCheckDialog />
      <LoneAutoDialog />
      <WaypointDialog />
      <ImportNotice />
    </>
  );
}

function CurrentDialog() {
  const { dialog } = useEditor();
  const fullSim = useFeature("fullSim");
  // In host mode the project is the host's, so "open" picks among its autos (site/docs/host-protocol.md).
  if (dialog === "open") return isHostMode() ? <HostAutosDialog /> : <OpenProjectDialog />;
  // Outside host mode Simulate offers only the full sim, which the Full sim switch hides (issue #207).
  if (dialog === "simulate") return isHostMode() ? <HostSimulateDialog /> : fullSim ? <SimulateDialog /> : null;
  if (dialog === "meta") return <MetaDialog />;
  if (dialog === "signIn") return <SignInDialog />;
  if (dialog === "commit") return <CommitDialog />;
  if (dialog === "propose") return <ProposeDialog />;
  if (dialog === "importCommands") return <ImportCommandsDialog />;
  if (dialog === "reportBug") return <ReportBugDialog />;
  return null;
}

/* ---- Open project -------------------------------------------------------- */

/**
 * Open project, which with a project open is also the auto switcher (the title bar's auto name and
 * Ctrl+O come here). With one open, what the person came for is first: the project's autos and New
 * auto, the primary button. The other ways to open a project, a folder, GitHub, the example, wait under
 * "Open another project" (issue #414). With none open it is the dialog it always was.
 */
function OpenProjectDialog() {
  const { project, busy } = useEditor();
  // Back on the GitHub tab after signing in from it; on the local folder otherwise.
  const [tab, setTab] = useState<"local" | "github">(() => (returnsToGitHub() ? "github" : "local"));
  // With a project open the other ways to open one are folded away, unless the person was mid-way
  // through one, such as signing in for GitHub.
  const [other, setOther] = useState(() => project === null || returnsToGitHub());
  useEffect(() => {
    clearReturnToGitHub();
  }, []);
  const origin = useCloneOrigin();
  const files = useRef<HTMLInputElement | null>(null);
  const canPick = supportsDirectoryPicker();
  const hasProject = project !== null;

  const openFolderButton = (
    <Button
      kind={hasProject ? "secondary" : "primary"}
      whyDisabled={busy ? "Opening a project now." : canPick ? null : "This browser has no folder picker. Pick the files instead."}
      testId="open-project-primary"
      onClick={() => {
        void openFolder();
      }}
    >
      {hasProject ? "Open another folder…" : "Open project"}
    </Button>
  );

  return (
    <Modal
      title="Open project"
      testId="open-project"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        <>
          <Button
            onClick={() => {
              setDialog(null);
            }}
          >
            Cancel
          </Button>
          {hasProject ? (
            <Button
              kind={other && tab === "github" ? "secondary" : "primary"}
              testId="open-project-new-auto"
              onClick={() => {
                setDialog(null);
                void createAuto();
              }}
            >
              New auto
            </Button>
          ) : tab === "local" ? (
            openFolderButton
          ) : null}
        </>
      }
    >
      {project === null ? null : (
        <>
          <div className={styles.recent}>
            <p className={styles.recentTitle}>{project.autoFiles.length === 0 ? `No autos in ${project.name} yet` : `Autos in ${project.name}`}</p>
            {project.autoFiles.map((fileName) => (
              <button
                key={fileName}
                type="button"
                className={styles.recentRow}
                data-testid={`open-auto-${fileName}`}
                onClick={() => {
                  void openAutoNamed(fileName);
                  setDialog(null);
                }}
              >
                <span className={styles.recentName}>{fileName}</span>
                <span className={styles.recentPath}>
                  {project.link.autosDir}/{fileName}
                </span>
              </button>
            ))}
          </div>
          <div className={styles.row}>
            <Button
              testId="open-project-import"
              onClick={() => {
                setDialog(null);
                pickImportFile();
              }}
            >
              Import from another planner…
            </Button>
          </div>
          {origin === null ? null : (
            <div className={styles.row}>
              <Tooltip
                label="Open this repository in GitHub mode"
                hint={`GitHub mode reads it from GitHub at ${origin.base} and opens pull requests for you.`}
              >
                <Button
                  testId="open-project-clone-offer"
                  onClick={() => {
                    setTab("github");
                    setOther(true);
                  }}
                >
                  Open this repository in GitHub mode
                </Button>
              </Tooltip>
              <span className={styles.hint}>
                {project.name} is a clone of {origin.owner}/{origin.repo}.
              </span>
            </div>
          )}
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={other}
            data-testid="open-project-other"
            onClick={() => {
              setOther(!other);
            }}
          >
            {other ? <ChevronDown size={16} strokeWidth={1.75} aria-hidden /> : <ChevronRight size={16} strokeWidth={1.75} aria-hidden />}
            Open another project
          </button>
        </>
      )}

      {!other ? null : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Where the project lives">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "local"}
              className={styles.tab}
              onClick={() => {
                setTab("local");
              }}
            >
              Local folder
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "github"}
              className={styles.tab}
              onClick={() => {
                setTab("github");
              }}
            >
              GitHub
            </button>
          </div>

          {tab === "local" ? (
            <>
              <p className={styles.prose}>
                Pick the folder with <code className="mono">zenith.json</code> at its root.
              </p>
              {canPick ? null : (
                <p className={styles.warn}>
                  This browser has no folder picker. Pick the files below, or use a Chromium browser; saving then
                  downloads the file instead of writing it.
                </p>
              )}
              {hasProject ? <div className={styles.row}>{openFolderButton}</div> : null}
              {canPick ? null : (
                <div className={styles.row}>
                  <label className={styles.fileLabel}>
                    Or pick single files (opens one auto)
                    <input
                      ref={files}
                      type="file"
                      multiple
                      className={styles.file}
                      data-testid="open-project-files"
                      onChange={(event) => {
                        const picked = [...(event.target.files ?? [])];
                        if (picked.length > 0) void openPickedFiles(picked);
                      }}
                    />
                  </label>
                </div>
              )}
              <div className={styles.row}>
                <Button
                  testId="load-example"
                  onClick={() => {
                    void loadExample();
                  }}
                >
                  Open the example
                </Button>
                <span className={styles.hint}>Read only: Save asks where to put your copy.</span>
              </div>
            </>
          ) : (
            <GitHubTab />
          )}
        </>
      )}
    </Modal>
  );
}

/* ---- Simulate ------------------------------------------------------------ */

function SimulateDialog() {
  const { project, repo } = useEditor();
  const command = simCommand();
  const trace = tracePath();
  const { copy, label } = useCopy();
  const commandBox = useRef<HTMLPreElement | null>(null);
  // A project from GitHub is named; the example and a folder say "your robot repository", since the
  // command runs in the team's own code either way (0.1.2 UX sweep, W1-4).
  const where = repo === null ? "your robot repository" : `${repo.owner}/${repo.repo}`;

  return (
    <Modal
      title="Simulate"
      width={640}
      testId="simulate"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        <>
          <Button
            kind={isDesktop() && command !== null ? "secondary" : "primary"}
            onClick={() => {
              setDialog(null);
            }}
          >
            Done
          </Button>
          {isDesktop() && command !== null ? (
            <Button
              kind="primary"
              testId="run-high-fidelity-sim"
              onClick={() => {
                setDialog(null);
                void runHighFidelitySim();
              }}
            >
              Run high-fidelity sim
            </Button>
          ) : null}
        </>
      }
    >
      {isDesktop() ? null : (
        <p className={styles.prose} data-testid="simulate-where">
          Run the command below in {where}, then load the trace it writes.
        </p>
      )}
      {command === null ? (
        <p className={styles.warn}>
          {project === null
            ? "No project is open."
            : "zenith.json declares no sim command, so there is nothing to run."}
        </p>
      ) : (
        <>
          <pre ref={commandBox} className={styles.code} data-testid="sim-command">
            {command}
          </pre>
          <div className={styles.row}>
            <Button
              testId="copy-sim-command"
              onClick={() => {
                void copy("the sim command", command, { select: commandBox.current });
              }}
            >
              {label("Copy command")}
            </Button>
            {trace === null ? null : <span className={styles.hint}>It writes {trace}</span>}
          </div>
        </>
      )}
      <TraceSummary />
      <LoadTrace />
    </Modal>
  );
}

/**
 * The Load trace button, shown only while the Full sim switch is on (issue #207). It opens the
 * file picker of a hidden input, so the dialog shows no native "No file chosen" text. A trace that
 * does not load is said here, beside the button, because the dialog covers the status line.
 */
function LoadTrace() {
  const fullSim = useFeature("fullSim");
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!fullSim) return null;
  return (
    <>
      <div className={styles.row}>
        <Button
          testId="load-trace-button"
          onClick={() => {
            input.current?.click();
          }}
        >
          Load trace…
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="load-trace"
          aria-label="Trace file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void loadTraceFile(file).then(setProblem);
          }}
        />
      </div>
      {problem === null ? null : (
        <p className={styles.error} role="alert" data-testid="load-trace-error">
          {problem}
        </p>
      )}
    </>
  );
}

/**
 * Simulate in host mode: the high-fidelity option is the host's own simulator, which answers with a
 * trace, instead of a sim command to copy into a robot repository this project does not have.
 */
function HostSimulateDialog() {
  const { host } = useEditor();
  const name = host?.name ?? "the host";
  const offered = host?.simulate === true;
  const blocked = hostRunBlockedReason();
  const fullSim = useFeature("fullSim");

  return (
    <Modal
      title="Simulate"
      width={640}
      testId="simulate"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        <>
          <Button
            kind={offered ? "secondary" : "primary"}
            onClick={() => {
              setDialog(null);
            }}
          >
            Done
          </Button>
          {offered ? (
            <Button
              kind="primary"
              testId="run-host-sim"
              whyDisabled={blocked}
              onClick={() => {
                setDialog(null);
                runInHost();
              }}
            >
              {host?.running === null ? `Simulate in ${name}` : `Simulating in ${name}…`}
            </Button>
          ) : null}
        </>
      }
    >
      {offered ? null : (
        // With Full sim switched off (issue #207) there is no trace to load, so the note stops at the host.
        <p className={styles.prose}>
          {fullSim ? `${name} did not offer to simulate from here, so load a trace it wrote instead.` : `${name} did not offer to simulate from here.`}
        </p>
      )}
      {offered && blocked !== null && host?.running === null ? <p className={styles.hint}>{blocked}</p> : null}
      <TraceSummary />
      <LoadTrace />
    </Modal>
  );
}

/* ---- Auto details -------------------------------------------------------- */

function MetaDialog() {
  const { auto, autoField, project } = useEditor();
  const ledger = useFeature("ledger");
  const holdKind = auto === null ? null : startHoldKind(auto, autoField ?? project?.field ?? null);

  return (
    <Modal
      title="Auto details"
      testId="auto-meta"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        <Button
          kind="primary"
          onClick={() => {
            setDialog(null);
          }}
        >
          Done
        </Button>
      }
    >
      {auto === null ? (
        <p className={styles.prose}>No auto is open.</p>
      ) : (
        <>
          <TextField label="Name" value={auto.name} disabled onChange={() => undefined} />
          <TextField
            label="Title"
            wide
            value={auto.title ?? ""}
            testId="meta-title"
            mono={false}
            onChange={(title) => {
              tryEdit((current) => setMeta(current, { title }));
            }}
          />
          <TextAreaField
            label="Description"
            value={auto.description ?? ""}
            onChange={(description) => {
              tryEdit((current) => setMeta(current, { description }));
            }}
          />
          <TextField
            label="Authors"
            wide
            mono={false}
            placeholder="Names, with commas between them"
            testId="meta-authors"
            value={(auto.authors ?? []).join(", ")}
            onChange={(value) => {
              const authors = value
                .split(",")
                .map((author) => author.trim())
                .filter((author) => author !== "");
              tryEdit((current) => setMeta(current, { authors: authors.length === 0 ? undefined : authors }));
            }}
          />
          {ledger ? (
            <NumberField<number | null>
              label="Holds at start"
              value={firstHold(auto)}
              step={1}
              digits={0}
              min={0}
              emptyStart={0}
              unit={holdKind ?? undefined}
              disabled={holdKind === null}
              testId="meta-holds"
              hint={
                holdKind === null
                  ? "Read only: the field file names no single kind of game piece, so there is nothing to count."
                  : `How many ${holdKind} the robot is preloaded with.`
              }
              onChange={(count) => {
                // An auto that preloads nothing yet gets the kind the field file places (issue #502).
                if (count !== null) tryEdit((current) => setFirstHold(current, count, holdKind));
              }}
            />
          ) : null}
        </>
      )}
    </Modal>
  );
}
