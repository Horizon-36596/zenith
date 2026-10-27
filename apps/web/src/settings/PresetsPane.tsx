/**
 * Settings, Presets: the preset the settings came from and the changes since, derived and never stored;
 * the built-ins, Basic, Essential and Full; the person's own presets; and preset files. Picking another
 * preset while there are changes asks first, and a user preset with its own keys asks before it
 * replaces the person's. An import adds a preset and shows what it would change, and applies nothing.
 * The open project's presets are listed for everyone who opens it, and Add to project puts one of the
 * person's there. Every rule is in `presets.ts`, `presetFile.ts`, `presetStore.ts`, `projectPresets.ts`
 * and `projectPresetStore.ts`; this file only draws them.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, FileUp, FolderUp, Pencil, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { Button, TextButton } from "../components/primitives";
import { ConfirmRow } from "../components/ConfirmRow";
import { downloadText } from "../project/fallback";
import { projectPresetPath } from "../project/presetPaths";
import { projectKey } from "../project/types";
import { getState, setSetting, setStatus, useSelector } from "../state/store";
import type { Prefs } from "../state/prefs";
import { Group, Row, RowMenu, useEscapeFirst } from "./parts";
import { MAX_PRESET_FILE_BYTES, presetFileName, presetFileText, presetTooLargeMessage, type PresetImportReport } from "./presetFile";
import {
  BUILT_IN_PRESETS,
  MAX_PRESET_NAME,
  MAX_USER_PRESETS,
  builtInBase,
  changesFrom,
  presetLabel,
  presetValueOf,
  recordedUserPreset,
  sameValue,
  wouldChange,
  type PresetId,
  type UserPreset,
} from "./presets";
import {
  applyPresetById,
  applyProjectPreset,
  deletePreset,
  duplicatePreset,
  fullReason,
  importPresetText,
  presetUndoFrom,
  renamePreset,
  undoPresetApply,
  type PresetUndo,
  saveCurrentAsPreset,
  updatePresetFromCurrent,
  useUserPresets,
} from "./presetStore";
import { addPresetToProject, addToProjectReason, refreshProjectPresets, useProjectPresets } from "./projectPresetStore";
import { linkedCopy, matchesFile, type ProjectPreset } from "./projectPresets";
import { getSetting, settingEntry, type SettingEntry, type SettingId } from "./registry";
import styles from "./Settings.module.css";

/** A setting's name in a list of changes: a toolbar button says it is one. */
function settingName(id: SettingId): string {
  const entry = settingEntry(id);
  return entry.group === "Toolbar" ? `${entry.label} button` : entry.label;
}

/** A setting's value in words, as its control shows it. */
function valueText(entry: SettingEntry, value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === null || value === undefined) return "Default";
  if (entry.kind === "keys" && typeof value === "object") {
    const count = Object.keys(value).length;
    return count === 0 ? "Every default key" : `${String(count)} of your own`;
  }
  const control = entry.control;
  if ((control.type === "segmented" || control.type === "dropdown") && Array.isArray(control.options)) {
    const option = (control.options as readonly { value: unknown; label: string }[]).find((one) => one.value === value);
    if (option !== undefined) return option.label;
  }
  return String(value);
}

/**
 * "Grid, Ledger", or the first three and how many more. Commas only, since a setting's own name
 * may have an "and" in it, such as "Ledger and ball counting".
 */
