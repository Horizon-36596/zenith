/**
 * The Settings window's Robot and Commands sections (issue #100): the open project's `robot.json`,
 * easy to read and change. The robot and its commands stay in that file (owner ruling 2026-10-03);
 * these sections write it through the project's backend (`actions.ts`), which in the desktop app is
 * a narrow call that hands the main process a robot object, never file text or a path.
 *
 * Robot keeps edits as a draft until Save, since a number can be scrubbed through many values on
 * the way to the one wanted; the draft never holds the commands, so saving it cannot undo a command
 * saved meanwhile. Commands saves each command as it is added, changed or removed. A project Zenith
 * cannot write shows the same values read only, with the reason, as General does for the library.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CommandSpec, Robot } from "@horizon36596/zenith-schema";
import { Button, ProvenanceChip } from "../components/primitives";
import { ConfirmRow } from "../components/ConfirmRow";
import { CheckboxField, FieldRow, NumberField, SelectField, TextField } from "../components/fields";
import { KEPT_PROVENANCE_HINT, ProvenancePicker } from "../components/ProvenancePicker";
import { Segmented } from "../components/Segmented";
import { SheetButton } from "../cloud/controls";
import { Tooltip } from "../components/Tooltip";
import { firstSentence } from "../help/descriptions/firstSentence";
import { useDescriptions } from "../help/descriptions/useDescriptions";
import { useFeature } from "../state/features";
import { getState, setDialog, useEditor } from "../state/store";
import { importCommandsBlockedReason } from "../app/commandImport";
import { saveProjectRobot, type WriteOutcome } from "./actions";
import { CodeRows } from "./ProjectPanes";
import { Group, Row, useEscapeFirst } from "./parts";
import {
  CAPACITY,
  CLEARANCE,
  EMPTY_COMMAND,
  EMPTY_PARAM,
  MOUTH_NUMBERS,
  PARAM_TYPES,
  ROBOT_GROUPS,
  SHOOTER_SETTLE,
  addCommand,
  clearanceRow,
  clearanceSummary,
  commandFromDraft,
  describeEstimate,
  describeParam,
  draftAfterSave,
  draftOf,
  mouthNumber,
  numberOf,
  provenanceOf,
  removeCommand,
  replaceCommand,
  sameRobot,
  robotDraftKey,
  robotProblem,
  robotReadOnlyReason,
  setClearance,
  setMouthNumber,
  setMouthProvenance,
  setRobotNumber,
  setRobotProvenance,
  settledOf,
  unsettledCounts,
  unsettledLine,
  withCurrentCommands,
  type CommandDraft,
  type ParamDraft,
  type ParamType,
  type RobotNumber,
} from "./robotSettings";
import { ROBOT_CLEARANCE, closeSettings } from "./store";
import styles from "./Settings.module.css";

/* ---- The Robot section's draft ------------------------------------------------------------- */

/**
 * Unsaved Robot edits, kept outside the component so they survive switching sections and closing
 * the window, for the project they were made in (`key`).
 */
interface RobotDraft {
  key: string;
  robot: Robot;
}

let draft: RobotDraft | null = null;
const draftListeners = new Set<() => void>();
const setDraft = (next: RobotDraft | null): void => {
  draft = next;
  for (const listener of draftListeners) listener();
};
const subscribeDraft = (listener: () => void): (() => void) => {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
};
const useDraft = (): RobotDraft | null => useSyncExternalStore(subscribeDraft, () => draft, () => draft);

/**
 * True while Settings asks about the draft before it closes. The pane's own save bar steps aside
 * then, so the question and its Save are the only ones on screen (UI_GUIDE 9.14).
 */
let closeAsking = false;
export const setRobotCloseAsk = (asking: boolean): void => {
  if (closeAsking === asking) return;
  closeAsking = asking;
  for (const listener of draftListeners) listener();
};
const useCloseAsk = (): boolean => useSyncExternalStore(subscribeDraft, () => closeAsking, () => closeAsking);

/* ---- Shared pieces ---------------------------------------------------------------------------- */

