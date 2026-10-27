/**
 * The Settings window (issue #97): one large modal in the middle of the screen, with the list of
 * sections on the left and the chosen section on the right, each a few groups of rows of label,
 * one-line description and control. It replaces the account sheet, which held too much in one
 * column and hid the project's command library entirely.
 *
 * It is modal on purpose, unlike the docked sheets: a backdrop dims the app, focus stays inside it
 * and goes back to whatever had it on close, and Escape or the close button shuts it. It is drawn in
 * the page rather than as a native top-layer `<dialog>`, so the tooltips every control carries
 * (UI_GUIDE 9.4), which portal to the page, still show above it.
 *
 * At a phone's width it fills the screen: the list of sections is the first screen, and a section
 * opens over it with a back control. Which section shows is a screen of its own in the back and
 * forward history (`app/navigation.ts`), and the last one shown is remembered for each viewer.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import {
  ArrowLeft,
  Bot,
  Braces,
  Keyboard,
  Layers,
  Palette,
  ShieldCheck,
  ShieldUser,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { RowButton } from "../components/primitives";
import { PopoverLayer } from "../components/popoverLayer";
import { HelpTip } from "../help/HelpTip";
import { cloudEnabled } from "../account/config";
import { isDesktop } from "../project/desktop";
import { account, useAccount } from "../account/store";
import { AccountPane, AdminPane, DataPane, DeveloperPane, TeamsPane } from "./AccountPanes";
import { EditorPane, GeneralPane } from "./ProjectPanes";
import { KeyboardPane } from "./KeyboardPane";
import { PresetsPane } from "./PresetsPane";
import { CommandsPane, RobotPane, discardRobotDraft, saveRobotDraft, setRobotCloseAsk, useRobotUnsaved } from "./RobotPanes";
import { UnsavedChoices } from "../dialogs/UnsavedDialog";
import { useEscapeFirst } from "./parts";
import { sectionShown, useFeatures } from "../state/features";
import { closeHint, resolveSection, sectionInfo, visibleSections, type SettingsSection } from "./sections";
import { ExampleBanner } from "./ExampleBanner";
import { matchRows, resultCount, searchRows, tokensOf, type SearchRow } from "./search";
import { SearchBox, SearchResults } from "./SettingsSearch";
import { clearSettingsFocus, closeSettings, openSettingsRow, showSettingsSection, useSettings, type SettingsState } from "./store";
import { useHorizonAdmin } from "./useHorizonAdmin";
import styles from "./Settings.module.css";

const ICONS: Record<SettingsSection, LucideIcon> = {
  account: UserRound,
  presets: Layers,
  teams: UsersRound,
  general: SlidersHorizontal,
  robot: Bot,
  commands: Braces,
  editor: Palette,
  keyboard: Keyboard,
  data: ShieldCheck,
  admin: ShieldUser,
  developer: Wrench,
};

/** The window, while it is open. */
export function Settings() {
  const { open, section, focus } = useSettings();
  if (!open) return null;
  return <SettingsWindow requested={section} focus={focus} />;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
}

