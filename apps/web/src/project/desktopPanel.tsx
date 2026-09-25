/**
 * The desktop actions' panel: progress for the high-fidelity sim, what a deploy changes, and the
 * commit / push / pull request steps. It floats over the bottom right of the editor rather than
 * blocking it, so the field stays in view while a sim runs, and it is mounted into its own root by
 * `startDesktop` so the shell's layout carries nothing for it.
 */
import { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Menu as MenuIcon } from "lucide-react";
import { Button } from "../components/primitives";
import {
  cancelSim,
  closePanel,
  commitAuto,
  confirmDeploy,
  forgetGitHubToken,
  getPanel,
  openPullRequest,
  pushBranch,
  runHighFidelitySim,
  setGitHubToken,
  subscribePanel,
  type DesktopPanel as PanelState,
} from "./desktopActions";
import { desktopBridge } from "./desktop";
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
    </StrictMode>,
  );
}

/**
 * The desktop window has no menu bar (the title bar is this build's, UI_GUIDE section 9.1), so the
 * native menu opens from this button, which sits in the title bar just left of the window controls.
 */
function MenuButton() {
  return (
    <button
      type="button"
      className={styles.menuButton}
      aria-label="Menu"
      title="Menu: File, Edit, View, Robot and Help (F10)"
      data-testid="desktop-menu-button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        void desktopBridge()?.showMenu(rect.left, rect.bottom);
      }}
    >
      <MenuIcon size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

const usePanel = (): PanelState => useSyncExternalStore(subscribePanel, getPanel, getPanel);

export function DesktopPanel() {
  const panel = usePanel();
  if (panel.kind === "none") return null;
  return (
    <section
      className={styles.panel}
      aria-live="polite"
      data-testid="desktop-panel"
      data-kind={panel.kind}
      data-phase={panel.kind === "sim" ? panel.phase : undefined}
    >
      {panel.kind === "sim" ? <SimBody panel={panel} /> : null}
      {panel.kind === "deploy" ? <DeployBody panel={panel} /> : null}
      {panel.kind === "git" ? <GitBody panel={panel} /> : null}
    </section>
  );
}

function Header({ title, closable = true }: { title: string; closable?: boolean }) {
  return (
    <header className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      {closable ? (
        <button type="button" className={styles.close} aria-label="Close" title="Close" onClick={closePanel}>
          ×
        </button>
      ) : null}
    </header>
  );
}

/* ---- Sim ----------------------------------------------------------------- */

