/**
 * The shell's dialogs: open a project, run the sim, the robot settings panel and the auto's
 * metadata, plus GitHub mode's own, which live in `apps/web/src/github/` beside the rest of it
 * (site/docs/github.md).
 */
import { useRef, useState } from "react";
import { setMeta } from "@horizon36596/zenith-core";
import { loadExample, openFolder, openPickedFiles, simCommand, tracePath } from "../app/projectActions";
import { tryEdit } from "../app/edits";
import { Button } from "../components/primitives";
import { NumberField, Section, TextAreaField, TextField } from "../components/fields";
import { ProvenanceChip } from "../components/primitives";
import { supportsDirectoryPicker } from "../project/types";
import { isDesktop } from "../project/desktop";
import { runHighFidelitySim } from "../project/desktopActions";
import { openAutoNamed, loadTraceFile } from "../app/projectActions";
import { CommitDialog } from "../github/CommitDialog";
import { GitHubTab } from "../github/OpenFromGitHub";
import { ProposeDialog } from "../github/ProposeDialog";
import { SignInDialog } from "../github/SignInDialog";
import { setDialog, setStatus, useEditor } from "../state/store";
import { TraceSummary } from "../panels/TraceSummary";
import { Modal } from "./Modal";
import { UnsavedDialog } from "./UnsavedDialog";
import styles from "./Dialogs.module.css";

export function Dialogs() {
  return (
    <>
      <CurrentDialog />
      <UnsavedDialog />
    </>
  );
}

function CurrentDialog() {
  const { dialog } = useEditor();
  if (dialog === "open") return <OpenProjectDialog />;
  if (dialog === "simulate") return <SimulateDialog />;
  if (dialog === "robot") return <RobotDialog />;
  if (dialog === "meta") return <MetaDialog />;
  if (dialog === "signIn") return <SignInDialog />;
  if (dialog === "commit") return <CommitDialog />;
  if (dialog === "propose") return <ProposeDialog />;
  return null;
}

/* ---- Open project -------------------------------------------------------- */

function OpenProjectDialog() {
  const { project, busy } = useEditor();
  const [tab, setTab] = useState<"local" | "github">("local");
  const files = useRef<HTMLInputElement | null>(null);
  const canPick = supportsDirectoryPicker();

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
          {tab === "local" ? (
            <Button
              kind="primary"
              disabled={busy || !canPick}
              testId="open-project-primary"
              onClick={() => {
                void openFolder();
              }}
            >
              Open project
            </Button>
          ) : null}
        </>
      }
    >
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
            Pick the robot repository folder, the one with <code className="mono">zenith.json</code>{" "}
            at its root. Zenith reads the robot, field and waypoint files it names and lists the
            autos beside them. Saving writes the canonical file back in place;{" "}
            {isDesktop()
              ? "commit, push and pull request are in the Robot menu."
              : "committing stays yours, in your terminal."}
          </p>
          {canPick ? null : (
            <p className={styles.warn}>
              This browser has no folder picker. Pick the files individually below, or open the app
              in a Chromium browser; saving then downloads the canonical file instead of writing it.
            </p>
          )}
          <div className={styles.row}>
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
          </div>
          <div className={styles.row}>
            <Button
              testId="load-example"
              onClick={() => {
                void loadExample();
              }}
            >
              Load example
            </Button>
            <span className={styles.hint}>
              examples/starter, bundled into the app. Read only: Save downloads the file.
            </span>
          </div>
          {project === null ? null : (
            <div className={styles.recent}>
              <p className={styles.recentTitle}>Autos in {project.name}</p>
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
          )}
        </>
      ) : (
        <GitHubTab />
      )}
    </Modal>
  );
}

/* ---- Simulate ------------------------------------------------------------ */

function SimulateDialog() {
  const { project } = useEditor();
  const command = simCommand();
  const trace = tracePath();
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      title="Simulate"
      width={640}
      testId="simulate"
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
      <p className={styles.prose}>
        The timeline plays one of three levels: Ideal, Instant sim or Full sim. Full sim is the robot
        repository&apos;s headless sim, the closest match to the robot:{" "}
        {isDesktop()
          ? "run it from here, or run the command below in that repository and load the trace it writes."
          : "run the command below in that repository, then load the trace it writes."}
      </p>
      {isDesktop() && command !== null ? (
        <div className={styles.row}>
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
        </div>
      ) : null}
      {command === null ? (
        <p className={styles.warn}>
          {project === null
            ? "No project is open."
            : "zenith.json declares no sim command, so there is nothing to run."}
        </p>
      ) : (
        <>
          <pre className={styles.code} data-testid="sim-command">
            {command}
          </pre>
          <div className={styles.row}>
            <Button
              testId="copy-sim-command"
              onClick={() => {
                void navigator.clipboard.writeText(command).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    setStatus("error", "The browser refused access to the clipboard.");
                  },
                );
              }}
            >
              {copied ? "Copied" : "Copy command"}
            </Button>
            {trace === null ? null : <span className={styles.hint}>It writes {trace}</span>}
          </div>
        </>
      )}
      <TraceSummary />
      <label className={styles.fileLabel}>
        Load trace
        <input
          type="file"
          accept=".json"
          className={styles.file}
          data-testid="load-trace"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void loadTraceFile(file);
          }}
        />
      </label>
    </Modal>
  );
}