function SettingsWindow({ requested, focus }: { requested: SettingsSection | null; focus: SettingsState["focus"] }) {
  const state = useAccount();
  const cloud = cloudEnabled();
  const signedIn = cloud && state.user !== null && state.profile !== null;
  const uid = cloud ? (state.user?.uid ?? null) : null;
  const admin = useHorizonAdmin(uid);
  const features = useFeatures();
  const visible = visibleSections({
    cloud,
    signedIn,
    admin,
    fake: cloud && account.isFake(),
    dev: import.meta.env.DEV,
    commands: sectionShown("commands", features),
  });
  const active = resolveSection(requested, visible);
  const info = sectionInfo(active);
  // At a phone's width only one column shows: the list first, then the section picked from it.
  const [view, setView] = useState<"list" | "section">("list");
  // The search box (issue #430): while it holds words, the rows every section has that match show in
  // place of the chosen section. It starts empty each time the window opens.
  const [query, setQuery] = useState("");
  const searchBox = useRef<HTMLInputElement | null>(null);
  const searching = tokensOf(query).length > 0;
  const shownSections = visible.join(",");
  const groups = useMemo(() => matchRows(searchRows(isDesktop()), query, shownSections === "" ? [] : (shownSections.split(",") as SettingsSection[])), [query, shownSections]);
  const matches = resultCount(groups);
  const matchesIn = (id: SettingsSection): number => groups.find((group) => group.section === id)?.rows.length ?? 0;

  const titleId = useId();
  const paneTitleId = useId();
  const windowRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  // Menus and lists opened from a control in here are portalled into this layer, inside the
  // backdrop, so they draw over the window and the focus guard counts them as inside (issue #313).
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const unsavedRobot = useRobotUnsaved();
  // Closing with an unsaved robot.json asks first, here and not in a dialog (issue #414, UI_GUIDE 9.17),
  // with the unsaved-changes question's own buttons, in its order and words.
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const askBox = useRef<HTMLDivElement | null>(null);
  const stopAsking = (): void => {
    setAsking(false);
    setAskProblem(null);
  };
  const requestCloseRef = useRef<() => void>(closeSettings);
  const requestClose = (): void => {
    if (unsavedRobot === null) {
      closeSettings();
      return;
    }
    setAskProblem(null);
    setAsking(true);
  };
  requestCloseRef.current = requestClose;
  // Esc answers the ask first, as Keep editing; the window closes on the next one.
  useEscapeFirst(asking, stopAsking);
  useEffect(() => {
    if (asking) askBox.current?.querySelector("button")?.focus({ preventScroll: true });
    setRobotCloseAsk(asking);
  }, [asking]);
  useEffect(
    () => () => {
      setRobotCloseAsk(false);
    },
    [],
  );
  // After a form or an ask goes away, focus can be on the page body, outside the window: Escape then
  // still closes it, as it does from inside, so a second press is never lost (issue #414).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const root = windowRef.current;
      if (root === null || root.contains(document.activeElement)) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && active.closest("dialog[open]") !== null) return;
      event.preventDefault();
      requestCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  // The draft is gone however it went (saved, discarded, or saved elsewhere): nothing is left to ask.
  useEffect(() => {
    if (unsavedRobot === null && asking) stopAsking();
  }, [unsavedRobot, asking]);
  const paneTitleRef = useRef<HTMLHeadingElement | null>(null);
  // Read while rendering, before anything inside takes focus, so it can be given back on close.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    const opener = openerRef.current ?? null;
    const root = windowRef.current;
    const backdrop = backdropRef.current;
    root?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true });
    // Focus that leaves the window, by a click on the backdrop's edge or a script, comes back in.
    // A menu in the popover layer is the window's own, so focus in it stays there.
    const keepInside = (event: FocusEvent): void => {
      const target = event.target;
      if (root === null || !(target instanceof Node) || root.contains(target)) return;
      if (backdrop !== null && target !== backdrop && backdrop.contains(target)) return;
      (focusables(root)[0] ?? root).focus({ preventScroll: true });
    };
    document.addEventListener("focusin", keepInside);
    return () => {
      document.removeEventListener("focusin", keepInside);
      if (opener !== null && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  // Opened at one setting (`openSettingsAt`): after the effect above has focused the section's list
  // item, the setting's row comes into view and its control takes focus, at a phone's width too.
  // The request is held until the section view has been committed: at a phone's width the pane is
  // not displayed while the list shows, and a control that is not displayed cannot take focus.
  const [pendingFocus, setPendingFocus] = useState<NonNullable<SettingsState["focus"]> | null>(null);
  useEffect(() => {
    if (focus === undefined) return;
    setView("section");
    setPendingFocus(focus);
    clearSettingsFocus();
  }, [focus]);
  useEffect(() => {
    if (pendingFocus === null || view !== "section") return;
    setPendingFocus(null);
    // A setting's row has its registry id as `data-setting`; a row drawn by hand has its test id.
    // Several, separated by a bar, are tried in order (`SearchRow.target`).
    const root = windowRef.current;
    let row: HTMLElement | null | undefined = null;
    for (const target of pendingFocus.split("|")) {
      row =
        root?.querySelector<HTMLElement>(`[data-setting="${target}"]`) ?? root?.querySelector<HTMLElement>(`[data-testid="${target}"]`);
      if (row !== null && row !== undefined) break;
    }
    if (row === null || row === undefined) return;
    row.scrollIntoView({ block: "nearest" });
    const control =
      row.querySelector<HTMLElement>('[aria-pressed="true"]') ?? (row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE));
    control?.focus({ preventScroll: true });
  }, [pendingFocus, view]);

  // Signing out, from here or anywhere, ends what most sections show; the window closes with it.
  const hadUser = useRef(uid !== null);
  useEffect(() => {
    if (hadUser.current && uid === null) closeSettings();
    hadUser.current = uid !== null;
  }, [uid]);

  // An account sheet that opens by itself, such as Teams for someone in no team after the fake
  // cloud's switch of user, would sit under the backdrop; the window makes way for it.
  const panel = state.panel;
  useEffect(() => {
    if (panel !== null) closeSettings();
  }, [panel]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Alt + Left and Alt + Right are the app's back and forward, which move between sections too.
    const screenKey =
      event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight");
    if (screenKey) return;
    // Every other key belongs to the window: nothing behind a modal may act on it.
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      // The find key searches Settings, in place of the browser's own find.
      event.preventDefault();
      focusSearch();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // The search is the innermost thing open: Esc empties it first, and the window closes on the next.
      if (query !== "") {
        setQuery("");
        searchBox.current?.focus({ preventScroll: true });
      } else requestClose();
      return;
    }
    if (event.key !== "Tab" || windowRef.current === null) return;
    const items = focusables(windowRef.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /** Puts the cursor in the search box, with what is in it selected. At a phone's width that is the list's screen. */
  const focusSearch = (): void => {
    setView("list");
    requestAnimationFrame(() => {
      searchBox.current?.focus({ preventScroll: true });
      searchBox.current?.select();
    });
  };

  const choose = (row: SearchRow): void => {
    setQuery("");
    openSettingsRow(row.section, row.target);
  };

  const pick = (id: SettingsSection): void => {
    setQuery("");
    showSettingsSection(id);
    setView("section");
    // At a phone's width the list goes away, so focus moves to what replaced it.
    requestAnimationFrame(() => {
      if (windowRef.current?.dataset["narrow"] === "true") paneTitleRef.current?.focus({ preventScroll: true });
    });
  };

  return (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      data-testid="settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={windowRef}
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="settings"
        data-view={view}
        data-section={active}
        data-searching={searching ? "true" : undefined}
        onKeyDown={onKeyDown}
      >
        <NarrowFlag windowRef={windowRef} />
        <nav className={styles.nav} aria-labelledby={titleId}>
          <div className={styles.titleRow}>
            <h2 id={titleId} className={styles.title}>
              Settings
            </h2>
            <HelpTip id="settings" />
          </div>
          <SearchBox
            query={query}
            onQuery={setQuery}
            inputRef={searchBox}
            onFirst={() => {
              const first = groups[0]?.rows[0];
              if (first !== undefined) choose(first);
            }}
            onDown={() => {
              windowRef.current?.querySelector<HTMLElement>("button[data-result]")?.focus({ preventScroll: true });
            }}
          />
          <ul className={styles.navList}>
            {visible.map((id) => {
              const Icon = ICONS[id];
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={styles.navItem}
                    aria-current={id === active && !searching ? "page" : undefined}
                    data-testid={`settings-nav-${id}`}
                    onClick={() => {
                      pick(id);
                    }}
                  >
                    <Icon size={16} strokeWidth={1.75} aria-hidden />
                    <span>{sectionInfo(id).label}</span>
                    {searching && matchesIn(id) > 0 ? (
                      <span className={styles.navCount} data-testid={`settings-count-${id}`}>
                        {matchesIn(id)}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <section className={styles.pane} aria-labelledby={paneTitleId} data-testid={searching ? "settings-section-search" : `settings-section-${active}`}>
          <header className={styles.paneHead}>
            <button
              type="button"
              className={styles.back}
              data-testid="settings-back"
              onClick={() => {
                setView("list");
                requestAnimationFrame(() => {
                  windowRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true });
                });
              }}
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
              All settings
            </button>
            <h3 id={paneTitleId} ref={paneTitleRef} className={styles.paneTitle} tabIndex={-1}>
              {searching ? "Search results" : info.label}
            </h3>
            {searching ? (
              <p className={styles.paneSub} data-testid="settings-search-count">
                {matches === 0 ? "Nothing found" : `${String(matches)} ${matches === 1 ? "setting" : "settings"} in ${String(groups.length)} ${groups.length === 1 ? "section" : "sections"}`}
              </p>
            ) : null}
          </header>
          {asking && unsavedRobot !== null ? (
            <div ref={askBox} className={styles.closeAsk} role="alertdialog" aria-label="Unsaved changes" data-testid="settings-close-ask">
              <span className={styles.closeAskText}>
                {unsavedRobot} has edits that are not saved. Closing Settings drops them.
              </span>
              <span className={styles.inline}>
                <UnsavedChoices
                  testId="settings-close"
                  saveLabel={`Save ${unsavedRobot}`}
                  saving={saving ? `Saving ${unsavedRobot} now.` : null}
                  onAnswer={(choice) => {
                    if (choice === "cancel") {
                      stopAsking();
                      return;
                    }
                    if (choice === "discard") {
                      discardRobotDraft();
                      closeSettings();
                      return;
                    }
                    setSaving(true);
                    void saveRobotDraft().then((result) => {
                      setSaving(false);
                      if (result.ok) closeSettings();
                      else setAskProblem(result.message);
                    });
                  }}
                />
              </span>
              {askProblem === null ? null : (
                <p className={styles.error} role="alert" data-testid="settings-close-problem">
                  {askProblem}
                </p>
              )}
            </div>
          ) : null}
          {/* One body per section, so each opens at its top, not where the last one was scrolled (UX review, G1). */}
          <div key={searching ? "search" : active} className={styles.paneBody} data-testid="settings-pane-body">
            {searching ? (
              <SearchResults
                groups={groups}
                query={query}
                onChoose={choose}
                onUp={() => {
                  searchBox.current?.focus({ preventScroll: true });
                }}
              />
            ) : (
              <PopoverLayer.Provider value={layer}>
                {PROJECT_SECTIONS.includes(active) ? <ExampleBanner /> : null}
                <Pane section={active} admin={admin} />
              </PopoverLayer.Provider>
            )}
          </div>
        </section>
        <span className={styles.close}>
          <RowButton icon={X} label="Close" shortcut="Esc" hint={closeHint(unsavedRobot)} onClick={requestClose} testId="settings-close" />
        </span>
      </div>
      <div ref={setLayer} className={styles.popoverLayer} data-testid="settings-popover-layer" />
    </div>
  );
}

/** The sections whose values are the open project's files, which show the example's one read-only banner. General is the person's own switches (issue #414). */
const PROJECT_SECTIONS: readonly SettingsSection[] = ["robot", "commands"];

function Pane({ section, admin }: { section: SettingsSection; admin: boolean }) {
  switch (section) {
    case "account":
      return <AccountPane />;
    case "presets":
      return <PresetsPane />;
    case "teams":
      return <TeamsPane />;
    case "general":
      return <GeneralPane />;
    case "robot":
      return <RobotPane />;
    case "commands":
      return <CommandsPane />;
    case "editor":
      return <EditorPane />;
    case "keyboard":
      return <KeyboardPane />;
    case "data":
      return <DataPane />;
    case "admin":
      return <AdminPane admin={admin} />;
    case "developer":
      return <DeveloperPane />;
  }
}

/** The width at which the window fills the screen, the same as `Settings.module.css`. */
const NARROW_QUERY = "(max-width: 640px)";

/** Marks the window narrow while the page is, so focus can follow the one column that shows. */
function NarrowFlag({ windowRef }: { windowRef: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const apply = (): void => {
      if (windowRef.current !== null) windowRef.current.dataset["narrow"] = String(query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, [windowRef]);
  return null;
}
