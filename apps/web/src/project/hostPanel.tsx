/**
 * Host mode's pieces of the shell (site/docs/host-protocol.md): the host group at the right of
 * the toolbar, the full-page message while Zenith waits for the host's project (or gives up on
 * it), the auto picker that replaces the open-project dialog, and the empty field when no auto is
 * open. Each one reads the host session's view from the store (`state.host`).
 */
import { Cpu, Download, FilePlus, FileText, RefreshCw, Save, Unplug } from "lucide-react";
import { actionById, isEnabled, shortcutOf, tooltipHint } from "../app/actions";
import { useMediaQuery } from "../app/PanelSheets";
import { openAutoNamed } from "../app/projectActions";
import { Tooltip } from "../components/Tooltip";
import { Modal } from "../dialogs/Modal";
import { setDialog, useEditor, type State } from "../state/store";
import { closedLine, createHostAuto, leaveHostMode, newAutoBlockedReason } from "./hostSession";
import { allianceLine } from "./hostAlliance";
import styles from "./host.module.css";

/**
 * A text button that runs one action from the action table, so its label, tooltip, shortcut and
 * reason for being disabled are the same ones the palette and the keyboard use. Disabled is
 * `aria-disabled`, as for every toolbar control, so the tooltip that says why stays reachable.
 */
function ActionTextButton({
  id,
  state,
  kind,
  icon: Icon,
  label,
  tour,
  narrow = false,
  iconOnly = false,
  hideWhenNarrow = false,
  context,
}: {
  id: string;
  state: State;
  kind: "primary" | "secondary";
  icon: typeof Save;
  label?: string;
  /** The tour's anchor name for this button, when a tour stop points at it. */
  tour?: string;
  /**
   * Below 1400 px wide the button is its icon alone, with its label in the tooltip, so the host line
   * and "Save to", which always keeps its words, have room (sweep W4-3).
   */
  narrow?: boolean;
  /** The icon alone at every width, when the bar is crowded. */
  iconOnly?: boolean;
  /** Not drawn below 1100 px, for a disabled button the bar cannot fit there. */
  hideWhenNarrow?: boolean;
  /** Sentences added after the action's own hint, for what the bar has no room to show. */
  context?: string;
}) {
  const action = actionById(id);
  if (action === undefined) return null;
  const enabled = isEnabled(action, state);
  const classes = [
    kind === "primary" ? styles.primary : styles.secondary,
    narrow || iconOnly ? styles.narrow : undefined,
    hideWhenNarrow ? styles.wideOnly : undefined,
  ];
  const textClass = iconOnly ? styles.hiddenText : narrow ? styles.wideText : undefined;
  const hint = context === undefined ? tooltipHint(action, state) : `${tooltipHint(action, state)} ${context}`;
  return (
    <Tooltip label={action.label} shortcut={shortcutOf(action)} hint={hint}>
      <button
        type="button"
        className={classes.filter((name) => name !== undefined).join(" ")}
        aria-disabled={!enabled}
        aria-label={narrow || iconOnly ? (label ?? action.label) : undefined}
        data-testid={`host-${id}`}
        data-tour={tour}
        onClick={() => {
          if (enabled) void action.run();
        }}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <span className={textClass}>{label ?? action.label}</span>
      </button>
    </Tooltip>
  );
}

/**
 * The toolbar's host group: who this editor is working for and on what, then "Simulate in" when
 * the host offered it, and "Save to", the one primary button on the screen. Once the session is
 * over, because the host closed it or its window went away, the line says which, Save stays
 * disabled with the reason in its tooltip, and "Save a copy" is there to keep the edits. A host too
 * old to read this Zenith's autos gets the same: a "needs an update" badge, Save to and Simulate in
 * off with the reason in their tooltips, and "Save a copy".
 */