function namesOf(ids: readonly SettingId[]): string {
  const names = ids.map(settingName);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${String(names.length - 3)} more`;
}

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;

/** What an import kept and what it did not, as the lines under Import. */
function reportLines(preset: UserPreset, report: PresetImportReport, changes: readonly SettingId[]): string[] {
  const lines = [
    `Added ${preset.name}. Nothing changed yet: ${
      changes.length === 0 ? "applying it would change no setting." : `applying it would change ${plural(changes.length, "setting", "settings")}, ${namesOf(changes)}.`
    }`,
  ];
  if (report.renamed) lines.push(`Its name was taken, so it is called ${preset.name}.`);
  if (report.unknown > 0) lines.push(`${plural(report.unknown, "setting this version does not know was", "settings this version does not know were")} ignored.`);
  if (report.dropped.length > 0) lines.push(`Left out, as their values were not valid: ${report.dropped.join(", ")}.`);
  for (const refusal of report.refused) lines.push(`Left out ${refusal.id}: ${refusal.reason}`);
  for (const refusal of report.keysRefused) lines.push(`Key for ${refusal.id} not kept: ${refusal.reason}`);
  for (const one of report.ignored) lines.push(one.reason);
  return lines;
}

/** One of the open project's presets, by its file, as Apply and the asks name it. */
type ProjectTarget = `project:${string}`;

/** What Apply was pressed on: a built-in, one of the person's presets, or one of the project's. */
type Target = PresetId | ProjectTarget;

const projectTarget = (file: string): ProjectTarget => `project:${file}`;

/** A preset the person picked, waiting on a question first. */
interface Pending {
  id: Target;
  stage: "changes" | "keys";
}

/** "Based on Full, with keys." */
function aboutBase(basedOn: PresetId, keys: boolean): string {
  const baseName = BUILT_IN_PRESETS.find((one) => one.id === basedOn)?.name ?? "Essential";
  return `Based on ${baseName}${keys ? ", with keys" : ""}.`;
}

export function PresetsPane() {
  const prefs = useSelector((state) => state.prefs);
  const users = useUserPresets();
  const changes = changesFrom(prefs, users);
  const recorded = recordedUserPreset(prefs.preset, users);
  const label = presetLabel(prefs.preset, users);
  const base = builtInBase(prefs.preset, users);
  const customKeys = Object.keys(prefs.keys).length > 0;
  const full = fullReason(users);
  const openProject = useSelector((state) => state.project);
  const projectView = useProjectPresets();
  // The open project's key, which links a person's copy to a project file; null with no project open.
  const openKey = openProject === null ? null : projectKey(openProject);
  const projectItems = projectView.project === openKey ? projectView.list.presets : [];
  // Read the project's presets each time the pane is shown and when another project opens, so a
  // file pulled from git since is listed (spec 15 section 6.5).
  const autosDir = openProject?.link.autosDir ?? null;
  useEffect(() => {
    void refreshProjectPresets();
  }, [openKey, autosDir]);

  const [showChanges, setShowChanges] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // The save form, and the preset to apply once it has saved ("Save them as a preset" in the ask).
  const [saving, setSaving] = useState<{ then: Target | null } | null>(null);
  // What a preset action did is the status line's, which describes the latest action (issue #414).
  const say = (line: string, ok = true): void => {
    setStatus(ok ? "ok" : "error", line);
  };
  const [importLines, setImportLines] = useState<{ ok: boolean; lines: string[] } | null>(null);
  // The last apply, which Undo takes back in one step (UI_GUIDE 9.15); null once undone or none yet.
  const [lastApply, setLastApply] = useState<{ name: string; undo: PresetUndo } | null>(null);
  /** Says what an apply changed, from the settings as they were before it, and keeps its undo. */
  const applied = (name: string, before: Prefs): void => {
    const undo = presetUndoFrom(before, getState().prefs);
    const count = undo.changed.length;
    say(`Applied ${name}: ${count === 0 ? "no settings changed" : `${plural(count, "setting", "settings")} changed`}.`);
    setLastApply({ name, undo });
  };
  const fileInput = useRef<HTMLInputElement | null>(null);

  // The file Add to project writes: a copy's own file in this project, so a renamed copy still updates
  // it, or one named after the preset.
  const projectFileOf = (preset: UserPreset): string =>
    openKey !== null && preset.fromProject?.project === openKey ? preset.fromProject.file : presetFileName(preset.name);

  const projectItem = (id: Target): ProjectPreset | undefined =>
    id.startsWith("project:") ? projectItems.find((item) => projectTarget(item.file) === id) : undefined;

  const nameOf = (id: Target): string =>
    projectItem(id)?.preset.name ??
    BUILT_IN_PRESETS.find((preset) => preset.id === id)?.name ??
    users.find((preset) => preset.id === id)?.name ??
    "that preset";

  const finish = (id: Target, keys: boolean): void => {
    setPending(null);
    setShowChanges(false);
    const item = projectItem(id);
    const before = getState().prefs;
    if (id.startsWith("project:")) {
      // The project's preset is applied through the person's linked copy of it.
      const result = item === undefined || openKey === null ? null : applyProjectPreset(openKey, item, { keys });
      if (result === null) say("That preset is no longer in the project.", false);
      else if (result.ok) applied(result.preset.name, before);
      else say(result.reason, false);
      return;
    }
    applyPresetById(id as PresetId, { keys });
    applied(nameOf(id), before);
  };

  // A preset with keys of its own, the person's or the project's, asks before it replaces theirs.
  const askKeys = (id: Target): void => {
    const keys = projectItem(id)?.preset.keys ?? users.find((one) => one.id === id)?.keys;
    if (keys !== undefined && !sameValue(keys, prefs.keys)) setPending({ id, stage: "keys" });
    else finish(id, keys !== undefined);
  };

  const choose = (id: Target): void => {
    setSaving(null);
    if (changes.length > 0) setPending({ id, stage: "changes" });
    else askKeys(id);
  };

  const revertAll = (): void => {
    setPending(null);
    if (recorded === undefined) finish(base, false);
    // After "Keep my keys" the person's keys are not a change, so a revert leaves them too.
    else finish(recorded.id, prefs.preset.keptKeys !== true);
  };

  const exportPreset = (preset: UserPreset): void => {
    downloadText(presetFileName(preset.name), presetFileText(preset));
    say(`Exported ${preset.name}.`);
  };

  const importFile = async (file: File): Promise<void> => {
    if (file.size > MAX_PRESET_FILE_BYTES) {
      setImportLines({ ok: false, lines: [presetTooLargeMessage(file.name)] });
      return;
    }
    const result = importPresetText(await file.text(), file.name);
    if (!result.ok) {
      setImportLines({ ok: false, lines: [result.reason] });
      return;
    }
    setImportLines({ ok: true, lines: reportLines(result.preset, result.report, wouldChange(prefs, result.preset)) });
  };

  const saveForm = (current: { then: Target | null }) => (
    <SaveForm
      customKeys={customKeys}
      onCancel={() => {
        setSaving(null);
      }}
      onSave={(given) => {
        const result = saveCurrentAsPreset(given);
        if (!result.ok) return result.reason;
        setSaving(null);
        say(`Saved ${result.preset.name}.`);
        if (current.then !== null) askKeys(current.then);
        return undefined;
      }}
    />
  );

  /**
   * The ask, or the save form it led to, drawn under the row whose Apply was pressed, so it is
   * where the person is looking however far down the pane that row is (issue #284, PR #353 review).
   */
  const askFor = (id: Target) => {
    if (pending?.id === id) {
      const asked = pending;
      return (
        <Ask
          pending={asked}
          count={changes.length}
          from={label}
          name={nameOf(asked.id)}
          onSave={() => {
            setSaving({ then: asked.id });
            setPending(null);
          }}
          onReplace={() => {
            askKeys(asked.id);
          }}
          onKeys={(keys) => {
            finish(asked.id, keys);
          }}
          onCancel={() => {
            setPending(null);
          }}
        />
      );
    }
    if (saving !== null && saving.then === id) return saveForm(saving);
    return undefined;
  };

  const edited = changes.length > 0;
  // The row that says "In use" is the one the settings came from; with none (a Custom preset) the line says so.
  const inList = BUILT_IN_PRESETS.some((preset) => preset.id === prefs.preset.id) || recorded !== undefined;
  const baseName = recorded?.name ?? BUILT_IN_PRESETS.find((preset) => preset.id === base)?.name ?? "Essential";

  return (
    <>
      {lastApply === null ? null : (
        <Group testId="presets-last-apply">
          <Row label={`Applied ${lastApply.name}`} testId="presets-last-apply-row">
            <TextButton
              icon={Undo2}
              label="Undo"
              hint={`Put back the settings you had before ${lastApply.name}.`}
              testId="presets-undo-apply"
              onClick={() => {
                undoPresetApply(lastApply.undo);
                setLastApply(null);
                say(`Undid: Applied ${lastApply.name}.`);
              }}
            />
          </Row>
        </Group>
      )}
      {edited || !inList ? (
        <Group testId="presets-current">
          <Row label={`Using ${label}${edited ? " (edited)" : ""}`} testId="presets-summary" labelTestId="presets-summary-text">
            <span className={styles.inline}>
              <TextButton
                label={showChanges ? "Hide changes" : "Show changes"}
                hint={`List the ${plural(changes.length, "setting", "settings")} you changed from ${label}.`}
                disabled={!edited}
                whyDisabled={`Every setting is as ${label} sets it.`}
                testId="presets-show-changes"
                onClick={() => {
                  setShowChanges(!showChanges);
                }}
              />
              <TextButton
                icon={RotateCcw}
                label={`Revert to ${baseName}`}
                hint="Set every setting back to what the preset sets."
                disabled={!edited}
                whyDisabled={`Every setting is as ${label} sets it.`}
                testId="presets-revert"
                onClick={revertAll}
              />
              {recorded === undefined ? null : (
                <TextButton
                  icon={Save}
                  label={`Update "${recorded.name}"`}
                  hint="Save the settings you have now into this preset."
                  disabled={!edited}
                  whyDisabled={`Every setting is already as ${recorded.name} sets it.`}
                  testId="presets-update-current"
                  onClick={() => {
                    updatePresetFromCurrent(recorded.id);
                    say(`Updated ${recorded.name}.`);
                  }}
                />
              )}
            </span>
          </Row>
          {showChanges && edited
            ? changes.map((id) => {
                const entry = settingEntry(id);
                return (
                  <Row
                    key={id}
                    label={settingName(id)}
                    description={`Now ${valueText(entry, getSetting(prefs, id))}. ${label} has ${valueText(entry, presetValueOf(prefs, users, id))}.`}
                    testId={`presets-change-${id}`}
                  >
                    <TextButton
                      icon={RotateCcw}
                      label="Revert"
                      hint={`Set ${settingName(id)} back to what ${label} sets.`}
                      testId={`presets-revert-${id}`}
                      onClick={() => {
                        const value = presetValueOf(prefs, users, id);
                        if (value !== undefined) setSetting(id, value as never);
                      }}
                    />
                  </Row>
                );
              })
            : null}
        </Group>
      ) : null}

      {openProject === null ? null : (
        <Group title="This project's presets" aside={projectItems.length === 0 ? undefined : String(projectItems.length)} testId="presets-project">
          {projectItems.map((item) => {
            const copy = openKey === null ? undefined : linkedCopy(users, openKey, item.file);
            const current = copy !== undefined && matchesFile(copy, item.preset);
            const inUse = current && prefs.preset.id === copy.id;
            const about = [
              item.preset.description,
              aboutBase(item.preset.basedOn, item.preset.keys !== undefined),
              copy !== undefined && !current ? "Changed in the project since you applied it." : "",
            ]
              .filter((part) => part !== "")
              .join(" ");
            return (
              <Row
                key={item.file}
                label={item.preset.name}
                description={about}
                testId={`presets-project-${item.preset.name}`}
                below={askFor(projectTarget(item.file))}
              >
                {inUse ? (
                  <InUse testId="presets-project-in-use" />
                ) : (
                  <TextButton
                    label="Apply"
                    hint={`Set every setting ${item.preset.name} sets. A copy is kept in Your presets.`}
                    disabled={copy === undefined && full !== undefined}
                    whyDisabled={full}
                    testId="presets-project-apply"
                    onClick={() => {
                      choose(projectTarget(item.file));
                    }}
                  />
                )}
              </Row>
            );
          })}
          {projectView.project === openKey && projectView.error !== null ? (
            <Row label="Presets folder" description={projectView.error} testId="presets-project-error" />
          ) : null}
          {(projectView.project === openKey ? projectView.list.problems : []).map((problem) => (
            <Row key={problem.file} label={problem.file} description={`Not read. ${problem.reason}`} testId="presets-project-problem" />
          ))}
          {projectView.project === openKey && projectView.list.more > 0 ? (
            <Row
              label={`${plural(projectView.list.more, "more file", "more files")}`}
              description="Zenith reads the first 20 preset files in the project, in name order."
              testId="presets-project-more"
            />
          ) : null}
          {projectItems.length === 0 && (projectView.project !== openKey || (projectView.error === null && projectView.list.problems.length === 0)) ? (
            <Row
              label="None yet"
              description={
                addToProjectReason() === null
                  ? `Use Add to project on one of your presets. It goes in ${projectPresetPath(openProject.link, "")}, and everyone who opens this project can apply it.`
                  : "This project has no presets."
              }
              testId="presets-project-none"
            />
          ) : null}
        </Group>
      )}

      <Group title="Built-in presets" testId="presets-builtins">
        {BUILT_IN_PRESETS.map((preset) => {
          const inUse = prefs.preset.id === preset.id;
          return (
            <Row
              key={preset.id}
              label={preset.name}
              description={preset.description}
              testId={`presets-builtin-${preset.id}`}
              below={askFor(preset.id)}
            >
              <span className={styles.inline}>
                {inUse ? (
                  <InUse testId={`presets-in-use-${preset.id}`} />
                ) : (
                  <TextButton
                    label="Apply"
                    hint={`Set every setting ${preset.name} sets. Your keys stay as they are.`}
                    testId={`presets-apply-${preset.id}`}
                    onClick={() => {
                      choose(preset.id);
                    }}
                  />
                )}
                <RowMenu
                  label={`More for ${preset.name}`}
                  testId={`presets-menu-${preset.id}`}
                  entries={[
                    {
                      id: `presets-duplicate-${preset.id}`,
                      label: "Duplicate",
                      does: `Make a copy of ${preset.name} you can change and rename.`,
                      icon: Copy,
                      whyDisabled: full ?? null,
                      run: () => {
                        const result = duplicatePreset(preset.id);
                        say(result.ok ? `Made ${result.preset.name}.` : result.reason, result.ok);
                      },
                    },
                  ]}
                />
              </span>
            </Row>
          );
        })}
      </Group>

      <Group
        title="Your presets"
        aside={`${String(users.length)} of ${String(MAX_USER_PRESETS)}`}
        testId="presets-mine"
      >
        {users.length === 0 ? (
          <Row label="None yet" description="Save your settings as a preset, or import a preset file from a teammate." testId="presets-none" />
        ) : (
          users.map((preset) => (
            <UserPresetRow
              key={preset.id}
              preset={preset}
              inUse={prefs.preset.id === preset.id}
              full={full}
              fromThisProject={openKey !== null && preset.fromProject?.project === openKey}
              inProject={projectItems.find((item) => item.file === projectFileOf(preset))}
              projectFileProblem={projectView.project === openKey && projectView.list.problems.some((problem) => problem.file === projectFileOf(preset))}
              addReason={addToProjectReason()}
              onAddToProject={async () => {
                const file = projectFileOf(preset);
                const result = await addPresetToProject(preset, file, projectItems.find((item) => item.file === file)?.preset.name);
                say(result.message, result.ok);
              }}
              onApply={() => {
                choose(preset.id);
              }}
              onExport={() => {
                exportPreset(preset);
              }}
              onSaid={say}
              ask={askFor(preset.id)}
            />
          ))
        )}
        <Row
          label="Save my settings"
          description="Keep the settings you have now as a preset of your own."
          testId="presets-save-row"
          below={saving === null || saving.then !== null ? undefined : saveForm(saving)}
        >
          <TextButton
            icon={Save}
            label="Save as a preset…"
            hint="Keep the settings you have now as a preset of your own."
            disabled={full !== undefined}
            whyDisabled={full}
            testId="presets-save"
            onClick={() => {
              setPending(null);
              setSaving({ then: null });
            }}
          />
        </Row>
        <Row
          label="Preset file"
          description="A .zenith-preset.json file from Export. Importing adds it to this list and changes nothing until you apply it."
          testId="presets-import-row"
          below={
            importLines === null ? undefined : importLines.ok ? (
              <ul className={styles.params} data-testid="presets-import-note" role="status">
                {importLines.lines.map((line) => (
                  <li key={line} className={styles.note}>
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              // A refused file is an error line like every other in Settings, in its type, not the
              // report's list (UX review, S5).
              <p className={styles.error} data-testid="presets-import-note" role="alert">
                {importLines.lines.join(" ")}
              </p>
            )
          }
        >
          <TextButton
            icon={FileUp}
            label="Import a preset file…"
            hint="Add a preset from a .zenith-preset.json file. It is not applied."
            disabled={full !== undefined}
            whyDisabled={full}
            testId="presets-import"
            onClick={() => {
              fileInput.current?.click();
            }}
          />
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            tabIndex={-1}
            aria-label="Preset file"
            data-testid="presets-import-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void importFile(file);
            }}
          />
        </Row>
      </Group>
      <p className={styles.paneNote}>Presets are yours, on this computer. A preset file carries one to a teammate, and Add to project to everyone who opens the project.</p>
    </>
  );
}

/** The question before a pick: what to do with the changes, then whether the preset's keys replace the person's. */
function Ask({
  pending,
  count,
  from,
  name,
  onSave,
  onReplace,
  onKeys,
  onCancel,
}: {
  pending: Pending;
  count: number;
  from: string;
  name: string;
  onSave: () => void;
  onReplace: () => void;
  onKeys: (keys: boolean) => void;
  onCancel: () => void;
}) {
  // Each question takes the focus on its first answer and is scrolled into view, so the person
  // lands on it after Apply, with a keyboard or a pointer.
  const box = useRef<HTMLDivElement | null>(null);
  useEscapeFirst(true, onCancel);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
    element.querySelector("button")?.focus({ preventScroll: true });
  }, [pending.id, pending.stage]);
  if (pending.stage === "changes") {
    return (
      <div ref={box} className={styles.confirm} data-testid="presets-ask-changes" role="group" aria-label="Your changes">
        <span className={styles.note}>
          You changed {plural(count, "setting", "settings")} from {from}.
        </span>
        <span className={styles.inline}>
          <Button tooltip="Cancel" hint="Keep your settings as they are." testId="presets-ask-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button tooltip="Replace them" hint={`Apply ${name}, and let your changes go.`} testId="presets-ask-replace" onClick={onReplace}>
            Replace them
          </Button>
          <Button kind="primary" tooltip="Save them as a preset" hint={`Keep them as a preset of your own, then apply ${name}.`} testId="presets-ask-save" onClick={onSave}>
            Save them as a preset…
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div ref={box} className={styles.confirm} data-testid="presets-ask-keys" role="group" aria-label="Its keys">
      <span className={styles.note}>{name} has keys of its own. Replace your keys with them?</span>
      <span className={styles.inline}>
        <Button tooltip="Cancel" hint="Apply nothing." testId="presets-ask-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          tooltip="Keep my keys"
          hint={`Apply ${name}'s settings and keep your keys.`}
          testId="presets-ask-keys-keep"
          onClick={() => {
            onKeys(false);
          }}
        >
          Keep my keys
        </Button>
        <Button
          kind="primary"
          tooltip="Replace my keys"
          hint={`Apply ${name} with its keys.`}
          testId="presets-ask-keys-replace"
          onClick={() => {
            onKeys(true);
          }}
        >
          Replace my keys
        </Button>
      </span>
    </div>
  );
}

