/**
 * The desktop actions' panel: progress for the high-fidelity sim, what a deploy changes, and the
 * commit / push / pull request steps. It floats over the bottom right of the editor rather than
 * blocking it, so the field stays in view while a sim runs, and it is mounted into its own root by
 * `startDesktop` so the shell's layout carries nothing for it.
 *
 * It is side work, so it has the sheet's chrome (UI_GUIDE 9.14): a title, one close (a Lucide X with
 * "Close" and Esc in its tooltip) whenever closing it is safe, Esc to close, focus moved into it when
 * it opens, and a live region on its status lines only. Questions that decide what happens to the
 * person's work (closing while a sim runs, a file changed on disk) are a modal of their own.
 */
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { Menu as MenuIcon, X } from "lucide-react";
import { pascalCase } from "@horizon36596/zenith-core";
import { Button, RowButton } from "../components/primitives";
import { Modal } from "../dialogs/Modal";
import {
  answerQuestion,
  cancelCommit,
  cancelSim,
  checkGitAgain,
  closePanel,
  commitAuto,
  commitBlockedReason,
  confirmDeploy,
  deployAutos,
  getPanel,
  getQuestion,
  gitButtons,
  openMenuAtButton,
  openPullRequest,
  panelClosable,
  pushBranch,
  runHighFidelitySim,
  signInFromGitPanel,
  signOutFromGitPanel,
  subscribePanel,
  type DesktopPanel as PanelState,
} from "./desktopActions";
import type { DesktopDeployAction, DesktopDeployResult, DesktopGitHubStatus } from "./desktopBridge";
import { useEditor } from "../state/store";
import { countOf } from "../lib/format";
import styles from "./desktop.module.css";

let mounted = false;

export function mountDesktopPanel(): void {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const host = document.createElement("div");
  host.dataset["desktopPanelHost"] = "";
  document.body.append(host);
  createRoot(host).render(
    <StrictMode>
      <MenuButton />
      <DesktopPanel />
      <DesktopQuestionModal />
    </StrictMode>,
  );
}

/**
 * The desktop window has no menu bar (the title bar is this build's, UI_GUIDE section 9.1), so the
 * native menu opens from this button, which sits in the title bar just left of the window controls.
 * F10 opens it in the same place (desktopActions.ts `openMenuAtButton`).
 */
function MenuButton() {
  return (
    <button
      type="button"
      className={styles.menuButton}
      aria-label="Menu"
      title="Menu: File, Edit, View, Robot and Help (F10)"
      data-testid="desktop-menu-button"
      data-desktop-menu-button=""
      onClick={openMenuAtButton}
    >
      <MenuIcon size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

const usePanel = (): PanelState => useSyncExternalStore(subscribePanel, getPanel, getPanel);

export function DesktopPanel() {
  const panel = usePanel();
  const ref = useRef<HTMLElement | null>(null);
  const open = panel.kind !== "none";
  // Focus moves into the panel when it opens, so Esc and Tab reach it at once; the open is a choice
  // the person just made from a menu, the toolbar or the palette.
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open, panel.kind]);
  if (panel.kind === "none") return null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || !panelClosable(panel)) return;
    event.stopPropagation();
    closePanel();
  };
  return (
    <section
      ref={ref}
      className={styles.panel}
      tabIndex={-1}
      aria-label={panelTitle(panel)}
      data-testid="desktop-panel"
      data-kind={panel.kind}
      data-phase={panel.kind === "sim" || panel.kind === "deploy" ? panel.phase : undefined}
      onKeyDown={onKeyDown}
    >
      {panel.kind === "sim" ? <SimBody panel={panel} /> : null}
      {panel.kind === "deploy" ? <DeployBody panel={panel} /> : null}
      {panel.kind === "git" ? <GitBody panel={panel} /> : null}
    </section>
  );
}

/** The panel's name for a screen reader, the same words as its title. */
function panelTitle(panel: PanelState): string {
  if (panel.kind === "sim") return "High-fidelity sim";
  if (panel.kind === "deploy") return "Deploy autos into the robot repo";
  return "Commit, push and open a pull request";
}

function Header({ title, closable = true }: { title: string; closable?: boolean }) {
  return (
    <header className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      {closable ? <RowButton icon={X} label="Close" shortcut="Esc" onClick={closePanel} testId="desktop-panel-close" /> : null}
    </header>
  );
}

