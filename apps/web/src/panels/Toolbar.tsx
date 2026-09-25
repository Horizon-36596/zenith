/**
 * The title bar and the toolbar (UI_GUIDE sections 9.1 and 9.2).
 *
 * The title bar carries the Horizon mark, the product name, the open auto and where it lives, the
 * unsaved dot and the alliance pill, over the horizon line. The toolbar under it has three spaced
 * groups (tools, run, view) and, at the right, search and the help menu. Every button comes from
 * the one action table, so its tooltip names the action, what it does and its shortcut, and says
 * why when it is disabled.
 */
import { CircleHelp, CirclePause, Search } from "lucide-react";
import {
  ACTIONS,
  HELP_MENU,
  TOOLBAR_GROUPS,
  actionById,
  isEnabled,
  shortcutOf,
  tooltipHint,
  type ActionDef,
} from "../app/actions";
import { SHORTCUTS } from "../app/shortcuts";
import { ActionMenu } from "../components/ActionMenu";
import { ToolButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { StatusChip } from "../github/StatusChip";
import { isDirty, setDialog, setPaletteOpen, useEditor, type State } from "../state/store";
import { setHelpMenuOpen, useUi } from "../state/ui";
import styles from "./Toolbar.module.css";

function ActionButton({ action, state }: { action: ActionDef; state: State }) {
  const enabled = isEnabled(action, state);
  const active = action.active?.(state) ?? false;
  const icon = action.id === "view.play" && state.playing ? CirclePause : action.icon;
  return (
    <ToolButton
      icon={icon}
      label={action.id === "view.play" && state.playing ? "Pause" : action.label}
      shortcut={shortcutOf(action)}
      hint={tooltipHint(action, state)}
      active={active}
      toggle={action.group !== "tool" || action.id === "view.snap"}
      disabled={!enabled}
      testId={`toolbar-${action.id}`}
      tour={action.id}
      onClick={() => {
        void action.run();
      }}
    />
  );
}

/** Where the open project lives, in the form the title bar shows it. */
function whereLabel(state: State): string | null {
  if (state.repo !== null) return `${state.repo.owner}/${state.repo.repo}@${state.repo.branch}`;
  return state.project?.name ?? null;
}

export function TitleBar() {
  const state = useEditor();
  const dirty = isDirty(state);
  const where = whereLabel(state);
  const github = state.backend?.kind === "github" || (state.backend === null && state.auth !== null);

  return (
    <header className={styles.title} aria-label="Title bar" data-titlebar data-region tabIndex={-1}>
      <img
        className={styles.product}
        src={`${import.meta.env.BASE_URL}brand/zenith-wordmark-dark.svg`}
        alt="Zenith"
        draggable={false}
        data-testid="titlebar-wordmark"
      />
      <span className={styles.divider} aria-hidden />
      <img
        className={styles.team}
        src={`${import.meta.env.BASE_URL}brand/horizon-wordmark-white.svg`}
        alt="Horizon"
        draggable={false}
        data-testid="titlebar-horizon"
      />
      <Tooltip
        label="Open another auto or project"
        shortcut={SHORTCUTS.openProject}
        hint={dirty ? "This auto has unsaved changes." : undefined}
      >
        <button
          type="button"
          className={styles.autoName}
          data-testid="toolbar-auto-name"
          onClick={() => {
            setDialog("open");
          }}
        >
          <span className={styles.autoText}>{state.fileName ?? "No auto open"}</span>
          {dirty ? <span className={styles.dirty} aria-label="Unsaved changes" /> : null}
        </button>
      </Tooltip>
      {github ? <StatusChip /> : where === null ? null : <span className={styles.where}>{where}</span>}
      <span className={styles.spacer} />
      {state.auto === null ? null : (
        <Tooltip
          label={`Showing ${state.alliance}`}
          hint={
            state.alliance === state.auto.alliance
              ? "The alliance this auto is written for."
              : "Mirrored from the alliance this auto is written for."
          }
        >
          <span className={styles.alliancePill} data-alliance={state.alliance} data-testid="alliance-pill">
            {state.alliance}
          </span>
        </Tooltip>
      )}
    </header>
  );
}

export function Toolbar() {
  const state = useEditor();
  const { helpMenuOpen } = useUi();

  return (
    <div className={styles.bar} role="toolbar" aria-label="Toolbar" data-testid="toolbar">
      {TOOLBAR_GROUPS.map((group, index) => (
        <div
          className={styles.group}
          key={group.join()}
          data-group={String(index + 1)}
          data-tour={index === 1 ? "run" : undefined}
        >
          {group.map((id) => {
            const action = ACTIONS.find((candidate) => candidate.id === id);
            return action === undefined ? null : <ActionButton key={id} action={action} state={state} />;
          })}
        </div>
      ))}

      <div className={styles.spacer} />

      <div className={styles.group}>
        <Tooltip
          label="Search actions"
          shortcut={SHORTCUTS.palette}
          hint="Find any action, command, waypoint or auto by typing its name."
        >
          <button
            type="button"
            className={styles.search}
            data-tour="palette"
            data-testid="toolbar-search"
            aria-label="Search actions"
            onClick={() => {
              setPaletteOpen(true);
            }}
          >
            <Search size={16} strokeWidth={1.75} aria-hidden />
            <span className={styles.searchText}>Search</span>
            <kbd className={styles.searchKey}>{SHORTCUTS.palette}</kbd>
          </button>
        </Tooltip>
        <ToolButton
          icon={CircleHelp}
          label="Help"
          hint="Replay the tour, see every shortcut, or search for an action."
          shortcut={SHORTCUTS.help}
          active={helpMenuOpen}
          toggle
          testId="toolbar-help"
          tour="help"
          onClick={() => {
            setHelpMenuOpen(!helpMenuOpen);
          }}
        />
      </div>
      {helpMenuOpen ? <HelpMenu /> : null}
    </div>
  );
}

/** The help menu, dropped from the help button. */
function HelpMenu() {
  const anchor = document.querySelector<HTMLElement>('[data-testid="toolbar-help"]')?.getBoundingClientRect();
  const entries = HELP_MENU.filter((id) => actionById(id) !== undefined).map((id) => ({ id }));
  return (
    <ActionMenu
      xPx={(anchor?.right ?? window.innerWidth) - 240}
      yPx={(anchor?.bottom ?? 80) + 4}
      entries={entries}
      label="Help"
      testId="help-menu"
      onClose={() => {
        setHelpMenuOpen(false);
      }}
    />
  );
}
