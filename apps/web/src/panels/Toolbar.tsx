/**
 * The title bar and the toolbar (UI_GUIDE sections 9.1 and 9.2).
 *
 * The title bar carries the Horizon mark, the product name, the open auto and where it lives, the
 * unsaved dot and the alliance pill, over the horizon line. The toolbar under it has spaced
 * groups (tools, Optimize, undo and redo, run, view) and, at the right, search, Settings and the
 * help menu; in host mode the host's group sits before them, with the screen's primary Save. Every
 * button comes from the one action table, so its tooltip names the action, what it does and its
 * shortcut, and says why when it is disabled. Settings, Editor, Toolbar takes a button off
 * (`display.toolbar.<id>`), and only the button: its key and its palette row still run it.
 *
 * Issue #412: the toolbar is one row that never wraps and never moves under the pointer. A tool's
 * options keep their place at the end of the tool group whether or not the tool is on, below
 * 1100 px Search shows its icon only and the Docs book goes (Help, Documentation stays), Propose
 * is drawn only for a project opened from GitHub, and Optimize has a chevron that opens its menu.
 * In a window too narrow for every group, the groups that do not fit go, last first, into a More
 * menu at the end of the tools, so the right cluster never leaves the screen (0.1.2 UX sweep, W1-2).
 */
import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";
import { ChevronDown, CircleHelp, CirclePause, MoreHorizontal, Search, Settings as SettingsIcon } from "lucide-react";
import {
  ACTIONS,
  HELP_MENU,
  OPTIMIZE_MENU,
  TOOLBAR_GROUPS,
  TOOL_OPTIONS,
  actionById,
  isEnabled,
  settingsHint,
  shortcutOf,
  tooltipHint,
  type ActionDef,
} from "../app/actions";
import { useKeyLabel } from "../app/shortcuts";
import { ActionMenu, type MenuEntry } from "../components/ActionMenu";
import { ToolButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { StatusChip } from "../github/StatusChip";
import { SharingChip } from "../cloud/SharingChip";
import { useCloud } from "../cloud/store";
import { AccountToolbar } from "../account/AccountToolbar";
import { HostControls } from "../project/hostPanel";
import { isHostMode } from "../project/hostSession";
import { useProposerSession } from "../proposals/proposerStore";
import { toolbarButtonShown } from "../settings/registry";
import { openSettings, useSettings } from "../settings/store";
import { actionShown, useFeature, useFeatures } from "../state/features";
import { isDirty, setDialog, setPaletteOpen, useEditor, type State } from "../state/store";
import { setHelpMenuOpen, useUi } from "../state/ui";
import styles from "./Toolbar.module.css";

/** Every tool option (`TOOL_OPTIONS`): a switch, so its button reads as pressed or not. */
const TOOL_OPTION_IDS = new Set(Object.values(TOOL_OPTIONS).flat());

/** The prefix of a slot kept for a tool option while its tool is off (issue #412). */
const SLOT = "slot:";

/**
 * A group's buttons, then its tools' options at the end of the group (issue #412). An option shows
 * while its tool is the active one; otherwise its slot keeps the same room, so choosing the tool
 * moves no button.
 */
const withToolOptions = (group: readonly string[], state: State): string[] => [
  ...group,
  ...group.flatMap((id) => {
    const options = TOOL_OPTIONS[id] ?? [];
    return actionById(id)?.active?.(state) === true ? options : options.map((option) => `${SLOT}${option}`);
  }),
];

/** Where the Optimize button's menu opens, or null while it is closed. */
type MenuAt = { xPx: number; yPx: number } | null;

/** Propose is drawn only for a project opened from GitHub (issue #412); its key still says why elsewhere. */
const proposeDrawn = (state: State): boolean => state.backend?.kind === "github";

function ActionButton({ action, state, onMenu, hintMore }: { action: ActionDef; state: State; onMenu?: (at: MenuAt) => void; hintMore?: string }) {
  const enabled = isEnabled(action, state);
  // A tool that cannot be chosen now does not read as the chosen one (issue #412).
  const active = enabled && (action.active?.(state) ?? false);
  const icon = action.id === "view.play" && state.playing ? CirclePause : action.icon;
  const hint = tooltipHint(action, state);
  return (
    <ToolButton
      icon={icon}
      label={action.id === "view.play" && state.playing ? "Pause" : action.label}
      shortcut={shortcutOf(action)}
      hint={hintMore === undefined ? hint : `${hint} ${hintMore}`}
      active={active}
      toggle={action.group !== "tool" || action.id === "view.snap" || TOOL_OPTION_IDS.has(action.id)}
      momentary={action.id === "edit.undo" || action.id === "edit.redo" || action.id === "path.optimize"}
      disabled={!enabled}
      testId={`toolbar-${action.id}`}
      tour={action.id}
      onClick={() => {
        void action.run();
      }}
      onContextMenu={
        onMenu === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              onMenu({ xPx: event.clientX, yPx: event.clientY });
            }
      }
    />
  );
}