function NoProject({ what }: { what: string }) {
  return (
    <Group title="This project">
      <Row label="No project open" description={`Open a robot project to see ${what}. They are saved in its robot.json.`} testId="settings-robot-no-project" />
    </Group>
  );
}

function ReadOnlyNote({ why, testId }: { why: string; testId: string }) {
  return (
    <p className={styles.paneNote} data-testid={testId}>
      {why}
    </p>
  );
}

function Outcome({ outcome, testId }: { outcome: WriteOutcome | null; testId: string }) {
  if (outcome === null) return null;
  return (
    <p className={outcome.ok ? styles.note : styles.error} role={outcome.ok ? "status" : "alert"} data-testid={testId}>
      {outcome.message}
    </p>
  );
}

/** A value shown read only: the number and its unit, as text, with the plain provenance chip. */
function ReadValue({ label, value, unit, provenance, testId }: { label: string; value: string; unit?: string; provenance?: string; testId?: string }) {
  return (
    <FieldRow label={label} chip={<ProvenanceChip provenance={provenance} />} chipInline>
      <span className={styles.readValue} data-testid={testId}>
        {value}
        {unit === undefined || unit === "" ? null : <span className="unit">{unit}</span>}
      </span>
    </FieldRow>
  );
}

/* ---- Robot ------------------------------------------------------------------------------------ */

const SIDE_WORD: Readonly<Record<string, string>> = { FRONT: "Front", BACK: "Back", LEFT: "Left side", RIGHT: "Right side" };

/**
 * The robot file the Robot section has unsaved changes to, or null when it has none: what the
 * window's close hint reads (issue #313). It decides as `RobotPane` does, so the two never disagree.
 */
export function useRobotUnsaved(): string | null {
  const { project, backend, host } = useEditor();
  const stored = useDraft();
  if (project === null || backend === null) return null;
  const key = robotDraftKey(project);
  if (stored === null || stored.key !== key) return null;
  if (robotReadOnlyReason(project, host, backend.writeRobot !== undefined) !== null) return null;
  return sameRobot(withCurrentCommands(stored.robot, project.robot), project.robot) ? null : project.link.robot;
}

/**
 * Saves the unsaved Robot draft, for the ask when Settings is closed with one (issue #414). The
 * draft goes only when the write worked; otherwise the reason comes back and the draft stays.
 */
export async function saveRobotDraft(): Promise<WriteOutcome> {
  const { project } = getState();
  // Only a draft made in this project: another project's edits are never written here.
  if (project === null || draft === null || draft.key !== robotDraftKey(project)) return { ok: true, message: "" };
  const written = withCurrentCommands(draft.robot, project.robot);
  const result = await saveProjectRobot(written);
  if (result.ok) setDraft(draftAfterSave(draft, written));
  return result;
}

/** Lets the unsaved Robot draft go. */
export const discardRobotDraft = (): void => {
  setDraft(null);
};

/** A Robot row's `data-setting`, so a button elsewhere in Settings can open Robot at it. */
const CLEARANCE_ROW = { "data-setting": ROBOT_CLEARANCE } as const;