/* ---- Robot settings ------------------------------------------------------ */

function RobotDialog() {
  const { project } = useEditor();
  const robot = project?.robot;

  return (
    <Modal
      title="Robot settings"
      width={560}
      testId="robot-settings"
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
      {robot === undefined ? (
        <p className={styles.prose}>No project is open.</p>
      ) : (
        <>
          <p className={styles.prose}>
            These are <code className="mono">{project?.link.robot}</code>&apos;s numbers, shown with
            the provenance each one carries. The editor reads them; the robot repository owns them,
            so change them there and reopen the project.
          </p>
          <Section title="Footprint">
            <ReadRow
              label="Start length"
              value={robot.footprint.startIn.lengthIn}
              unit="in"
              provenance={robot.footprint.startIn.provenance}
            />
            <ReadRow
              label="Start width"
              value={robot.footprint.startIn.widthIn}
              unit="in"
              provenance={robot.footprint.startIn.provenance}
            />
            <ReadRow
              label="Expanded length"
              value={robot.footprint.expandedIn.lengthIn}
              unit="in"
              provenance={robot.footprint.expandedIn.provenance}
            />
            <ReadRow
              label="Expanded width"
              value={robot.footprint.expandedIn.widthIn}
              unit="in"
              provenance={robot.footprint.expandedIn.provenance}
            />
            <ReadRow
              label="Centre of rotation x"
              value={robot.footprint.centreOfRotationIn.xIn}
              unit="in"
            />
            <ReadRow
              label="Centre of rotation y"
              value={robot.footprint.centreOfRotationIn.yIn}
              unit="in"
            />
          </Section>
          <Section title="Kinematics">
            <ReadRow
              label="Max forward"
              value={robot.kinematics.maxForwardVelInPerS.value}
              unit="in/s"
              provenance={robot.kinematics.maxForwardVelInPerS.provenance}
            />
            <ReadRow
              label="Max strafe"
              value={robot.kinematics.maxStrafeVelInPerS.value}
              unit="in/s"
              provenance={robot.kinematics.maxStrafeVelInPerS.provenance}
            />
            <ReadRow
              label="Accel"
              value={robot.kinematics.accelInPerS2.value}
              unit="in/s²"
              provenance={robot.kinematics.accelInPerS2.provenance}
            />
            <ReadRow
              label="Default speed fraction"
              value={robot.kinematics.defaultPathSpeedFraction.value}
              provenance={robot.kinematics.defaultPathSpeedFraction.provenance}
            />
          </Section>
        </>
      )}
    </Modal>
  );
}

function ReadRow({
  label,
  value,
  unit,
  provenance,
}: {
  label: string;
  value: number;
  unit?: string;
  provenance?: string;
}) {
  return (
    <div className={styles.readRow}>
      <span className={styles.readLabel}>{label}</span>
      <span className={styles.readValue}>
        {value.toFixed(3)}
        {unit === undefined ? null : <span className="unit">{unit}</span>}
      </span>
      <ProvenanceChip provenance={provenance} />
    </div>
  );
}

/* ---- Auto metadata ------------------------------------------------------- */

function MetaDialog() {
  const { auto } = useEditor();

  return (
    <Modal
      title="Auto metadata"
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
            value={(auto.authors ?? []).join(", ")}
            onChange={(value) => {
              const authors = value
                .split(",")
                .map((author) => author.trim())
                .filter((author) => author !== "");
              tryEdit((current) => setMeta(current, { authors: authors.length === 0 ? undefined : authors }));
            }}
          />
          <NumberField
            label="Holds at start"
            value={Object.values(auto.start.holds ?? {})[0] ?? null}
            step={1}
            digits={0}
            min={0}
            hint="What the robot is preloaded with, by the element kind the field file names."
            onChange={(count) => {
              const kind = Object.keys(auto.start.holds ?? {})[0];
              if (kind === undefined) return;
              tryEdit((current) => ({
                ...current,
                start: { ...current.start, holds: { [kind]: count } },
              }));
            }}
          />
        </>
      )}
    </Modal>
  );
}