/** The panel's status lines, the only part of it a screen reader hears change. */
function Live({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.live} aria-live="polite" data-testid="desktop-panel-status">
      {children}
    </div>
  );
}

/** The desktop module's own questions (desktopActions.ts `askDesktop`): Esc is the secondary choice. */
function DesktopQuestionModal() {
  const question = useSyncExternalStore(subscribePanel, getQuestion, getQuestion);
  if (question === null) return null;
  return (
    <Modal
      title={question.title}
      testId={question.testId}
      width={440}
      onClose={() => {
        answerQuestion(false);
      }}
      footer={
        <>
          <Button testId={`${question.testId}-cancel`} onClick={() => answerQuestion(false)}>
            {question.cancel}
          </Button>
          <Button kind="primary" testId={`${question.testId}-confirm`} onClick={() => answerQuestion(true)}>
            {question.confirm}
          </Button>
        </>
      }
    >
      <p className={styles.questionText}>{question.text}</p>
    </Modal>
  );
}

/**
 * The question asked before a step that takes the file on disk, while the open auto has unsaved
 * edits: the same sentence shape and buttons for the sim, deploy and commit (UI_GUIDE 9.14).
 */
function SaveFirst({ fileName, what, verb, onCancel, onConfirm, testId }: {
  fileName: string;
  what: string;
  verb: string;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
}) {
  return (
    <>
      <p className={styles.prose}>
        {fileName} has unsaved edits. {what}, so save it first.
      </p>
      <div className={styles.actions}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button kind="primary" testId={testId} onClick={onConfirm}>
          {verb}
        </Button>
      </div>
    </>
  );
}

/* ---- Sim ----------------------------------------------------------------- */