/** "Save current settings as a preset…": a name, an optional description, and Include my keys when there are any. */
function SaveForm({
  customKeys,
  onSave,
  onCancel,
}: {
  customKeys: boolean;
  onSave: (given: { name: string; description: string; includeKeys: boolean }) => string | undefined;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includeKeys, setIncludeKeys] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Esc gives up the form and nothing else: the window stays (issue #414).
  useEscapeFirst(true, onCancel);
  return (
    <form
      className={styles.form}
      data-testid="presets-save-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(onSave({ name, description, includeKeys: customKeys && includeKeys }));
      }}
    >
      <label className={styles.presetField}>
        <span className={styles.rowLabel}>Name</span>
        <input
          className={styles.presetInput}
          value={name}
          maxLength={MAX_PRESET_NAME}
          autoFocus
          data-testid="presets-save-name"
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
          }}
        />
      </label>
      <label className={styles.presetField}>
        <span className={styles.rowLabel}>Description</span>
        <input
          className={styles.presetInput}
          value={description}
          placeholder="Optional"
          data-testid="presets-save-description"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      {customKeys ? (
        <label className={styles.presetCheck}>
          <input
            type="checkbox"
            checked={includeKeys}
            data-testid="presets-save-keys"
            onChange={(event) => {
              setIncludeKeys(event.target.checked);
            }}
          />
          <span className={styles.value}>Include my keys</span>
        </label>
      ) : null}
      {error === undefined ? null : (
        <p className={styles.error} role="alert" data-testid="presets-save-error">
          {error}
        </p>
      )}
      <span className={styles.formActions}>
        <Button testId="presets-save-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" kind="primary" testId="presets-save-confirm">
          Save
        </Button>
      </span>
    </form>
  );
}