export function RobotPane() {
  const { project, backend, host } = useEditor();
  const ledger = useFeature("ledger");
  const optimizer = useFeature("optimizer");
  const stored = useDraft();
  const asking = useCloseAsk();
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the values that are placeholders or still need measuring (issue #414): the ids of those rows
  // when the person chose Only these, kept as they were, so a row they settle stays in view.
  const [todoIds, setTodoIds] = useState<ReadonlySet<string> | null>(null);
  const key = project === null ? null : robotDraftKey(project);
  // Another project is another file: an old result would describe the wrong one.
  useEffect(() => {
    setOutcome(null);
  }, [key]);

  if (project === null || backend === null || key === null) return <NoProject what="its robot" />;

  const why = robotReadOnlyReason(project, host, backend.writeRobot !== undefined);
  const saved = project.robot;
  const robot = stored !== null && stored.key === key && why === null ? withCurrentCommands(stored.robot, saved) : saved;
  const dirty = !sameRobot(robot, saved);
  const problem = dirty ? robotProblem(robot) : null;

  const edit = (next: Robot): void => {
    setOutcome(null);
    setDraft(sameRobot(next, saved) ? null : { key, robot: next });
  };

  const save = (): void => {
    if (busy || !dirty || problem !== null) return;
    setBusy(true);
    void saveProjectRobot(robot).then((result) => {
      setOutcome(result);
      setBusy(false);
      // An edit made while the save was on its way stays as the draft (`draftAfterSave`).
      if (result.ok) setDraft(draftAfterSave(draft, robot));
    });
  };

  const number = (entry: RobotNumber, testPrefix = "settings-robot") => {
    const value = numberOf(robot, entry);
    const shown = value === null ? null : entry.unit.toShown(value);
    const provenance = provenanceOf(robot, entry);
    const testId = `${testPrefix}-${entry.id}`;
    if (why !== null) {
      return (
        <ReadValue
          key={entry.id}
          label={entry.label}
          value={shown === null ? "Not set" : shown.toFixed(entry.digits)}
          unit={shown === null ? undefined : entry.unit.label}
          provenance={shown === null ? undefined : provenance}
          testId={testId}
        />
      );
    }
    return (
      <NumberField<number | null>
        key={entry.id}
        label={entry.label}
        value={shown}
        unit={entry.unit.label === "" ? undefined : entry.unit.label}
        digits={entry.digits}
        step={entry.step}
        {...(entry.min === undefined ? {} : { min: entry.min })}
        {...(entry.max === undefined ? {} : { max: entry.max })}
        nullable={entry.optional === true}
        placeholder={entry.optional === true ? "not set" : undefined}
        hint={entry.hint}
        testId={testId}
        chipInline
        onChange={(next) => {
          edit(setRobotNumber(robot, entry, next));
        }}
        chip={
          value === null ? undefined : (
            <ProvenancePicker
              provenance={provenance}
              hint={KEPT_PROVENANCE_HINT}
              testId={`${testId}-provenance`}
              onChange={(next) => {
                edit(setRobotProvenance(robot, entry, next));
              }}
            />
          )
        }
      />
    );
  };

  /**
   * The clearance from field elements (D8). While robot.json leaves it out the row says Zenith's
   * default is in force and offers Change, which puts the key in the draft SET BY HAND; from then on
   * it is an ordinary number with its provenance chip, and clearing it goes back to the default.
   * The wrapper is where the Editor's Safety margin row sends the person (`openRobotClearance`).
   */
  const clearance = () => {
    const row = clearanceRow(robot, optimizer);
    if (robot.footprint.clearanceIn !== undefined) {
      return (
        <div key={row.id} {...CLEARANCE_ROW}>
          {number(row)}
        </div>
      );
    }
    return (
      <div key={row.id} {...CLEARANCE_ROW}>
        <FieldRow
          label={row.label}
          hint={row.hint}
          chipInline
          chip={
            why === null ? (
              <Button
                testId="settings-robot-clearance-set"
                onClick={() => {
                  edit(setClearance(robot));
                }}
              >
                Change
              </Button>
            ) : undefined
          }
          testId="settings-robot-clearance-row"
        >
          <span className={styles.readValue} data-testid="settings-robot-clearance-default">
            {clearanceSummary(robot)}
          </span>
        </FieldRow>
      </div>
    );
  };

  const follower = robot.kinematics.follower;
  const mouths = robot.mouths ?? [];

  // What is left to settle: the values that are placeholders or still need measuring, counted over
  // the numbers this pane lists (issue #414). A toggle narrows the pane to just those rows.
  const clearanceSet = robot.footprint.clearanceIn !== undefined;
  const pieces = [...(ledger && robot.capacity !== undefined ? [CAPACITY] : []), ...(robot.shooter === undefined ? [] : [SHOOTER_SETTLE])];
  const listed = [...ROBOT_GROUPS.flatMap((group) => group.numbers), ...(clearanceSet ? [CLEARANCE] : []), ...pieces];
  const todoLine = unsettledLine(unsettledCounts(robot, listed));
  const unsettled = (entry: RobotNumber): boolean => numberOf(robot, entry) !== null && settledOf(provenanceOf(robot, entry)) !== "settled";
  // Once nothing is left to settle the filter ends, so a placeholder added later shows every row.
  if (todoIds !== null && todoLine === null) setTodoIds(null);
  const filtering = todoIds !== null && todoLine !== null;
  const keep = (entry: RobotNumber): boolean => todoIds === null || !filtering || todoIds.has(entry.id);

  return (
    <>
      {why === null || project.source.kind === "example" ? null : (
        <ReadOnlyNote why={why} testId="settings-robot-read-only" />
      )}
      {todoLine === null ? null : (
        <div className={styles.todoLine} data-testid="settings-robot-todo">
          <span data-testid="settings-robot-todo-text">{todoLine}</span>
          <Segmented<"all" | "todo">
            label="Rows shown"
            options={[
              { value: "all", label: "All rows", does: "Show every value." },
              { value: "todo", label: "Only these", does: "Show only the values that are placeholders or need measuring." },
            ]}
            value={filtering ? "todo" : "all"}
            onChange={(value) => {
              setTodoIds(value === "todo" ? new Set(listed.filter(unsettled).map((entry) => entry.id)) : null);
            }}
            testId="settings-robot-todo-filter"
          />
        </div>
      )}
      {filtering ? null : (
      <Group title="Robot" aside={<span className={styles.mono}>{project.link.robot}</span>} testId="settings-robot-identity">
        <div className={styles.fields}>
          {why === null ? (
            <TextField
              label="Name"
              value={robot.name}
              mono={false}
              testId="settings-robot-name"
              hint="What this robot is called in the editor and in shared autos."
              onChange={(name) => {
                if (name.trim() !== "") edit({ ...robot, name: name.trim() });
              }}
            />
          ) : (
            <FieldRow label="Name">
              <span className={styles.readValue}>{robot.name}</span>
            </FieldRow>
          )}
        </div>
      </Group>
      )}
      {ROBOT_GROUPS.map((group) => {
        const numbers = group.numbers.filter(keep);
        const withClearance = group.id === "footprint" && (!filtering || (clearanceSet && keep(CLEARANCE)));
        if (numbers.length === 0 && !withClearance) return null;
        return (
          <Group key={group.id} title={group.title} testId={`settings-robot-${group.id}`}>
            <div className={styles.fields}>
              {numbers.map((entry) => number(entry))}
              {withClearance ? clearance() : null}
            </div>
          </Group>
        );
      })}
      {filtering ? null : (
      <Group title="Follower" testId="settings-robot-follower">
        <CodeRows />
        <div className={styles.fields}>
          {why === null ? (
            <>
              <TextField
                // Named for its library: a bare "Version" under Pathing read as Zenith's own (0.1.2 UX sweep, W1-16).
                label="Pedro Pathing version"
                value={follower.version}
                testId="settings-robot-follower-version"
                hint="The Pedro Pathing version the robot code builds against."
                onChange={(version) => {
                  if (version.trim() !== "") edit({ ...robot, kinematics: { ...robot.kinematics, follower: { ...follower, version: version.trim() } } });
                }}
              />
              <CheckboxField
                label="Hold the end of each path"
                checked={follower.holdEnd}
                onChange={(holdEnd) => {
                  edit({ ...robot, kinematics: { ...robot.kinematics, follower: { ...follower, holdEnd } } });
                }}
              />
            </>
          ) : (
            <>
              <FieldRow label="Pedro Pathing version" testId="settings-robot-follower-version-read">
                <span className={styles.readValue}>{follower.version}</span>
              </FieldRow>
              <FieldRow label="Hold the end of each path">
                <span className={styles.readValue}>{follower.holdEnd ? "Yes" : "No"}</span>
              </FieldRow>
            </>
          )}
        </div>
      </Group>
      )}
      {filtering || mouths.length === 0 ? null : (
        <Group title="Intakes" testId="settings-robot-mouths">
          {mouths.map((mouth, index) => (
            <div key={mouth.id} className={styles.fields} data-testid={`settings-robot-mouth-${mouth.id}`}>
              <FieldRow
                label={`Intake ${mouth.id}`}
                chipInline
                chip={
                  why === null ? (
                    <ProvenancePicker
                      provenance={mouth.provenance}
                      hint={KEPT_PROVENANCE_HINT}
                      testId={`settings-robot-mouth-${mouth.id}-provenance`}
                      onChange={(next) => {
                        edit(setMouthProvenance(robot, index, next));
                      }}
                    />
                  ) : (
                    <ProvenanceChip provenance={mouth.provenance} />
                  )
                }
              >
                <span className={styles.readValue}>{SIDE_WORD[mouth.side]}</span>
              </FieldRow>
              {MOUTH_NUMBERS.map((entry) =>
                why === null ? (
                  <NumberField
                    key={entry.key}
                    label={entry.label}
                    value={mouthNumber(mouth, entry.key)}
                    unit="in"
                    digits={1}
                    step={0.5}
                    {...(entry.key === "widthIn" || entry.key === "depthIn" ? { min: 0.1 } : {})}
                    hint={entry.hint}
                    testId={`settings-robot-mouth-${mouth.id}-${entry.key}`}
                    onChange={(value) => {
                      edit(setMouthNumber(robot, index, entry.key, value));
                    }}
                  />
                ) : (
                  <FieldRow key={entry.key} label={entry.label}>
                    <span className={styles.readValue}>
                      {mouthNumber(mouth, entry.key).toFixed(1)}
                      <span className="unit">in</span>
                    </span>
                  </FieldRow>
                ),
              )}
            </div>
          ))}
        </Group>
      )}
      {pieces.filter(keep).length === 0 ? null : (
        <Group title="Game pieces" testId="settings-robot-pieces">
          <div className={styles.fields}>{pieces.filter(keep).map((entry) => number(entry))}</div>
        </Group>
      )}
      {why !== null || asking || (!dirty && outcome === null) ? null : (
        <div className={styles.saveBar} data-testid="settings-robot-save-bar">
          <div className={styles.saveText}>
            {dirty ? (
              problem === null ? (
                <p className={styles.note}>Unsaved changes to {project.link.robot}.</p>
              ) : (
                <p className={styles.error} role="alert" data-testid="settings-robot-problem">
                  {problem}
                </p>
              )
            ) : null}
            <Outcome outcome={outcome} testId="settings-robot-result" />
          </div>
          {dirty ? (
            <div className={styles.inline}>
              <Button
                testId="settings-robot-discard"
                onClick={() => {
                  setOutcome(null);
                  setDraft(null);
                }}
              >
                Discard changes
              </Button>
              <Button kind="primary" testId="settings-robot-save" whyDisabled={busy ? "Saving robot.json now." : problem} onClick={save}>
                {busy ? "Saving…" : "Save robot.json"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

/* ---- Commands --------------------------------------------------------------------------------- */

/** Which command the form is open for: a new one, or the one with this name. */
type Editing = { kind: "new" } | { kind: "edit"; name: string } | null;

export function CommandsPane() {
  const state = useEditor();
  const { project, backend, host } = state;
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const key = project === null ? null : robotDraftKey(project);
  useEffect(() => {
    setOutcome(null);
    setEditing(null);
    setRemoving(null);
  }, [key]);

  if (project === null || backend === null) return <NoProject what="its robot's commands" />;

  const why = robotReadOnlyReason(project, host, backend.writeRobot !== undefined);
  const robot = project.robot;
  const commands = robot.commands;
  const importWhy = importCommandsBlockedReason(state);

  const write = (next: Robot, what: string, then?: () => void): void => {
    if (busy) return;
    setBusy(true);
    void saveProjectRobot(next, what).then((result) => {
      setOutcome(result);
      setBusy(false);
      if (result.ok) then?.();
    });
  };

  return (
    <>
      {why === null || project.source.kind === "example" ? null : (
        <ReadOnlyNote why={why} testId="settings-commands-read-only" />
      )}
      <Group
        title={`${String(commands.length)} ${commands.length === 1 ? "command" : "commands"}`}
        aside={<span className={styles.mono}>{project.link.robot}</span>}
        testId="settings-commands-list"
      >
        <div className={styles.toolbar}>
          <SheetButton
            tooltip="Import commands from Java"
            hint="Read the NamedCommands registrations in your robot code and add the ones robot.json is missing. You see the change before anything is written."
            whyDisabled={importWhy}
            onClick={() => {
              closeSettings();
              setDialog("importCommands");
            }}
            testId="settings-commands-import"
          >
            Import from Java…
          </SheetButton>
          {why !== null || editing !== null || removing !== null ? null : (
            <SheetButton
              kind="primary"
              tooltip="Add a command"
              hint="Add a command your robot code registers, with its arguments and how long it takes."
              onClick={() => {
                setOutcome(null);
                setRemoving(null);
                setEditing({ kind: "new" });
              }}
              testId="settings-commands-add"
            >
              Add command
            </SheetButton>
          )}
        </div>
        <Outcome outcome={outcome} testId="settings-commands-result" />
        {editing?.kind === "new" ? (
          <CommandForm
            initial={EMPTY_COMMAND}
            others={commands.map((command) => command.name)}
            busy={busy}
            onCancel={() => {
              setEditing(null);
            }}
            onSave={(command) => {
              write(addCommand(robot, command), `${command.name} in robot.json`, () => {
                setEditing(null);
              });
            }}
          />
        ) : null}
        {commands.length === 0 ? (
          <Row label="No commands yet" description="Add one here, or import them from your robot code's NamedCommands registrations." testId="settings-commands-empty" />
        ) : null}
        {commands.map((command) =>
          editing?.kind === "edit" && editing.name === command.name ? (
            <CommandForm
              key={command.name}
              initial={draftOf(command)}
              previous={command}
              others={commands.filter((other) => other.name !== command.name).map((other) => other.name)}
              busy={busy}
              onCancel={() => {
                setEditing(null);
              }}
              onSave={(next) => {
                write(replaceCommand(robot, command.name, next), `${next.name} in robot.json`, () => {
                  setEditing(null);
                });
              }}
            />
          ) : (
            <CommandRow
              key={command.name}
              command={command}
              readOnly={why !== null}
              removing={removing === command.name}
              busy={busy}
              onEdit={() => {
                setOutcome(null);
                setRemoving(null);
                setEditing({ kind: "edit", name: command.name });
              }}
              onRemove={() => {
                setOutcome(null);
                setRemoving(command.name);
              }}
              onKeep={() => {
                setRemoving(null);
              }}
              onConfirmRemove={() => {
                write(removeCommand(robot, command.name), `the removal of ${command.name} from robot.json`, () => {
                  setRemoving(null);
                });
              }}
            />
          ),
        )}
      </Group>
    </>
  );
}

function CommandRow({
  command,
  readOnly,
  removing,
  busy,
  onEdit,
  onRemove,
  onKeep,
  onConfirmRemove,
}: {
  command: CommandSpec;
  readOnly: boolean;
  removing: boolean;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onKeep: () => void;
  onConfirmRemove: () => void;
}) {
  const full = useDescriptions() === "full";
  useEscapeFirst(removing, onKeep);
  const params = Object.entries(command.params ?? {});
  const facts = [
    describeEstimate(command.estimateS),
    command.requires === undefined || command.requires.length === 0 ? null : `uses ${command.requires.join(", ")}`,
    command.stationary === true ? "robot stands still" : null,
    command.movesRobot === true ? "drives the robot itself" : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className={styles.row} data-testid={`settings-command-${command.name}`}>
      <div className={styles.rowText}>
        {/* The summary is the hint on a long hover; With descriptions adds its first sentence. */}
        {command.summary === undefined ? (
          <span className={`${styles.rowLabel} ${styles.commandName}`}>{command.name}</span>
        ) : (
          <Tooltip label={command.name} hint={command.summary} delay="long">
            <span className={`${styles.rowLabel} ${styles.commandName}`}>{command.name}</span>
          </Tooltip>
        )}
        {command.summary === undefined || !full ? null : (
          <span className={styles.rowDescription} data-testid={`settings-command-${command.name}-summary`}>
            {firstSentence(command.summary)}
          </span>
        )}
        {params.length === 0 ? (
          <span className={styles.rowMeta}>No arguments</span>
        ) : (
          <ul className={styles.params} data-testid={`settings-command-${command.name}-params`}>
            {params.map(([name, param]) => (
              <li key={name} className={styles.rowMeta}>
                {describeParam(name, param)}
              </li>
            ))}
          </ul>
        )}
        <span className={styles.rowMeta}>{facts.join(" · ")}</span>
      </div>
      {readOnly ? null : (
        <div className={styles.rowControl}>
          <SheetButton tooltip={`Edit ${command.name}`} hint="Change its name, arguments, time or flags." onClick={onEdit} testId={`settings-command-${command.name}-edit`}>
            Edit
          </SheetButton>
          <SheetButton
            tooltip={`Remove ${command.name}`}
            hint="Take it out of robot.json. You confirm first."
            onClick={onRemove}
            testId={`settings-command-${command.name}-remove`}
          >
            Remove
          </SheetButton>
        </div>
      )}
      {removing ? (
        <div className={styles.rowBelow}>
          <ConfirmRow
            testId={`settings-command-${command.name}-remove-ask`}
            confirmTestId={`settings-command-${command.name}-confirm-remove`}
            cancelTestId={`settings-command-${command.name}-keep`}
            sentence={`Remove ${command.name}? Autos that use it will show an error until it is added back.`}
            verb="Remove"
            whyDisabled={busy ? "Saving robot.json now." : null}
            onConfirm={onConfirmRemove}
            onCancel={onKeep}
          />
        </div>
      ) : null}
    </div>
  );
}

const PARAM_LABEL: Readonly<Record<ParamType, string>> = {
  integer: "Whole number",
  number: "Number",
  enum: "One of a list",
  boolean: "True or false",
  string: "Text",
};

function CommandForm({
  initial,
  previous,
  others,
  busy,
  onSave,
  onCancel,
}: {
  initial: CommandDraft;
  previous?: CommandSpec;
  others: readonly string[];
  busy: boolean;
  onSave: (command: CommandSpec) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CommandDraft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  // Esc gives up the form and nothing else: the window stays (issue #414).
  useEscapeFirst(true, onCancel);
  const patch = (next: Partial<CommandDraft>): void => {
    setProblem(null);
    setForm((current) => ({ ...current, ...next }));
  };
  const patchParam = (index: number, next: Partial<ParamDraft>): void => {
    setProblem(null);
    setForm((current) => ({ ...current, params: current.params.map((param, at) => (at === index ? { ...param, ...next } : param)) }));
  };
  const submit = (): void => {
    const built = commandFromDraft(form, others, previous);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    onSave(built.command);
  };
  const testId = previous === undefined ? "settings-command-form-new" : `settings-command-form-${previous.name}`;

  return (
    <div className={styles.form} data-testid={testId} role="group" aria-label={previous === undefined ? "New command" : `Edit ${previous.name}`}>
      <div className={styles.fields}>
        <TextField
          label="Name"
          value={form.name}
          testId="settings-command-name"
          hint="The name the robot code registers it under with NamedCommands."
          onChange={(name) => {
            patch({ name });
          }}
        />
        <TextField
          label="What it does"
          value={form.summary}
          mono={false}
          testId="settings-command-summary"
          hint="One sentence for the insert menu and the inspector."
          onChange={(summary) => {
            patch({ summary });
          }}
        />
        <TextField
          label="Time"
          value={form.estimateS}
          testId="settings-command-estimate"
          hint='Seconds it takes: a number, an expression over the arguments such as "0.5 + count * 0.5", or "unknown".'
          onChange={(estimateS) => {
            patch({ estimateS });
          }}
        />
        <TextField
          label="Uses"
          value={form.requires}
          testId="settings-command-requires"
          hint="The subsystems it needs, separated by commas, such as intake, launcher."
          onChange={(requires) => {
            patch({ requires });
          }}
        />
        <CheckboxField
          label="Robot stands still while it runs"
          checked={form.stationary}
          onChange={(stationary) => {
            patch({ stationary });
          }}
        />
        <CheckboxField
          label="Drives the robot itself"
          checked={form.movesRobot}
          onChange={(movesRobot) => {
            patch({ movesRobot });
          }}
        />
      </div>
      <div className={styles.formHead}>
        <span className={styles.rowLabel}>Arguments</span>
        <SheetButton
          kind="text"
          tooltip="Add an argument"
          hint="A value the auto passes to this command, such as how many pieces to score."
          onClick={() => {
            patch({ params: [...form.params, EMPTY_PARAM] });
          }}
          testId="settings-command-add-param"
        >
          Add argument
        </SheetButton>
      </div>
      {form.params.length === 0 ? <p className={styles.note}>No arguments.</p> : null}
      {form.params.map((param, index) => (
        <div key={index} className={styles.param} data-testid={`settings-command-param-${String(index)}`}>
          <div className={styles.fields}>
            <TextField
              label="Argument name"
              value={param.name}
              testId={`settings-command-param-${String(index)}-name`}
              onChange={(name) => {
                patchParam(index, { name });
              }}
            />
            <SelectField<ParamType>
              label="Kind"
              value={param.type}
              options={PARAM_TYPES.map((type) => ({ value: type, label: PARAM_LABEL[type] }))}
              testId={`settings-command-param-${String(index)}-type`}
              onChange={(type) => {
                patchParam(index, { type });
              }}
            />
            {param.type === "integer" || param.type === "number" ? (
              <>
                <TextField
                  label="Lowest"
                  value={param.min}
                  testId={`settings-command-param-${String(index)}-min`}
                  onChange={(min) => {
                    patchParam(index, { min });
                  }}
                />
                <TextField
                  label="Highest"
                  value={param.max}
                  testId={`settings-command-param-${String(index)}-max`}
                  onChange={(max) => {
                    patchParam(index, { max });
                  }}
                />
              </>
            ) : null}
            {param.type === "enum" ? (
              <TextField
                label="Values"
                value={param.values}
                testId={`settings-command-param-${String(index)}-values`}
                hint="The values it accepts, separated by commas."
                onChange={(values) => {
                  patchParam(index, { values });
                }}
              />
            ) : null}
            <TextField
              label="Default"
              value={param.default}
              testId={`settings-command-param-${String(index)}-default`}
              hint="What an auto that leaves it out passes. Leave it empty for no default."
              onChange={(value) => {
                patchParam(index, { default: value });
              }}
            />
          </div>
          <SheetButton
            kind="text"
            tooltip="Remove this argument"
            onClick={() => {
              setProblem(null);
              setForm((current) => ({ ...current, params: current.params.filter((_, at) => at !== index) }));
            }}
            testId={`settings-command-param-${String(index)}-remove`}
          >
            Remove argument
          </SheetButton>
        </div>
      ))}
      {problem === null ? null : (
        <p className={styles.error} role="alert" data-testid="settings-command-problem">
          {problem}
        </p>
      )}
      <div className={styles.formActions}>
        <Button onClick={onCancel} testId="settings-command-cancel">
          Cancel
        </Button>
        <Button kind="primary" whyDisabled={busy ? "Saving robot.json now." : null} onClick={submit} testId="settings-command-save">
          {busy ? "Saving…" : previous === undefined ? "Add command" : "Save command"}
        </Button>
      </div>
    </div>
  );
}