/** The sim panel's body. Exported for its test. */
export function SimBody({ panel }: { panel: Extract<PanelState, { kind: "sim" }> }) {
  const [showLog, setShowLog] = useState(false);
  const last = panel.lines[panel.lines.length - 1] ?? "Starting…";

  if (panel.phase === "confirm") {
    return (
      <>
        <Header title="High-fidelity sim" />
        <SaveFirst
          fileName={panel.fileName}
          what="The sim runs the file on disk"
          verb="Save and run"
          testId="desktop-sim-save-run"
          onCancel={closePanel}
          onConfirm={() => void runHighFidelitySim({ saveFirst: true })}
        />
      </>
    );
  }

  return (
    <>
      <Header title={`High-fidelity sim: ${panel.fileName}`} closable={panel.phase !== "running"} />
      <Live>
        {panel.phase === "running" ? (
          <p className={styles.prose} data-testid="desktop-sim-state" data-speed={panel.speed}>
            {runningText(panel)}
          </p>
        ) : null}
        {panel.phase === "done" ? (
          <p className={styles.ok}>
            {panel.cached ? "Played the run made when the auto was last saved." : `Finished in ${(panel.elapsedS ?? 0).toFixed(0)} s.`}
          </p>
        ) : null}
        {panel.phase === "failed" ? (
          // A cancel is the person's own choice, so it reads as plain text, not as a failure.
          <p className={panel.cancelled ? styles.prose : styles.error} data-testid="desktop-sim-result" data-cancelled={panel.cancelled}>
            {panel.cancelled ? "Sim cancelled." : panel.message}
          </p>
        ) : null}
      </Live>
      {panel.phase === "running" ? (
        <>
          <div className={styles.progress} role="progressbar" aria-label="Sim running" />
          <p className={styles.lastLine} title={last}>
            {last}
          </p>
        </>
      ) : null}
      {panel.phase !== "running" && panel.status !== null ? <p className={styles.prose}>{panel.status}</p> : null}

      {panel.lines.length > 0 || panel.tail.length > 0 ? (
        <>
          <button type="button" className={styles.linkButton} onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide" : "Show"} the sim&apos;s output ({countOf(panel.lines.length > 0 ? panel.lines.length : panel.tail.length, "line")})
          </button>
          {showLog ? (
            <pre className={styles.log} data-testid="desktop-sim-log">
              {(panel.lines.length > 0 ? panel.lines : panel.tail).slice(-120).join("\n")}
            </pre>
          ) : null}
        </>
      ) : null}
      <p className={styles.command} title="zenith.json sim.command">
        {panel.command}
      </p>
      <div className={styles.actions}>
        {panel.phase === "running" ? (
          <Button testId="desktop-sim-cancel" onClick={() => void cancelSim()}>
            Cancel the sim
          </Button>
        ) : (
          <>
            <Button onClick={closePanel}>Close</Button>
            <Button kind="primary" onClick={() => void runHighFidelitySim()}>
              Run again
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * What a running sim is doing, in one sentence: streaming (how far it has got), getting the sim
 * server ready, or, for Basic, the Gradle build. Exported for its test.
 */
export function runningText(panel: Extract<PanelState, { kind: "sim" }>): string {
  if (panel.receivedS !== null) return `Simulating: ${panel.receivedS.toFixed(1)} s so far. The Full sim level plays it as it arrives.`;
  if (panel.status !== null) return panel.status;
  if (panel.speed === "basic") return "The first run can take a few minutes while Gradle builds.";
  return "Starting the run on the sim server.";
}

/* ---- Deploy -------------------------------------------------------------- */

const KIND_LABEL: Record<string, string> = {
  copy: "copy",
  write: "write",
  keep: "same",
  remove: "remove",
  skip: "skipped",
};

/**
 * The reason `zenith deploy` gives for an auto it skips for errors (packages/cli/src/commands/deploy.ts).
 * The CLI keeps it, since its reader has `zenith validate`; the panel says it in the app's words,
 * because a student in the app may have no CLI.
 */
export const CLI_SKIP_REASON = "has validation errors; run zenith validate";
const APP_SKIP_REASON = "has errors; open it and see Problems";

/** What the panel shows for a row's reason. */
export const skipReason = (reason: string): string => (reason === CLI_SKIP_REASON ? APP_SKIP_REASON : reason);

/** The last part of a slash-separated path. */
const baseName = (path: string): string => path.split("/").pop() ?? "";

/**
 * How the CLI starts the reason for an auto whose "name" is not its file name (`autoFileNameMismatch`
 * in packages/cli/src/autoLoad.ts). That skip has nothing in Problems, so the summary says it plainly.
 */
const NAME_MISMATCH = /^name ".*" does not match the file name /;

/**
 * The file names the generated OpMode of a skipped auto may have. The CLI names a stub
 * `<PascalName>Auto.java` from the auto's "name" (packages/cli/src/commands/deploy.ts), which the
 * skip carries when its file loaded. The file name is the other: the last deploy that took the auto
 * needed its name to match it, and a desktop build older than `autoName` sends nothing else.
 */
function stubNamesOf(skip: DesktopDeployAction): string[] {
  const fromFile = `${pascalCase(baseName(skip.path).replace(/\.auto\.json$/, ""))}Auto.java`;
  return skip.autoName === undefined ? [fromFile] : [`${pascalCase(skip.autoName)}Auto.java`, fromFile];
}

/**
 * How many of the deploy's own removals are the generated OpMode of one of `skips`. The CLI writes
 * none for a skipped auto, so one it wrote before is removed: the auto drops off the Driver Station
 * because it was skipped, not because it was deleted.
 */
function stubRemovalsOf(actions: readonly DesktopDeployAction[], skips: readonly DesktopDeployAction[]): number {
  const stubs = new Set(skips.flatMap(stubNamesOf));
  return actions.filter((action) => action.kind === "remove" && action.changed && stubs.has(baseName(action.path))).length;
}

/**
 * The deploy panel's summary line and its tone. With no skipped auto it counts the files that change,
 * in green. With one it leads with the skipped autos and any OpMode removed because of them, never in
 * green: a removal caused by a skip is not a success. An auto skipped for errors is told apart from
 * one skipped for another reason, such as a "name" that is not its file name, which Problems does
 * not list.
 */
export function deploySummary(result: DesktopDeployResult, done: boolean): { text: string; tone: "prose" | "ok" | "warn" } {
  const files = (count: number, kind = "file"): string => `${countOf(count, kind)} ${done ? "changed" : "will change"}.`;
  if (result.errors === 0) {
    return result.changed === 0
      ? { text: "Everything is already up to date.", tone: "prose" }
      : { text: files(result.changed), tone: "ok" };
  }
  const be = (count: number): string => (done ? (count === 1 ? "was" : "were") : count === 1 ? "is" : "are");
  const itThem = (count: number): string => (count === 1 ? "it" : "them");
  const skips = result.actions.filter((action) => action.kind === "skip");
  const invalid = skips.filter((action) => action.reason === CLI_SKIP_REASON);
  const others = skips.filter((action) => action.reason !== CLI_SKIP_REASON);
  // A result with no skip rows still counts its skipped autos; they can only be the errors kind.
  const errorCount = skips.length === 0 ? result.errors : invalid.length;
  const sentences: string[] = [];
  let removedAll = 0;

  if (errorCount > 0) {
    const one = errorCount === 1;
    const removed = stubRemovalsOf(result.actions, invalid);
    removedAll += removed;
    let text = `${countOf(errorCount, "auto")} ${one ? "has" : "have"} errors, so ${one ? "it" : "they"} ${be(errorCount)} skipped`;
    if (removed > 0) {
      const stubs =
        removed === errorCount ? `${one ? "its" : "their"} generated ${removed === 1 ? "OpMode" : "OpModes"}` : countOf(removed, "generated OpMode");
      text += ` and ${stubs} ${be(removed)} removed: the Driver Station will not list ${itThem(removed)} until the errors are fixed`;
    }
    sentences.push(`${text}.`);
  }

  if (others.length > 0) {
    const one = others.length === 1;
    const removed = stubRemovalsOf(result.actions, others);
    removedAll += removed;
    const why = others.every((action) => NAME_MISMATCH.test(action.reason ?? ""))
      ? one
        ? "its name does not match its file name"
        : "their names do not match their file names"
      : "the list says why";
    let text = `${countOf(others.length, "auto")} ${be(others.length)} skipped: ${why}`;
    if (removed > 0) {
      const stubs =
        removed === others.length ? `${one ? "its" : "their"} generated ${removed === 1 ? "OpMode" : "OpModes"}` : countOf(removed, "generated OpMode");
      text += `, so ${stubs} ${be(removed)} removed and the Driver Station will not list ${itThem(removed)}`;
    }
    sentences.push(`${text}.`);
  }

  const other = result.changed - removedAll;
  sentences.push(other > 0 ? files(other, "other file") : done ? "Nothing else changed." : "Nothing else changes.");
  return { text: sentences.join(" "), tone: "warn" };
}

/** The command library the stubs extend, named the way robot/README.md names it. */
const RUNTIME_LABEL: Record<"solverslib" | "ivy", { name: string; pkg: string }> = {
  solverslib: { name: "SolversLib", pkg: "org.horizon36596.zenith.solverslib" },
  ivy: { name: "Ivy", pkg: "org.horizon36596.zenith.ivy" },
};

/** The deploy panel's body. Exported for its test, which renders it without the floating panel. */
export function DeployBody({ panel }: { panel: Extract<PanelState, { kind: "deploy" }> }) {
  const [showSame, setShowSame] = useState(false);
  const editor = useEditor();
  const result = panel.result;
  const rows = result === null ? [] : result.actions.filter((action) => showSame || action.changed || action.kind === "skip");
  const same = result === null ? 0 : result.actions.filter((action) => !action.changed && action.kind !== "skip").length;
  // A desktop build older than the flag (issue #156) sends no `stubs`; it wrote stubs exactly when it
  // reported a library, so that is the fallback.
  const stubs = result === null ? false : (result.stubs ?? result.commandLibrary !== null);
  const summary = result === null ? null : deploySummary(result, panel.phase === "done");
  const running = panel.phase === "running";

  if (panel.phase === "confirm") {
    return (
      <>
        <Header title="Deploy autos into the robot repo" />
        <SaveFirst
          fileName={editor.fileName ?? "The open auto"}
          what="Deploy copies the files on disk"
          verb="Save and preview"
          testId="desktop-deploy-save"
          onCancel={closePanel}
          onConfirm={() => void deployAutos({ saveFirst: true })}
        />
      </>
    );
  }

  return (
    <>
      <Header title="Deploy autos into the robot repo" closable={!running} />
      <Live>
        {panel.phase === "loading" ? <p className={styles.prose}>Working out what would change…</p> : null}
        {running ? <p className={styles.prose}>Deploying…</p> : null}
        {panel.phase === "failed" ? <p className={styles.error}>{panel.message}</p> : null}
        {summary === null ? null : (
          <p className={styles[summary.tone]} data-testid="desktop-deploy-summary" data-tone={summary.tone}>
            {summary.text}
          </p>
        )}
      </Live>
      {result !== null ? (
        <>
          <p className={styles.prose}>
            {panel.phase === "done" ? "Deployed. " : ""}
            Copies every valid auto, the waypoints, the robot and the field file into{" "}
            <code className={styles.code}>{result.deployDir}</code>
            {stubs ? " and refreshes the generated OpMode stubs" : ""}. Nothing is installed on the robot.
          </p>
          {!stubs || result.commandLibrary === null ? (
            <p className={styles.warn} data-testid="desktop-deploy-library">
              No OpMode is written, because <code className={styles.code}>zenith.json</code> has no{" "}
              <code className={styles.code}>codegen</code> section, so the Driver Station will not list these autos
              unless your own OpModes load them.
            </p>
          ) : (
            <p className={styles.prose} data-testid="desktop-deploy-library">
              The stubs run on the {RUNTIME_LABEL[result.commandLibrary].name} runtime (
              <code className={styles.code}>{RUNTIME_LABEL[result.commandLibrary].pkg}</code>).
            </p>
          )}
          {rows.length > 0 ? (
            <ul className={styles.list} data-testid="desktop-deploy-list">
              {rows.map((action) => (
                <li key={`${action.kind}:${action.path}`} className={action.kind === "skip" ? styles.skipRow : undefined}>
                  <span className={styles.chip}>{KIND_LABEL[action.kind] ?? action.kind}</span>
                  <span className={styles.path} title={action.path}>
                    {action.path}
                  </span>
                  {action.reason === undefined ? null : <span className={styles.reason}>{skipReason(action.reason)}</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {same > 0 ? (
            <button type="button" className={styles.linkButton} onClick={() => setShowSame(!showSame)}>
              {showSame ? "Hide" : "Show"} {countOf(same, "unchanged file")}
            </button>
          ) : null}
        </>
      ) : null}
      {/* A running deploy has no way out: it is short, and stopping it half way would leave the repo half written. */}
      {running ? null : (
        <div className={styles.actions}>
          <Button onClick={closePanel}>{panel.phase === "done" || panel.phase === "failed" ? "Close" : "Cancel"}</Button>
          {panel.phase === "preview" ? (
            <Button kind="primary" testId="desktop-deploy-confirm" onClick={() => void confirmDeploy()}>
              {result !== null && result.changed === 0 ? "Deploy anyway" : "Deploy"}
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

/* ---- Git ----------------------------------------------------------------- */

/** Where the desktop app's GitHub sign-in came from, in the words the sign-in dialog uses. */
function signedInAs(github: DesktopGitHubStatus): string {
  const who = github.login ?? "GitHub";
  if (github.source === "gh") return `Signed in as ${who}, through the GitHub CLI.`;
  if (github.source === "stored") return `Signed in as ${who}. The token is kept encrypted on this computer.`;
  return `Signed in as ${who} until Zenith closes.`;
}

/** What the GitHub CLI could do for someone with no token, or null when there is nothing to add. */
function cliSentence(github: DesktopGitHubStatus): string | null {
  if (github.cli === "missing") return "Or install the GitHub CLI and run gh auth login, then check again.";
  if (github.cli === "signed-out") return "Or run gh auth login in a terminal, then check again.";
  return null;
}

/** The git panel's body. Exported for its test, which renders it without the floating panel. */
export function GitBody({ panel }: { panel: Extract<PanelState, { kind: "git" }> }) {
  const [summary, setSummary] = useState("");
  const status = panel.status;
  const github = panel.github;
  const autoName = panel.fileName?.replace(/\.auto\.json$/, "") ?? null;
  const busy = panel.busy !== null;
  // Live, so an edit or a save while the panel is open turns Commit back on.
  const editor = useEditor();
  const buttons = gitButtons(panel, editor);
  const nothingToCommit = autoName === null ? null : commitBlockedReason(panel, editor);
  const message = autoName === null ? null : `auto(${autoName}): ${summary.trim() === "" ? "edit" : summary.trim()}`;
  const isRepo = status?.isRepo === true;
  // One line under the row: why the primary is off, else the first other button that is.
  const why = busy ? null : (buttons[buttons.primary] ?? (buttons.commit === nothingToCommit ? null : buttons.commit) ?? buttons.push ?? buttons.pr);

  if (panel.confirmCommit && panel.fileName !== null) {
    return (
      <>
        <Header title="Commit, push and open a pull request" />
        <SaveFirst
          fileName={panel.fileName}
          what="A commit takes the file on disk"
          verb="Save and commit"
          testId="desktop-git-save-commit"
          onCancel={cancelCommit}
          onConfirm={() => void commitAuto(summary, { saveFirst: true })}
        />
      </>
    );
  }

  return (
    <>
      <Header title="Commit, push and open a pull request" />
      {status !== null && !status.isRepo ? (
        <p className={styles.error}>
          This folder is not a git repository, so there is nothing to commit to. Open the robot repository folder, or run git init in this one.
        </p>
      ) : null}
      {isRepo ? (
        <dl className={styles.facts}>
          <dt>Branch</dt>
          <dd>
            {status.branch ?? "detached HEAD"}
            {status.onBase && status.workBranch !== null ? (
              <span className={styles.note}> Committing moves your work to {status.workBranch}. Zenith never writes to {status.base}.</span>
            ) : null}
          </dd>
          <dt>Changed autos</dt>
          <dd>
            {status.changedAutos.length === 0 ? "none" : status.changedAutos.map((file) => file.path.split("/").pop()).join(", ")}
            {status.otherChanges > 0 ? (
              <span className={styles.note}> Zenith leaves the other {countOf(status.otherChanges, "changed file")} alone.</span>
            ) : null}
          </dd>
          <dt>GitHub</dt>
          <dd data-testid="desktop-git-github">
            {github === null ? (
              "Checking…"
            ) : github.source === null ? (
              <>
                Not signed in. Open pull request needs GitHub.{" "}
                <button type="button" className={styles.linkButton} onClick={signInFromGitPanel} data-testid="desktop-git-sign-in">
                  Sign in to GitHub…
                </button>
                {cliSentence(github) === null ? null : (
                  <span className={styles.note}>
                    {" "}
                    {cliSentence(github)}{" "}
                    <button type="button" className={styles.linkButton} onClick={() => void checkGitAgain()} data-testid="desktop-git-check-again">
                      Check again
                    </button>
                  </span>
                )}
              </>
            ) : (
              <>
                {signedInAs(github)}{" "}
                {github.source === "gh" ? null : (
                  <button type="button" className={styles.linkButton} onClick={() => void signOutFromGitPanel()} data-testid="desktop-git-sign-out">
                    Sign out
                  </button>
                )}
              </>
            )}
          </dd>
        </dl>
      ) : null}

      {autoName === null ? <p className={styles.prose}>No auto is open. Open the auto to commit, then open this panel again.</p> : null}
      {autoName !== null && isRepo ? (
        <label className={styles.field}>
          <span>What changed (optional)</span>
          <input
            className={styles.input}
            value={summary}
            placeholder="edit"
            maxLength={120}
            data-testid="desktop-commit-summary"
            onChange={(event) => setSummary(event.target.value)}
          />
          <span className={styles.command}>{message}</span>
        </label>
      ) : null}
      {nothingToCommit !== null && isRepo ? (
        <p className={styles.prose} data-testid="desktop-git-nothing">
          {nothingToCommit}
        </p>
      ) : null}

      <Live>
        {panel.busy !== null ? <p className={styles.prose}>{panel.busy}</p> : null}
        {panel.error !== null ? <p className={styles.error}>{panel.error}</p> : null}
        {panel.log.length > 0 ? (
          <ul className={styles.list}>
            {panel.log.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {panel.prUrl !== null ? (
          <p className={styles.ok}>
            <a href={panel.prUrl} target="_blank" rel="noreferrer">
              Open the pull request on GitHub
            </a>
          </p>
        ) : null}
      </Live>

      <div className={styles.actions}>
        <Button
          kind={buttons.primary === "commit" ? "primary" : "ghost"}
          disabled={busy || buttons.commit !== null}
          testId="desktop-git-commit"
          onClick={() => void commitAuto(summary)}
        >
          Commit
        </Button>
        <Button
          kind={buttons.primary === "push" ? "primary" : "ghost"}
          disabled={busy || buttons.push !== null}
          testId="desktop-git-push"
          onClick={() => void pushBranch()}
        >
          Push
        </Button>
        <Button
          kind={buttons.primary === "pr" ? "primary" : "ghost"}
          disabled={busy || buttons.pr !== null}
          testId="desktop-git-pr"
          onClick={() => void openPullRequest()}
        >
          Open pull request
        </Button>
      </div>
      {why === null ? (
        isRepo && buttons.pr === null ? <p className={styles.note}>Open pull request pushes the branch first.</p> : null
      ) : (
        <p className={styles.note} data-testid="desktop-git-why">
          {why}
        </p>
      )}
    </>
  );
}