/**
 * One of the person's presets: Apply, and Rename, Duplicate, Update, Export, Add to project and
 * Delete under it.
 */
function UserPresetRow({
  preset,
  inUse,
  full,
  fromThisProject,
  inProject,
  projectFileProblem,
  addReason,
  onAddToProject,
  onApply,
  onExport,
  onSaid,
  ask,
}: {
  preset: UserPreset;
  inUse: boolean;
  full: string | undefined;
  /** It is the person's copy of one of the open project's presets. */
  fromThisProject: boolean;
  /** The open project's preset in the file Add to project would write, when there is one. */
  inProject: ProjectPreset | undefined;
  /** The open project has a file of that name that could not be read as a preset. */
  projectFileProblem: boolean;
  /** Why Add to project cannot write into the open project, or null when it can. */
  addReason: string | null;
  onAddToProject: () => Promise<void>;
  onApply: () => void;
  onExport: () => void;
  onSaid: (line: string, ok?: boolean) => void;
  /** The ask after this row's Apply, or the save form it led to. */
  ask: ReactNode;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [adding, setAdding] = useState(false);
  useEscapeFirst(renaming !== null || confirmDelete || confirmReplace, () => {
    setRenaming(null);
    setRenameError(undefined);
    setConfirmDelete(false);
    setConfirmReplace(false);
  });
  const about = [preset.description, aboutBase(preset.basedOn, preset.keys !== undefined), fromThisProject ? "From this project." : ""]
    .filter((part) => part !== "")
    .join(" ");
  const file = inProject?.file ?? presetFileName(preset.name);
  // The file is already in the project: the button updates it, and asks first unless it already matches.
  const replaces = inProject !== undefined || projectFileProblem;
  const matches = inProject !== undefined && matchesFile(preset, inProject.preset);
  const addToProject = async (): Promise<void> => {
    setConfirmReplace(false);
    setAdding(true);
    try {
      await onAddToProject();
    } finally {
      setAdding(false);
    }
  };
  return (
    <Row
      label={preset.name}
      description={about}
      testId={`presets-user-${preset.name}`}
      below={
        <>
          {ask}
          {renaming === null ? null : (
            <form
              className={styles.inline}
              data-testid="presets-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                const result = renamePreset(preset.id, renaming);
                if (!result.ok) {
                  setRenameError(result.reason);
                  return;
                }
                setRenaming(null);
                onSaid(`Renamed it ${result.preset.name}.`);
              }}
            >
              <input
                className={styles.presetInput}
                aria-label="New name"
                value={renaming}
                maxLength={MAX_PRESET_NAME}
                autoFocus
                data-testid="presets-rename-name"
                onChange={(event) => {
                  setRenaming(event.target.value);
                  setRenameError(undefined);
                }}
              />
              <Button
                testId="presets-rename-cancel"
                onClick={() => {
                  setRenaming(null);
                  setRenameError(undefined);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" kind="primary" testId="presets-rename-confirm">
                Rename
              </Button>
              {renameError === undefined ? null : (
                <p className={styles.error} role="alert" data-testid="presets-rename-error">
                  {renameError}
                </p>
              )}
            </form>
          )}
          {confirmReplace ? (
            <ConfirmRow
              testId="presets-replace-ask"
              confirmTestId="presets-replace-confirm"
              cancelTestId="presets-replace-cancel"
              sentence={`The project already has ${file}. Replace it with your ${preset.name}?`}
              verb="Replace"
              onConfirm={() => {
                void addToProject();
              }}
              onCancel={() => {
                setConfirmReplace(false);
              }}
            />
          ) : null}
          {confirmDelete ? (
            <ConfirmRow
              testId="presets-delete-ask"
              confirmTestId="presets-delete-confirm"
              cancelTestId="presets-delete-cancel"
              sentence={`Delete ${preset.name}? Your settings stay as they are.`}
              verb="Delete"
              onConfirm={() => {
                deletePreset(preset.id);
                onSaid(`Deleted ${preset.name}.`);
              }}
              onCancel={() => {
                setConfirmDelete(false);
              }}
            />
          ) : null}
        </>
      }
    >
      <span className={styles.inline}>
        {inUse ? (
          <InUse testId="presets-in-use" />
        ) : (
          <TextButton label="Apply" hint={`Set every setting ${preset.name} sets.`} testId="presets-apply" onClick={onApply} />
        )}
        <RowMenu
          label={`More for ${preset.name}`}
          testId={`presets-user-menu-${preset.name}`}
          entries={[
            {
              id: "presets-rename",
              label: "Rename",
              does: "Give it another name.",
              icon: Pencil,
              run: () => {
                setConfirmDelete(false);
                setRenaming(preset.name);
              },
            },
            {
              id: "presets-duplicate",
              label: "Duplicate",
              does: "Make a copy of it.",
              icon: Copy,
              whyDisabled: full ?? null,
              run: () => {
                const result = duplicatePreset(preset.id);
                onSaid(result.ok ? `Made ${result.preset.name}.` : result.reason);
              },
            },
            {
              id: "presets-update",
              label: "Update from current settings",
              does: "Replace what it sets with your settings now.",
              icon: Save,
              run: () => {
                updatePresetFromCurrent(preset.id);
                onSaid(`Updated ${preset.name}.`);
              },
            },
            { id: "presets-export", label: "Export…", does: "Download it as a .zenith-preset.json file.", icon: Download, run: onExport },
            {
              id: "presets-add-to-project",
              label: replaces ? "Update in project" : "Add to project",
              does: replaces
                ? `Write it over ${file} in the project, so teammates who apply it get your changes. Asks first.`
                : "Put it in the open project's presets folder, so everyone who opens the project can apply it.",
              icon: FolderUp,
              whyDisabled: addReason ?? (matches ? "The project's copy already matches." : adding ? "Writing it now." : null),
              run: () => {
                if (replaces && !matches) setConfirmReplace(true);
                else void addToProject();
              },
            },
            {
              id: "presets-delete",
              label: "Delete",
              does: "Delete it from this list. Asks first.",
              icon: Trash2,
              danger: true,
              separatorBefore: true,
              run: () => {
                setRenaming(null);
                setConfirmDelete(true);
              },
            },
          ]}
        />
      </span>
    </Row>
  );
}

/** The mark on the row of the preset the settings came from: a check and "In use". */
function InUse({ testId }: { testId: string }) {
  return (
    <span className={styles.inUse} data-testid={testId}>
      <Check size={12} strokeWidth={1.75} aria-hidden />
      In use
    </span>
  );
}