function SimBody({ panel }: { panel: Extract<PanelState, { kind: "sim" }> }) {
  const [showLog, setShowLog] = useState(false);
  const last = panel.lines[panel.lines.length - 1] ?? "Starting…";

  if (panel.phase === "confirm") {
    return (
      <>
        <Header title="High-fidelity sim" />
        <p className={styles.prose}>
          {panel.fileName} has unsaved edits. The sim runs the file on disk, so save it first.
        </p>
        <div className={styles.actions}>
          <Button onClick={closePanel}>Cancel</Button>
          <Button kind="primary" testId="desktop-sim-save-run" onClick={() => void runHighFidelitySim({ saveFirst: true })}>
            Save and run
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <Header title={`High-fidelity sim: ${panel.fileName}`} closable={panel.phase !== "running"} />
      {panel.phase === "running" ? (
        <>
          <p className={styles.prose}>
            Running the robot code&apos;s own simulator. The first run can take a few minutes while Gradle
            builds; later runs are faster.
          </p>
          <div className={styles.progress} role="progressbar" aria-label="Sim running" />
          <p className={styles.lastLine} title={last}>
            {last}
          </p>
        </>
      ) : null}
      {panel.phase === "done" ? (
        <p className={styles.ok}>
          Finished in {(panel.elapsedS ?? 0).toFixed(0)} s. The simulated path is drawn over the plan, and the
          timeline shows the actual times.
        </p>
      ) : null}
      {panel.phase === "failed" ? <p className={styles.error}>{panel.message}</p> : null}

      {panel.lines.length > 0 || panel.tail.length > 0 ? (
        <>
          <button type="button" className={styles.linkButton} onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide" : "Show"} the sim&apos;s output ({String(panel.lines.length)} lines)
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

/* ---- Deploy -------------------------------------------------------------- */

const KIND_LABEL: Record<string, string> = {
  copy: "copy",
  write: "write",
  keep: "same",
  remove: "remove",
  skip: "skipped",
};

/** The command library the stubs extend, named the way robot/README.md names it. */
const RUNTIME_LABEL: Record<"solverslib" | "ivy", { name: string; pkg: string }> = {
  solverslib: { name: "SolversLib", pkg: "org.horizon36596.zenith.solverslib" },
  ivy: { name: "Ivy", pkg: "org.horizon36596.zenith.ivy" },
};

function DeployBody({ panel }: { panel: Extract<PanelState, { kind: "deploy" }> }) {
  const [showSame, setShowSame] = useState(false);
  const result = panel.result;
  const rows = result === null ? [] : result.actions.filter((action) => showSame || action.changed || action.kind === "skip");
  const same = result === null ? 0 : result.actions.filter((action) => !action.changed && action.kind !== "skip").length;

  return (
    <>
      <Header title="Deploy autos into the robot repo" closable={panel.phase !== "running"} />
      {panel.phase === "loading" ? <p className={styles.prose}>Working out what would change…</p> : null}
      {panel.phase === "failed" ? <p className={styles.error}>{panel.message}</p> : null}
      {result !== null ? (
        <>
          <p className={styles.prose}>
            {panel.phase === "done" ? "Deployed. " : ""}
            Copies every valid auto, the waypoints, the robot and the field file into{" "}
            <code className={styles.code}>{result.deployDir}</code> and refreshes the generated OpMode stubs, so the
            next build of the robot code carries them. Nothing is installed on the robot.
          </p>
          {result.commandLibrary === null ? (
            <p className={styles.prose} data-testid="desktop-deploy-library">
              No OpMode stubs are written, because <code className={styles.code}>zenith.json</code> has no{" "}
              <code className={styles.code}>codegen</code> section, so no command library is needed.
            </p>
          ) : (
            <p className={styles.prose} data-testid="desktop-deploy-library">
              The stubs run on the {RUNTIME_LABEL[result.commandLibrary].name} runtime (
              <code className={styles.code}>{RUNTIME_LABEL[result.commandLibrary].pkg}</code>), from{" "}
              <code className={styles.code}>deploy.commandLibrary</code> in <code className={styles.code}>zenith.json</code>.
            </p>
          )}
          <p className={result.changed === 0 ? styles.prose : styles.ok}>
            {result.changed === 0
              ? "Everything is already up to date."
              : `${String(result.changed)} file${result.changed === 1 ? "" : "s"} ${panel.phase === "done" ? "changed" : "will change"}.`}
            {result.errors > 0
              ? ` ${String(result.errors)} auto${result.errors === 1 ? " is" : "s are"} skipped for validation errors.`
              : ""}
          </p>
          {rows.length > 0 ? (
            <ul className={styles.list} data-testid="desktop-deploy-list">
              {rows.map((action) => (
                <li key={`${action.kind}:${action.path}`} className={action.kind === "skip" ? styles.skipRow : undefined}>
                  <span className={styles.chip}>{KIND_LABEL[action.kind] ?? action.kind}</span>
                  <span className={styles.path} title={action.path}>
                    {action.path}
                  </span>
                  {action.reason === undefined ? null : <span className={styles.reason}>{action.reason}</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {same > 0 ? (
            <button type="button" className={styles.linkButton} onClick={() => setShowSame(!showSame)}>
              {showSame ? "Hide" : "Show"} {String(same)} unchanged file{same === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      ) : null}
      <div className={styles.actions}>
        <Button onClick={closePanel}>{panel.phase === "done" ? "Close" : "Cancel"}</Button>
        {panel.phase === "preview" ? (
          <Button kind="primary" testId="desktop-deploy-confirm" onClick={() => void confirmDeploy()}>
            {result !== null && result.changed === 0 ? "Deploy anyway" : "Deploy"}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/* ---- Git ----------------------------------------------------------------- */

function GitBody({ panel }: { panel: Extract<PanelState, { kind: "git" }> }) {
  const [summary, setSummary] = useState("");
  const [token, setToken] = useState("");
  const status = panel.status;
  const github = panel.github;
  const autoName = panel.fileName?.replace(/\.auto\.json$/, "") ?? null;
  const busy = panel.busy !== null;
  const message = autoName === null ? null : `auto(${autoName}): ${summary.trim() === "" ? "edit" : summary.trim()}`;

  return (
    <>
      <Header title="Commit, push and open a pull request" closable={!busy} />
      {status !== null && !status.isRepo ? (
        <p className={styles.error}>This folder is not a git repository, so there is nothing to commit to.</p>
      ) : null}
      {status !== null && status.isRepo ? (
        <dl className={styles.facts}>
          <dt>Branch</dt>
          <dd>
            {status.branch ?? "detached HEAD"}
            {status.onBase && status.workBranch !== null ? (
              <span className={styles.note}> Committing moves your work to {status.workBranch}; {status.base} is never written.</span>
            ) : null}
          </dd>
          <dt>Changed autos</dt>
          <dd>
            {status.changedAutos.length === 0
              ? "none"
              : status.changedAutos.map((file) => file.path.split("/").pop()).join(", ")}
            {status.otherChanges > 0 ? (
              <span className={styles.note}> ({String(status.otherChanges)} other changed file{status.otherChanges === 1 ? "" : "s"} are left alone.)</span>
            ) : null}
          </dd>
          <dt>GitHub</dt>
          <dd>
            {github === null
              ? "…"
              : github.source === null
                ? "No token yet."
                : `${github.login ?? "Signed in"} (${github.source === "gh" ? "from the GitHub CLI" : github.source === "stored" ? "saved token, encrypted" : "this session only"})`}
          </dd>
        </dl>
      ) : null}

      {autoName === null ? <p className={styles.prose}>Open an auto to commit it.</p> : null}
      {autoName !== null && status?.isRepo === true ? (
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

      {github !== null && github.source === null && status?.isRepo === true ? (
        <label className={styles.field}>
          <span>
            GitHub personal access token, for opening the pull request. Or sign in with the GitHub CLI (gh auth login) and
            reopen this panel.
          </span>
          <input
            className={styles.input}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <span className={styles.note}>
            {github.canStore
              ? "Kept encrypted by Windows for your account; never written in plain text."
              : "This computer offers no encryption, so the token is kept for this session only."}
          </span>
          <div className={styles.actions}>
            <Button disabled={busy || token.trim() === ""} onClick={() => void setGitHubToken(token).then(() => setToken(""))}>
              Use this token
            </Button>
          </div>
        </label>
      ) : null}
      {github !== null && github.source === "stored" ? (
        <button type="button" className={styles.linkButton} onClick={() => void forgetGitHubToken()}>
          Forget the saved token
        </button>
      ) : null}

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

      <div className={styles.actions}>
        <Button disabled={busy || autoName === null || status?.isRepo !== true} testId="desktop-git-commit" onClick={() => void commitAuto(summary)}>
          Commit
        </Button>
        <Button
          disabled={busy || status?.isRepo !== true || status.onBase || !status.hasRemote}
          testId="desktop-git-push"
          onClick={() => void pushBranch()}
        >
          Push
        </Button>
        <Button
          kind="primary"
          disabled={busy || autoName === null || status?.isRepo !== true || status.onBase || !status.hasRemote || github?.source === null}
          testId="desktop-git-pr"
          onClick={() => void openPullRequest()}
        >
          Open pull request
        </Button>
      </div>
    </>
  );
}