export function HostControls() {
  const state = useEditor();
  const host = state.host;
  // Below 1100 px the two lines are not drawn (host.module.css), so Save to's tooltip says them.
  const lineHidden = useMediaQuery("(max-width: 1099.98px)");
  if (host === null || (host.phase !== "open" && host.phase !== "closed")) return null;
  const closed = host.phase === "closed";
  const running = host.running !== null;
  const outdated = host.outdated !== null;
  // Which side to draw on: the open file's own alliance, and what the host does for the other one.
  const field = state.autoField ?? state.project?.field ?? null;
  const alliance =
    state.auto === null || field === null ? null : allianceLine(state.auto.alliance, field.frame.mirror, host.name);
  const saving = (host.saving ?? null) !== null;
  // What the two lines say, as sentences, for Save to's tooltip when they are not drawn.
  const editingLine = [
    host.label === null ? `Editing for ${host.name}.` : `Editing ${host.label} for ${host.name}.`,
    ...(alliance === null ? [] : [alliance.text]),
  ].join(" ");

  return (
    <div className={styles.group} data-testid="host-bar" data-phase={host.phase}>
      {closed ? (
        <span className={styles.closed} role="status" data-testid="host-closed">
          <Unplug size={16} strokeWidth={1.75} aria-hidden />
          {closedLine(host)}
        </span>
      ) : (
        // Two short lines, so both fit beside the buttons in DSIM's own popup (1440 wide) and at
        // 1280 (sweep W4-3): the robot, and which alliance to draw for. The title bar already says
        // "in DSIM"; the tooltip says it all in full sentences.
        <Tooltip
          label={host.label === null ? `Editing for ${host.name}` : `Editing for ${host.name} · ${host.label}`}
          hint={alliance === null ? undefined : `${alliance.text} ${alliance.hint}`}
        >
          <span className={styles.info} data-testid="host-label" data-alliance={alliance === null ? undefined : state.auto?.alliance} tabIndex={0}>
            <span className={styles.subject} data-testid="host-subject">
              {host.label ?? `Editing for ${host.name}`}
            </span>
            {alliance === null ? null : (
              <span className={styles.alliance} data-testid="host-alliance">
                {alliance.short}
              </span>
            )}
          </span>
        </Tooltip>
      )}
      {/* Under 1100 px the badge gives its room to Save a copy; Save to's tooltip and the status
          line still say why. */}
      {!closed && outdated ? (
        <Tooltip label={`${host.name} needs an update`} hint={host.outdated ?? undefined}>
          <span className={`${styles.outdated} ${styles.wideOnly}`} role="status" data-testid="host-outdated" tabIndex={0}>
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
            <span className={styles.wideText}>{host.name} needs an update</span>
          </span>
        </Tooltip>
      ) : null}
      {/* Save to the host is off once the session is over, or while the host is too old to read
          this Zenith's autos; either way the copy keeps the work. */}
      {closed || outdated ? (
        <ActionTextButton
          id="project.saveCopy"
          state={state}
          kind="secondary"
          icon={Download}
          label="Save a copy"
          narrow
          iconOnly={outdated}
        />
      ) : null}
      {host.simulate ? (
        <ActionTextButton
          id="host.simulate"
          state={state}
          kind="secondary"
          icon={Cpu}
          label={running ? `Simulating in ${host.name}…` : undefined}
          narrow
          // Off while the host needs an update, so it gives way first when the bar is crowded.
          iconOnly={outdated}
          hideWhenNarrow={outdated}
        />
      ) : null}
      <ActionTextButton
        id="run.save"
        state={state}
        kind="primary"
        icon={Save}
        tour="host.save"
        label={saving ? `Saving to ${host.name}…` : undefined}
        context={lineHidden && !closed ? editingLine : undefined}
      />
    </div>
  );
}

/**
 * The whole window while there is no project: waiting for the host's `open`, and then, if none
 * came, or there was no host to ask, the reason and a way on to the usual start screen.
 */
export function HostGate() {
  const { host } = useEditor();
  if (host === null) return null;
  const failed = host.phase === "failed";
  return (
    <main className={styles.gate} data-testid="host-gate" data-phase={host.phase}>
      <div className={styles.gateCard}>
        <img
          className={styles.gateMark}
          src={`${import.meta.env.BASE_URL}brand/zenith-wordmark-dark.svg`}
          alt="Zenith"
          draggable={false}
        />
        {failed ? (
          <>
            <h1 className={styles.gateTitle}>No project from {host.name}</h1>
            <p className={styles.gateLine} data-testid="host-failure">
              {host.failure}
            </p>
            <div className={styles.gateButtons}>
              <button type="button" className={styles.primary} data-testid="host-continue" onClick={leaveHostMode}>
                Continue to the start screen
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className={styles.gateTitle}>Waiting for {host.name}</h1>
            <p className={styles.gateLine} role="status" aria-live="polite">
              {host.name} opened Zenith to edit an auto. The project arrives in a moment.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

/** The open-project dialog in host mode: the autos the host sent, and a new one. */
export function HostAutosDialog() {
  const { project, fileName, host } = useEditor();
  const name = host?.name ?? "the host";
  const blocked = newAutoBlockedReason();
  return (
    <Modal
      title={`Autos from ${name}`}
      testId="open-project"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        <>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setDialog(null);
            }}
          >
            Cancel
          </button>
          <Tooltip label="New auto" hint={blocked ?? `It stays in this window until you save it to ${name}.`}>
            <button
              type="button"
              className={styles.primary}
              aria-disabled={blocked !== null}
              data-testid="host-new-auto"
              onClick={() => {
                if (blocked !== null) return;
                setDialog(null);
                void createHostAuto();
              }}
            >
              <FilePlus size={16} strokeWidth={1.75} aria-hidden />
              <span>New auto</span>
            </button>
          </Tooltip>
        </>
      }
    >
      <p className={styles.prose}>
        Save sends the open auto back to {name}.
      </p>
      {project === null || project.autoFiles.length === 0 ? (
        <p className={styles.prose}>{name} sent no autos.</p>
      ) : (
        <div className={styles.autos}>
          {project.autoFiles.map((autoFile) => (
            <button
              key={autoFile}
              type="button"
              className={styles.autoRow}
              aria-current={autoFile === fileName ? "true" : undefined}
              data-testid={`open-auto-${autoFile}`}
              onClick={() => {
                setDialog(null);
                void openAutoNamed(autoFile);
              }}
            >
              <FileText size={16} strokeWidth={1.75} aria-hidden />
              <span className={styles.autoName}>{autoFile}</span>
              {autoFile === fileName ? <span className={styles.autoHint}>open</span> : null}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** The field with no auto open, in host mode: pick one of the host's autos or start one. */
export function HostEmpty() {
  const { host } = useEditor();
  const name = host?.name ?? "the host";
  const open = actionById("project.open");
  return (
    <div className={styles.empty} data-testid="canvas-empty">
      <FileText size={32} strokeWidth={1.75} className={styles.emptyIcon} aria-hidden />
      <h1 className={styles.emptyTitle}>No auto is open</h1>
      <p className={styles.emptyLine}>Pick one of the autos {name} sent, or start a new one.</p>
      <div className={styles.gateButtons}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => {
            setDialog("open");
          }}
        >
          Open an auto
          {open === undefined ? null : <kbd className={styles.key}>{shortcutOf(open)}</kbd>}
        </button>
      </div>
    </div>
  );
}