/**
 * The Optimize button and its chevron (issue #412), one group: the wand runs Optimize path, and the
 * chevron, or a right-click on the wand, opens the menu.
 */
function OptimizeSplit({ action, state, onMenu }: { action: ActionDef; state: State; onMenu: (at: MenuAt) => void }) {
  // The chevron's menu holds nothing that can run while every one of its actions is blocked, so it is
  // unavailable then for the wand's reason, as the wand is (UX review, S11).
  const open = OPTIMIZE_MENU.some((id) => {
    const entry = actionById(id);
    return entry !== undefined && isEnabled(entry, state);
  });
  const why = open ? null : action.whyDisabled?.(state) || "Not available right now.";
  return (
    <span className={styles.split}>
      <ActionButton action={action} state={state} onMenu={open ? onMenu : undefined} hintMore="The arrow beside it, or a right-click, offers options or every path." />
      <Tooltip label="More ways to optimize" hint={why === null ? "Optimize path with options, or Optimize every path." : `Unavailable: ${why}`}>
        <button
          type="button"
          className={styles.chevron}
          aria-label="More ways to optimize"
          aria-haspopup="menu"
          aria-disabled={why === null ? undefined : true}
          data-testid="toolbar-optimize-more"
          onClick={(event) => {
            if (why !== null) return;
            const box = event.currentTarget.getBoundingClientRect();
            onMenu({ xPx: box.left - 32, yPx: box.bottom + 4 });
          }}
        >
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}

/** The Optimize button's menu (issue #366): Optimize path, with options, and Optimize every path. */
function OptimizeMenu({ at, onClose }: { at: { xPx: number; yPx: number }; onClose: () => void }) {
  const features = useFeatures();
  const entries = OPTIMIZE_MENU.filter((id) => actionShown(id, features)).map((id) => ({ id }));
  return <ActionMenu xPx={at.xPx} yPx={at.yPx} entries={entries} label="Optimize path" testId="optimize-menu" onClose={onClose} />;
}

/** The Settings button's hint, which the palette's Settings row shares (`app/actions.ts`). */
export { settingsHint };

/** Where the open project lives, in the form the title bar shows it. */
function whereLabel(state: State): string | null {
  // In host mode the auto lives in the host; the toolbar's host group names the robot. Once the
  // session is over it no longer does.
  if (state.host !== null) {
    if (state.project === null) return null;
    return state.host.phase === "closed" ? `was in ${state.host.name}` : `in ${state.host.name}`;
  }
  if (state.repo !== null) return `${state.repo.owner}/${state.repo.repo}@${state.repo.branch}`;
  return state.project?.name ?? null;
}

/**
 * What the alliance pill's hint adds: the pill is only a label, so it names the toolbar's Mirror
 * button, and its key when it has one, which is what changes it (UX review, S10).
 */
export function mirrorHint(key: string | undefined): string {
  return key === undefined ? "Mirror, on the toolbar, shows the other alliance." : `Mirror (${key}) shows the other alliance.`;
}

export function TitleBar() {
  const state = useEditor();
  const openKey = useKeyLabel("openProject");
  const mirrorKey = useKeyLabel("alliance");
  const dirty = isDirty(state);
  const where = whereLabel(state);
  const github = state.backend?.kind === "github" || (state.backend === null && state.auth !== null);
  const partners = useFeature("partners");

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
        label={isHostMode() ? "Open another auto" : "Open another auto or project"}
        shortcut={openKey}
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
      {partners ? <SharingChip /> : null}
      {github ? <StatusChip /> : where === null ? null : <span className={styles.where} data-testid="titlebar-where">{where}</span>}
      <span className={styles.spacer} />
      {state.auto === null ? null : (
        <Tooltip
          label={`Showing ${state.alliance}`}
          hint={`${
            state.alliance === state.auto.alliance
              ? "The alliance this auto is written for."
              : "Mirrored from the alliance this auto is written for."
          } ${mirrorHint(mirrorKey)}`}
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
  const paletteKey = useKeyLabel("palette");
  const settingsKey = useKeyLabel("settings");
  const helpKey = useKeyLabel("help");
  const { helpMenuOpen } = useUi();
  const settings = useSettings();
  const features = useFeatures();
  const docs = actionById("help.docs");
  const [optimizeMenu, setOptimizeMenu] = useState<MenuAt>(null);
  const [moreMenu, setMoreMenu] = useState<MenuAt>(null);
  // The Share buttons read the cloud session and which sharing sheet is open, which live in the
  // sharing store rather than the editor's; subscribing here redraws them when either changes.
  useCloud();
  // Undo and Redo follow the proposal session's history while one is open, so redraw with it.
  useProposerSession();

  // A button its switch hides, or that the person took off the toolbar in Settings, Editor; the
  // second keeps its key and palette row. A group left with no button is not drawn. A tool's options
  // follow it only while its own button is shown.
  const drawn = (id: string): boolean =>
    actionShown(id, features) && toolbarButtonShown(state.prefs, id) && (id !== "run.propose" || proposeDrawn(state));
  const groups = TOOLBAR_GROUPS.map((group, index) => ({
    key: group.join(),
    index,
    group,
    shown: withToolOptions(group.filter(drawn), state).filter((id) => drawn(id.startsWith(SLOT) ? id.slice(SLOT.length) : id)),
  })).filter((entry) => entry.shown.length > 0);
  const { bar, tools, fits } = useToolbarFit(groups.map((entry) => entry.key));
  const overflow = groups.slice(fits);

  return (
    <div ref={bar} className={styles.bar} role="toolbar" aria-label="Toolbar" data-testid="toolbar">
      {/* The tool groups take the room the right cluster leaves; the groups that do not fit go,
          last first, into the More menu, so Search, Settings and Help always stay on screen. */}
      <div ref={tools} className={styles.tools}>
        {groups.slice(0, fits).map(({ key, index, group, shown }) => (
          <div
            className={styles.group}
            key={key}
            data-group={String(index + 1)}
            data-fit-key={key}
            data-tour={group.includes("run.validate") ? "run" : undefined}
          >
            {shown.map((id) => {
              if (id.startsWith(SLOT)) return <span key={id} className={styles.slot} aria-hidden data-testid={`toolbar-slot-${id.slice(SLOT.length)}`} />;
              const action = ACTIONS.find((candidate) => candidate.id === id);
              if (action === undefined) return null;
              return id === "path.optimize" ? (
                <OptimizeSplit key={id} action={action} state={state} onMenu={setOptimizeMenu} />
              ) : (
                <ActionButton key={id} action={action} state={state} />
              );
            })}
          </div>
        ))}
        {overflow.length === 0 ? null : (
          // The tour anchors of the buttons in the menu, so a tour stop on one rings More instead.
          <div className={styles.group} data-tour-holds={overflow.flatMap(({ group, shown }) => [...(group.includes("run.validate") ? ["run"] : []), ...shown.filter((id) => !id.startsWith(SLOT))]).join(" ")}>
            <ToolButton
              icon={MoreHorizontal}
              label="More tools"
              hint="The toolbar buttons this window is too narrow to show."
              active={moreMenu !== null}
              toggle
              testId="toolbar-more"
              onClick={() => {
                if (moreMenu !== null) {
                  setMoreMenu(null);
                  return;
                }
                const box = document.querySelector('[data-testid="toolbar-more"]')?.getBoundingClientRect();
                setMoreMenu({ xPx: box?.left ?? 0, yPx: (box?.bottom ?? 80) + 4 });
              }}
            />
          </div>
        )}
      </div>

      {/* Host mode only: who this editor is working for, Simulate in and Save to (site/docs/host-protocol.md). */}
      <HostControls />

      <AccountToolbar />

      <div className={styles.group}>
        <Tooltip
          label="Search actions"
          shortcut={paletteKey}
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
            {/* Below 1100 px Search is its icon alone (issue #412); the tooltip keeps the key. */}
            <span className={`${styles.searchText} ${styles.wideOnly}`}>Search</span>
            {paletteKey === undefined ? null : <kbd className={`${styles.searchKey} ${styles.wideOnly}`}>{paletteKey}</kbd>}
          </button>
        </Tooltip>
        <ToolButton
          icon={SettingsIcon}
          label="Settings"
          hint={settingsHint()}
          shortcut={settingsKey}
          active={settings.open}
          toggle
          testId="toolbar-settings"
          tour="settings"
          onClick={() => {
            openSettings();
          }}
        />
        {/* Its registry entry is display.toolbar.help.docs, shown unless the person hides it. */}
        {/* Below 1100 px the book goes, so the bar stays one row; Help's menu has Documentation (issue #412). */}
        {docs === undefined || !toolbarButtonShown(state.prefs, docs.id) ? null : (
          <span className={styles.wideOnly} data-testid="toolbar-docs-slot">
            <ToolButton
              icon={docs.icon}
              label={docs.label}
              hint={docs.does}
              momentary
              testId="toolbar-docs"
              onClick={() => {
                void docs.run();
              }}
            />
          </span>
        )}
        <ToolButton
          icon={CircleHelp}
          label="Help"
          hint="Read the documentation, replay the tour, see every shortcut, or report a bug."
          shortcut={helpKey}
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
      {optimizeMenu === null ? null : (
        <OptimizeMenu
          at={optimizeMenu}
          onClose={() => {
            setOptimizeMenu(null);
          }}
        />
      )}
      {moreMenu === null || overflow.length === 0 ? null : (
        <ActionMenu
          xPx={moreMenu.xPx}
          yPx={moreMenu.yPx}
          entries={moreEntries(overflow.map((entry) => entry.shown), features)}
          label="More tools"
          testId="toolbar-more-menu"
          onClose={() => {
            setMoreMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** The gap between toolbar groups (`--space-4`) and the More button's width (`--ctl-h-tool`). */
const GROUP_GAP_PX = 16;
const MORE_PX = 32;
/** The tools' inline padding (`--space-1`), kept for a focused button's ring. */
const RING_PAD_PX = 4;

/**
 * The More menu's rows: each overflowed group's buttons, a rule between groups. A slot kept for a
 * tool option is nothing to press, and Optimize brings its whole menu, as its chevron would.
 */
function moreEntries(groups: readonly (readonly string[])[], features: ReturnType<typeof useFeatures>): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const group of groups) {
    const ids = group
      .filter((id) => !id.startsWith(SLOT))
      .flatMap((id) => (id === "path.optimize" ? OPTIMIZE_MENU.filter((entry) => actionShown(entry, features)) : [id]));
    ids.forEach((id, at) => {
      // A button that shows a state (the chosen tool, Snap, an option) keeps it in the menu.
      const toggle = ACTIONS.find((candidate) => candidate.id === id)?.active !== undefined;
      entries.push({ id, separatorBefore: at === 0 && entries.length > 0, ...(toggle ? { toggle } : {}) });
    });
  }
  return entries;
}

/**
 * How many of the toolbar's groups, from the left, fit beside the right cluster (0.1.2 UX sweep,
 * W1-2). Each group's width is measured while it is drawn and remembered, so a group sent to the
 * More menu comes back as soon as the window has room for it again. The count is worked out before
 * the browser paints, so a narrow window never shows a button half off the edge.
 */
function useToolbarFit(keys: readonly string[]): {
  bar: RefObject<HTMLDivElement>;
  tools: RefObject<HTMLDivElement>;
  fits: number;
} {
  const bar = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [fits, setFits] = useState(Number.POSITIVE_INFINITY);
  // A resize only has to draw the bar again: the count is worked out on every draw, below.
  const [, resized] = useReducer((count: number) => count + 1, 0);

  useLayoutEffect(() => {
    const box = tools.current;
    if (box === null) return;
    for (const group of box.querySelectorAll<HTMLElement>("[data-fit-key]")) {
      widths.current.set(group.dataset["fitKey"] ?? "", group.getBoundingClientRect().width);
    }
    // The tools' inline padding is room for a focus ring, not for a button.
    const available = box.clientWidth - RING_PAD_PX * 2;
    const width = (key: string): number => widths.current.get(key) ?? 0;
    const all = keys.reduce((sum, key, at) => sum + width(key) + (at === 0 ? 0 : GROUP_GAP_PX), 0);
    let count = keys.length;
    if (all > available + 0.5) {
      count = 0;
      let used = MORE_PX;
      for (const key of keys) {
        const next = used + width(key) + GROUP_GAP_PX;
        if (next > available + 0.5) break;
        used = next;
        count += 1;
      }
    }
    const next = count >= keys.length ? Number.POSITIVE_INFINITY : count;
    if (next !== fits) setFits(next);
  });

  // Every change of the window's width, or of the right cluster's, is a new count.
  useLayoutEffect(() => {
    const element = bar.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      resized();
    });
    observer.observe(element);
    if (tools.current !== null) observer.observe(tools.current);
    return () => {
      observer.disconnect();
    };
  }, []);

  return { bar, tools, fits };
}

/** The help menu, dropped from the help button. */
function HelpMenu() {
  const anchor = document.querySelector<HTMLElement>('[data-testid="toolbar-help"]')?.getBoundingClientRect();
  const features = useFeatures();
  const entries = HELP_MENU.filter((id) => actionById(id) !== undefined && actionShown(id, features)).map((id) => ({ id }));
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
