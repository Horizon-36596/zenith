/**
 * The proposer's editor (spec 13 section 14): a partner's propose-level
 * share drawn editable on the field, with every edit kept as a proposal change and never as an edit
 * of the user's own auto. It is the editor's frame with its panels swapped, like the pull-request
 * review: the partner's steps and the proposed changes on the left, the same canvas in the middle
 * with the user's own robot beside the partner's, the proposal's and the alliance's findings under
 * it, and a small inspector for the selected partner step on the right.
 *
 * Commands show by their real names and arguments when the share includes command names, and
 * otherwise only as their tokens (`cmd3`, 2.5 s, stationary): that is all the share holds.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  GitPullRequestArrow,
  Hourglass,
  Redo2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { mirrorAllianceRobot, type Finding } from "@horizon36596/zenith-core";
import type { Heading, ProjectionStep, ProposalChange } from "@horizon36596/zenith-schema";
import { FieldCanvas } from "../canvas/FieldCanvas";
import type { PointTarget, Selection } from "../canvas/types";
import { FieldRow, INSPECTOR_GRID, NumberField, Section, SelectField, TextField } from "../components/fields";
import { Panel, RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { buildPartnerScene, type AlignedPartner, type AllianceFrame, type PartnerEntry } from "../alliance/model";
import { useAllianceState } from "../alliance/store";
import { allianceFrameFor, ownRobotFor } from "../alliance/useAlliance";
import { KIND_ICON, KIND_LABEL } from "../lib/stepKinds";
import { defaultEnvelopeFor } from "../lib/envelope";
import { commandNamer } from "../cloud/projectionModel";
import { teamInSentence } from "../cloud/words";
import { stepWords } from "./stepWords";
import { useDerived, useEditor } from "../state/store";
import appStyles from "../app/App.module.css";
import { changedStepIds, proposedEnvelope } from "./draft";
import {
  dropChange,
  askLeaveProposal,
  proposeComment,
  proposeEnvelope,
  proposeHeading,
  proposeInsertWait,
  proposeMarker,
  proposeMovePose,
  proposeMovePoses,
  proposeRemove,
  proposeReorder,
  proposerModelFor,
  proposeSpeed,
  proposeTimeout,
  proposeWaitSeconds,
  saveBlockedReason,
  saveProposal,
  sendChoiceFor,
  sendProposal,
} from "./proposerActions";
import { previewAllianceFindings, previewFrameFor, type ProposerModel } from "./proposerModel";
import {
  beginDrag,
  endDrag,
  redoChange,
  setProposerPlayback,
  setProposerPlaying,
  setProposerSelection,
  setShareRef,
  undoChange,
  useProposerSession,
  type ProposerSession,
} from "./proposerStore";
import { headingToProjection, slotsOfStructure } from "./synthetic";
import { robotTrace } from "./timing";
import { FindingGroup, Scrubber, TextAction, useKeyGuard } from "./parts";
import styles from "./proposals.module.css";

const DEG = 180 / Math.PI;

export function ProposalEditView() {
  const session = useProposerSession();
  const editor = useEditor();
  const derived = useDerived();
  const alliance = useAllianceState();
  const model = session === null ? null : proposerModelFor(session, editor);
  const ownPlan = derived.plan;

  const handleKey = useCallback((event: KeyboardEvent): boolean => {
    const chord = event.ctrlKey || event.metaKey;
    if (chord && (event.key === "z" || event.key === "Z") && !event.shiftKey) {
      undoChange();
      return true;
    }
    if (chord && (event.key === "y" || event.key === "Y" || ((event.key === "z" || event.key === "Z") && event.shiftKey))) {
      redoChange();
      return true;
    }
    return false;
  }, []);
  useKeyGuard(handleKey);
  // One frame per plan, so the season hooks it binds keep their identity and the findings memo holds.
  const frame = useMemo(() => (ownPlan === null ? null : allianceFrameFor(ownPlan)), [ownPlan]);

  if (session === null) return null;
  const partnerEntry = alliance.partners.find((partner) => partner.id === session.partnerId) ?? null;
  const partnerOffsetS = partnerEntry?.offsetS ?? 0;
  const own = ownPlan === null ? null : ownRobotFor(ownPlan);

  return (
    <>
      <Banner session={session} model={model} />
      <div className={appStyles.body}>
        <aside className={appStyles.left} style={{ width: `${String(editor.prefs.panelLeftW)}px` }} data-region tabIndex={-1} aria-label="Partner steps and proposed changes">
          <div className={appStyles.leftSteps}>
            <Panel label="Partner steps" title="Partner steps" help="suggest" testId="proposal-steps">
              {model === null ? <p className={styles.empty}>Open a project first.</p> : <StepList session={session} model={model} />}
            </Panel>
          </div>
          <div className={appStyles.leftLedger}>
            <Panel label="Proposed changes" title="Proposed changes" help="proposal" testId="proposal-changes">
              {model === null ? null : <ChangeList model={model} />}
            </Panel>
          </div>
        </aside>

        <main className={appStyles.centre}>
          <div className={appStyles.canvas} data-region tabIndex={-1} aria-label="Field canvas, the partner's routine">
            {model === null || model.derived.plan === null || model.derived.resolved === null ? (
              <p className={styles.empty}>{model?.derived.findingsReason ?? "The partner's routine cannot be drawn."}</p>
            ) : (
              <ProposalCanvas
                session={session}
                model={model}
                ownRobot={own?.ok === true ? own.robot : null}
                ownAlliance={ownPlan?.auto.alliance ?? session.projection.alliance}
                mirror={frame?.mirror ?? "none"}
                ownOffsetS={alliance.ownOffsetS}
                partnerOffsetS={partnerOffsetS}
                partnerColour={partnerEntry?.colour ?? 0}
              />
            )}
          </div>
          {model === null ? null : (
            <Scrubber
              testId="proposal"
              playbackS={session.playbackS}
              playing={session.playing}
              onPlayback={setProposerPlayback}
              onPlaying={setProposerPlaying}
              runS={Math.max(
                model.partner.robot.totalS + partnerOffsetS,
                own?.ok === true ? own.robot.totalS + alliance.ownOffsetS : 0,
              )}
            />
          )}
          <section className={styles.bottom} data-region tabIndex={-1} aria-label="Proposal and alliance findings">
            {model === null ? null : (
              <Findings
                model={model}
                session={session}
                own={own?.ok === true ? own.robot : null}
                ownAlliance={ownPlan?.auto.alliance ?? session.projection.alliance}
                frame={frame}
                ownOffsetS={alliance.ownOffsetS}
                partnerOffsetS={partnerOffsetS}
              />
            )}
          </section>
        </main>

        <aside className={appStyles.right} style={{ width: `${String(editor.prefs.panelRightW)}px` }} data-region tabIndex={-1} aria-label="Partner step">
          <Panel label="Partner step" title="Partner step" help="partnerstep" testId="proposal-inspector">
            {model === null ? null : <StepInspector session={session} model={model} />}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function Banner({ session, model }: { session: ProposerSession; model: ProposerModel | null }) {
  const blocked = saveBlockedReason(model, session);
  const choice = sendChoiceFor(session);
  const problems = model?.findings.length ?? 0;
  return (
    <div className={styles.banner} data-testid="proposal-banner">
      <GitPullRequestArrow size={16} strokeWidth={1.75} aria-hidden />
      <span className={styles.bannerTitle}>Suggesting changes to {session.label}</span>
      <span className={styles.mono} data-testid="proposal-share-ref">
        {session.share === undefined ? "local reference " : "share "}
        {session.shareRef.shareId} · revision {session.shareRef.revision}
      </span>
      <span className={styles.mono} data-testid="proposal-counts">
        {session.changes.length} {session.changes.length === 1 ? "change" : "changes"} · {problems}{" "}
        {problems === 1 ? "problem" : "problems"}
      </span>
      <span className={styles.spacer} />
      <RowButton
        icon={Undo2}
        label="Undo the last proposal edit"
        shortcut="Ctrl Z"
        hint="Takes back the last change to the proposal. Your own auto is not affected."
        disabled={session.undo.length === 0}
        whyDisabled="Nothing to undo in this proposal."
        onClick={undoChange}
        testId="proposal-undo"
      />
      <RowButton
        icon={Redo2}
        label="Redo"
        shortcut="Ctrl Y"
        hint="Puts back the proposal edit you undid."
        disabled={session.redo.length === 0}
        whyDisabled="Nothing to redo in this proposal."
        onClick={redoChange}
        testId="proposal-redo"
      />
      {session.share === undefined ? null : (
        <TextAction
          kind="primary"
          label={`Send to ${teamInSentence(session.share.fromTeam)}`}
          hint={`Sends the proposal to the share ${teamInSentence(session.share.fromTeam)} made, for their Sharing page. Offline, it waits in the Outbox until the connection returns.`}
          disabledReason={blocked ?? (choice.ok ? null : choice.why)}
          onClick={() => void sendProposal()}
          testId="proposal-send"
        >
          Send to the share
        </TextAction>
      )}
      <TextAction
        kind={session.share === undefined ? "primary" : "secondary"}
        label="Save proposal"
        hint="Downloads the proposal file. Send it to the team that shared the auto; they open it with Open proposal."
        disabledReason={blocked}
        onClick={() => void saveProposal()}
        testId="proposal-save"
      >
        Save proposal…
      </TextAction>
      <TextAction
        label="Leave the proposal"
        hint="Back to your own auto. Asks first when there are changes not saved or sent."
        onClick={() => void askLeaveProposal()}
        testId="proposal-leave"
      >
        Leave
      </TextAction>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The partner's steps.
// ---------------------------------------------------------------------------------------------

function StepList({ session, model }: { session: ProposerSession; model: ProposerModel }) {
  const slots = useMemo(() => [...slotsOfStructure(model.preview).values()], [model.preview]);
  const name = useMemo(() => commandNamer(session.projection), [session.projection]);
  const added = new Set(model.context.addedIds.values());
  const changed = changedStepIds(session.changes);
  const removable = (step: ProjectionStep): string | null =>
    step.kind === "path" || step.kind === "wait" ? null : "A proposal may only remove path and wait steps; commands and groups stay.";
  return (
    <div className={styles.list} role="list" data-testid="proposal-step-list">
      {slots.map((slot) => {
        const node = slot.node;
        const Icon = KIND_ICON[node.kind];
        const isAdded = added.has(node.id);
        const selected = session.selection.stepId === node.id;
        const reorderWhy = isAdded ? "This wait was added by the proposal: remove it and insert it again where you want it." : null;
        return (
          <div
            key={node.id}
            role="listitem"
            className={styles.stepRow}
            aria-selected={selected}
            style={{ paddingLeft: `calc(var(--pad-row-x) + ${String(slot.depth * 16)}px)` }}
            data-testid={`proposal-step-${node.id}`}
            onClick={() => {
              setProposerSelection({ stepId: node.id });
            }}
          >
            <Icon className={styles.stepIcon} size={16} strokeWidth={1.75} aria-hidden />
            <span className={styles.stepName}>
              <button
                type="button"
                className={styles.stepId}
                aria-label={`Select ${node.id}, a ${KIND_LABEL[node.kind].toLowerCase()}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setProposerSelection({ stepId: node.id });
                }}
              >
                {node.id}
              </button>
              <span className={styles.stepDetail}>{stepWords(node, name)}</span>
              {isAdded ? (
                <span className={styles.mark} data-mark="added">
                  added
                </span>
              ) : changed.has(node.id) ? (
                <span className={styles.mark} data-mark="changed">
                  changed
                </span>
              ) : null}
            </span>
            <span className={styles.stepActions}>
              <RowButton
                icon={ArrowUp}
                label={`Move ${node.id} up`}
                hint="Proposes running this step one place earlier in its list."
                disabled={reorderWhy !== null || slot.index === 0}
                whyDisabled={reorderWhy ?? "It is already first in its list."}
                onClick={() => {
                  proposeReorder(node.id, slot.index, slot.index - 1);
                }}
                testId={`proposal-up-${node.id}`}
              />
              <RowButton
                icon={ArrowDown}
                label={`Move ${node.id} down`}
                hint="Proposes running this step one place later in its list."
                disabled={reorderWhy !== null || slot.index >= slot.list.length - 1}
                whyDisabled={reorderWhy ?? "It is already last in its list."}
                onClick={() => {
                  proposeReorder(node.id, slot.index, slot.index + 1);
                }}
                testId={`proposal-down-${node.id}`}
              />
              <RowButton
                icon={Hourglass}
                label={`Insert a wait after ${node.id}`}
                hint="Proposes a 1 s wait straight after this step. Change its seconds in the inspector."
                disabled={isAdded}
                whyDisabled="Change this wait's seconds instead: a proposal can only place a new step after one of the share's own."
                onClick={() => {
                  proposeInsertWait(node.id);
                }}
                testId={`proposal-wait-${node.id}`}
              />
              <RowButton
                icon={Trash2}
                label={`Remove ${node.id}`}
                hint={isAdded ? "Takes the wait you added back out." : "Proposes taking this step out of the routine."}
                disabled={removable(node) !== null}
                whyDisabled={removable(node) ?? undefined}
                onClick={() => {
                  proposeRemove(node.id);
                  setProposerSelection({});
                }}
                testId={`proposal-remove-${node.id}`}
              />
            </span>
          </div>
        );
      })}
      <div className={styles.listFoot}>
        <TextAction
          label="Insert a wait at the start"
          hint="Proposes a 1 s wait before the partner's first step, so their robot starts later."
          onClick={() => {
            proposeInsertWait(null);
          }}
          testId="proposal-wait-start"
        >
          + Wait at the start
        </TextAction>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The changes.
// ---------------------------------------------------------------------------------------------

function targetOf(change: ProposalChange): string | undefined {
  if (change.op === "insertWait" || change.op === "addPath") return change.afterStepId;
  return change.stepId;
}

function ChangeList({ model }: { model: ProposerModel }) {
  if (model.rows.length === 0) {
    return (
      <p className={styles.empty} data-testid="proposal-no-changes">
        No changes yet.
      </p>
    );
  }
  return (
    <div className={styles.list} role="list" data-testid="proposal-change-list">
      {model.rows.map((row) => (
        <div key={row.index} role="listitem" className={styles.change} data-testid={`proposal-change-${String(row.index + 1)}`} data-valid={row.finding === null ? "true" : "false"}>
          <div className={styles.changeHead}>
            <span className={styles.changeNumber}>{row.index + 1}</span>
            <button
              type="button"
              className={styles.changeSummary}
              onClick={() => {
                const target = targetOf(row.change);
                if (target !== undefined) setProposerSelection({ stepId: target });
              }}
            >
              {row.summary}
            </button>
            <RowButton
              icon={X}
              label={`Take change ${String(row.index + 1)} out`}
              hint="Removes this change from the proposal."
              onClick={() => {
                dropChange(row.index);
              }}
              testId={`proposal-drop-${String(row.index + 1)}`}
            />
          </div>
          {row.finding === null ? null : (
            <span className={styles.changeWhy} data-testid="proposal-change-why">
              {row.finding.message}
            </span>
          )}
          <CommentInput index={row.index} value={row.change.comment ?? ""} />
        </div>
      ))}
    </div>
  );
}

function CommentInput({ index, value }: { index: number; value: string }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current !== null && document.activeElement !== ref.current) ref.current.value = value;
  }, [value]);
  return (
    <Tooltip label="One-line comment" hint="Says why, for the team that reads the proposal. At most 200 characters.">
      <span className={styles.commentWrap}>
      <input
        ref={ref}
        className={styles.comment}
        defaultValue={value}
        maxLength={200}
        placeholder="Add a one-line comment"
        aria-label={`Comment on change ${String(index + 1)}`}
        data-testid={`proposal-comment-${String(index + 1)}`}
        onBlur={(event) => {
          proposeComment(index, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------------------------
// The canvas.
// ---------------------------------------------------------------------------------------------

function ProposalCanvas({
  session,
  model,
  ownRobot,
  ownAlliance,
  mirror,
  ownOffsetS,
  partnerOffsetS,
  partnerColour,
}: {
  session: ProposerSession;
  model: ProposerModel;
  ownRobot: import("@horizon36596/zenith-core").AllianceRobot | null;
  ownAlliance: "RED" | "BLUE";
  mirror: import("@horizon36596/zenith-core").MirrorMode;
  ownOffsetS: number;
  partnerOffsetS: number;
  partnerColour: number;
}) {
  const editor = useEditor();
  const plan = model.derived.plan;
  const resolved = model.derived.resolved;
  const partnerAlliance = session.projection.alliance;
  const allianceS = session.playbackS;

  // The user's own robot, drawn like a partner, in the partner's frame (the canvas's file frame).
  const ownScene = useMemo(() => {
    if (ownRobot === null) return [];
    const aligned = ownAlliance === partnerAlliance ? ownRobot : mirrorAllianceRobot(ownRobot, mirror);
    const entry: PartnerEntry = {
      id: "own",
      fileName: "",
      projection: session.projection,
      label: "Your robot",
      colour: (partnerColour + 1) % 3,
      visible: true,
      offsetS: ownOffsetS,
    };
    const partner: AlignedPartner = { entry, robot: aligned, mirrored: aligned !== ownRobot };
    return buildPartnerScene([partner], allianceS);
  }, [ownRobot, ownAlliance, partnerAlliance, mirror, session.projection, partnerColour, ownOffsetS, allianceS]);

  const previewTrace = useMemo(() => robotTrace(model.partner.robot, model.partner.steps), [model.partner]);
  if (plan === null || resolved === null) return null;

  const selection: Selection = {
    ...(session.selection.stepId === undefined ? {} : { stepId: session.selection.stepId }),
    ...(session.selection.point === undefined ? {} : { point: session.selection.point }),
  };
  const envelopeOf = (stepId: string) => proposedEnvelope(session.changes, stepId);

  return (
    <FieldCanvas
      field={plan.field}
      robot={plan.robot}
      auto={plan.auto}
      resolved={resolved}
      plan={plan}
      basePlan={session.changes.length === 0 ? null : model.baseDerived.plan}
      estimate={model.derived.estimate}
      findings={[]}
      selection={selection}
      tool="select"
      alliance={ownAlliance}
      waypoints={null}
      snap={editor.prefs.snap}
      showGhosts={false}
      playbackS={Math.max(0, allianceS - partnerOffsetS)}
      partners={ownScene}
      playing={session.playing}
      onTogglePlay={() => {
        setProposerPlaying(!session.playing);
      }}
      previewTrace={previewTrace}
      playbackLevel="instant"
      trace={null}
      staticSvg={model.derived.staticSvg}
      fieldView={editor.prefs.fieldView}
      fieldImageVariant={editor.prefs.fieldStyle}
      fieldGrid={editor.prefs.fieldGrid}
      onSelect={(next: Selection) => {
        setProposerSelection({
          ...(next.stepId === undefined ? {} : { stepId: next.stepId }),
          ...(next.point === undefined ? {} : { point: next.point }),
        });
      }}
      onHover={() => undefined}
      onDragStart={beginDrag}
      onDragEnd={endDrag}
      onDragPose={(stepId: string, target: PointTarget, pose) => {
        proposeMovePose(stepId, target, pose);
      }}
      onDragPoses={(moves) => {
        proposeMovePoses(moves);
      }}
      onDragHeading={() => undefined}
      onSetHeading={(stepId: string, heading: Heading) => {
        proposeHeading(stepId, headingToProjection(heading));
      }}
      onAddPathPoint={() => undefined}
      onAddMarker={() => undefined}
      onDragMarker={(stepId: string, markerIndex: number, t: number) => {
        proposeMarker(stepId, markerIndex, { t });
      }}
      onSetEnvelopePolygon={(stepId, polygon) => {
        const envelope = envelopeOf(stepId);
        if (envelope === null) return;
        proposeEnvelope(stepId, { ...envelope, polygon: polygon.map((corner) => ({ xIn: corner.xIn, yIn: corner.yIn })) });
      }}
      onAddCommandAt={() => undefined}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// The scrubber.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The findings.
// ---------------------------------------------------------------------------------------------

function Findings({
  model,
  session,
  own,
  ownAlliance,
  frame,
  ownOffsetS,
  partnerOffsetS,
}: {
  model: ProposerModel;
  session: ProposerSession;
  own: import("@horizon36596/zenith-core").AllianceRobot | null;
  ownAlliance: "RED" | "BLUE";
  /** The alliance view's frame for the open plan: the field's mirror and the season's hooks. */
  frame: AllianceFrame | null;
  ownOffsetS: number;
  partnerOffsetS: number;
}) {
  const preview = useMemo(() => previewFrameFor(ownAlliance, frame), [ownAlliance, frame]);
  const shared = useMemo(
    () => (own === null ? [] : previewAllianceFindings(own, model.sharedRobot, preview, { ownS: ownOffsetS, partnerS: partnerOffsetS })),
    [own, model.sharedRobot, preview, ownOffsetS, partnerOffsetS],
  );
  const now = useMemo(
    () => (own === null ? [] : previewAllianceFindings(own, model.partner.robot, preview, { ownS: ownOffsetS, partnerS: partnerOffsetS })),
    [own, model.partner, preview, ownOffsetS, partnerOffsetS],
  );
  const collisions = (findings: readonly Finding[]) => findings.filter((finding) => finding.code === "ALLIANCE_COLLISION").length;
  const before = collisions(shared);
  const after = collisions(now);
  const timing = model.partner.shared
    ? "the partner's own shared run"
    : `your robot's drive limits, scaled ×${model.partner.driveScale.toFixed(2)} to the partner's shared pace`;
  const pick = (finding: Finding) => {
    if (!finding.stepId.startsWith("(")) setProposerSelection({ stepId: finding.stepId });
  };
  return (
    <>
      <FindingGroup
        title="Proposal"
        findings={model.findings}
        empty={
          session.changes.length === 0
            ? "No changes yet."
            : "The share takes every change: the partner's app will list them for review exactly like this."
        }
        note="what the partner's app will refuse"
        testId="proposal-findings"
        onPick={pick}
      />
      <FindingGroup
        title="Alliance"
        help="alliance"
        note={
          <span data-testid="proposal-alliance-note">
            predicted against your auto · timed with {timing} · {before} {before === 1 ? "collision" : "collisions"} before your changes,{" "}
            {after} now
          </span>
        }
        findings={now}
        empty={own === null ? "Your robot could not be predicted, so it cannot be compared." : "No predicted conflicts between your robot and the proposed version."}
        testId="proposal-alliance"
        time
        onPick={(finding) => {
          setProposerPlayback(finding.timeS ?? 0);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The partner step inspector.
// ---------------------------------------------------------------------------------------------

const HEADING_CHOICES = [
  { value: "tangent", label: "Tangent" },
  { value: "tangentReversed", label: "Reverse tangent" },
  { value: "constant", label: "Constant" },
  { value: "linear", label: "Linear" },
] as const;

function StepInspector({ session, model }: { session: ProposerSession; model: ProposerModel }) {
  const stepId = session.selection.stepId;
  const slot = stepId === undefined ? undefined : slotsOfStructure(model.preview).get(stepId);
  const added = stepId !== undefined && [...model.context.addedIds.values()].includes(stepId);
  const planStep = stepId === undefined ? undefined : findPlanStep(model, stepId);
  return (
    // The partner step's rows sit on the Inspector's grid, as its sections share its headers (issue #431).
    <div className={`${styles.inspector} ${INSPECTOR_GRID}`} data-testid="proposal-inspector-body">
      {slot === undefined ? (
        <p className={styles.note}>Nothing selected.</p>
      ) : (
        <StepFields
          node={slot.node}
          added={added}
          session={session}
          startPose={planStep?.startPose ?? null}
          endPose={planStep?.endPose ?? null}
          estimateS={model.derived.estimate?.byStepId[slot.node.id]?.nominalS ?? null}
          synthetic={planStep?.step ?? null}
        />
      )}
      <ShareSection session={session} />
    </div>
  );
}

function findPlanStep(model: ProposerModel, stepId: string) {
  const walk = (steps: readonly import("@horizon36596/zenith-core").PlanStep[]): import("@horizon36596/zenith-core").PlanStep | undefined => {
    for (const step of steps) {
      if (step.id === stepId) return step;
      const inner = walk(step.children ?? []);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return walk(model.derived.plan?.steps ?? []);
}

function ShareSection({ session }: { session: ProposerSession }) {
  if (session.share !== undefined) {
    return (
      <Section title="Share" defaultOpen={false}>
        <p className={styles.note} data-testid="proposal-share-cloud">
          Share <code>{session.shareRef.shareId}</code> from {teamInSentence(session.share.fromTeam)}, at revision {session.shareRef.revision}.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Share" defaultOpen={false}>
      <p className={styles.note} data-testid="proposal-share-local">
        Loaded from a file, which records no share or revision.
      </p>
      <TextField
        label="Share id"
        value={session.shareRef.shareId}
        testId="proposal-share-id"
        hint="The id of the share this proposal is for, if the team that sent the file gave you one. It only helps them match it; their app checks the routine itself."
        onChange={(value) => {
          const cleaned = value.trim();
          if (/^[A-Za-z0-9_-]+$/.test(cleaned)) setShareRef({ ...session.shareRef, shareId: cleaned });
        }}
      />
      <NumberField
        label="Revision"
        value={session.shareRef.revision}
        step={1}
        digits={0}
        min={0}
        testId="proposal-share-revision"
        hint="The revision of their auto the share was made from, as their share shows it."
        onChange={(value: number) => {
          setShareRef({ ...session.shareRef, revision: Math.max(0, Math.round(value)) });
        }}
      />
    </Section>
  );
}

function StepFields({
  node,
  added,
  session,
  startPose,
  endPose,
  estimateS,
  synthetic,
}: {
  node: ProjectionStep;
  added: boolean;
  session: ProposerSession;
  startPose: import("@horizon36596/zenith-core").Pose | null;
  endPose: import("@horizon36596/zenith-core").Pose | null;
  estimateS: number | null;
  synthetic: import("@horizon36596/zenith-schema").Step | null;
}) {
  const envelope = proposedEnvelope(session.changes, node.id);
  const point = session.selection.point;
  const name = commandNamer(session.projection);
  return (
    <>
      <div className={styles.readout} data-testid="proposal-inspector-step">
        <span>
          <code>{node.id}</code> · {KIND_LABEL[node.kind]}
          {added ? " · added by this proposal" : ""}
        </span>
        <span className={styles.mono}>{stepWords(node, name)}</span>
        <span className={styles.mono}>{estimateS === null ? "time not known" : `about ${estimateS.toFixed(1)} s in the preview`}</span>
      </div>

      {node.kind === "path" ? (
        <>
          {point !== undefined ? <PointFields node={node} point={point} /> : null}
          <SelectField
            label="Heading"
            value={(node.heading?.mode ?? "tangent") as (typeof HEADING_CHOICES)[number]["value"]}
            options={
              node.heading !== undefined && !HEADING_CHOICES.some((choice) => choice.value === node.heading?.mode)
                ? [...HEADING_CHOICES, { value: node.heading.mode as never, label: node.heading.mode === "facePoint" ? "Facing point" : "Piecewise" }]
                : HEADING_CHOICES
            }
            testId="proposal-heading"
            onChange={(mode) => {
              const start = startPose?.headingRad ?? 0;
              const end = endPose?.headingRad ?? start;
              const heading =
                mode === "constant"
                  ? { mode, headingRad: end }
                  : mode === "linear"
                    ? { mode, fromRad: start, toRad: end }
                    : { mode };
              proposeHeading(node.id, heading as never);
            }}
          />
          {node.heading?.mode === "constant" ? (
            <NumberField
              label="Heading"
              value={node.heading.headingRad * DEG}
              unit="°"
              step={1}
              digits={1}
              testId="proposal-heading-constant"
              hint="The one angle the robot holds the whole way. ↑ ↓ step it."
              onChange={(value: number) => {
                proposeHeading(node.id, { mode: "constant", headingRad: value / DEG });
              }}
            />
          ) : null}
          {node.heading?.mode === "linear" ? (
            <>
              <NumberField
                label="From"
                value={node.heading.fromRad * DEG}
                unit="°"
                step={1}
                digits={1}
                testId="proposal-heading-from"
                onChange={(value: number) => {
                  if (node.heading?.mode === "linear") proposeHeading(node.id, { ...node.heading, fromRad: value / DEG });
                }}
              />
              <NumberField
                label="To"
                value={node.heading.toRad * DEG}
                unit="°"
                step={1}
                digits={1}
                testId="proposal-heading-to"
                onChange={(value: number) => {
                  if (node.heading?.mode === "linear") proposeHeading(node.id, { ...node.heading, toRad: value / DEG });
                }}
              />
            </>
          ) : null}
          <NumberField
            label="Speed"
            value={node.speedFraction ?? null}
            step={0.05}
            digits={2}
            min={0.05}
            max={1}
            testId="proposal-speed"
            hint="The share of full speed this path drives at. Empty means the partner's own default, which the share does not say."
            onChange={(value: number) => {
              proposeSpeed(node.id, value);
            }}
          />
          {(node.markers ?? []).map((marker, index) =>
            "t" in marker.at ? (
              <NumberField
                key={`${marker.token}-${String(index)}`}
                label={`Marker ${name(marker.token)} at`}
                value={marker.at.t}
                unit="t"
                step={0.01}
                digits={2}
                min={0}
                max={1}
                testId={`proposal-marker-${String(index)}`}
                hint="Where along the path the marker fires, from 0 at the start to 1 at the end. Drag its pin on the field, or type a number here."
                onChange={(value: number) => {
                  proposeMarker(node.id, index, { t: value });
                }}
              />
            ) : (
              <FieldRow key={`${marker.token}-${String(index)}`} label={`Marker ${name(marker.token)}`}>
                <span className={styles.mono}>{"distanceIn" in marker.at ? `${String(marker.at.distanceIn)} in from the start` : `${String(marker.at.distanceFromEndIn)} in from the end`}</span>
              </FieldRow>
            ),
          )}
        </>
      ) : null}

      {node.kind === "wait" && node.until === undefined ? (
        <NumberField
          label="Wait"
          value={node.seconds ?? 0}
          unit="s"
          step={0.1}
          digits={1}
          min={0}
          max={30}
          testId="proposal-wait-seconds"
          hint="How long the partner's robot waits here."
          onChange={(value: number) => {
            proposeWaitSeconds(node.id, value);
          }}
        />
      ) : null}

      {!added && (node.kind === "path" || node.kind === "command" || node.kind === "wait") ? (
        <NumberField<number | null>
          label="Timeout"
          value={node.timeoutS ?? null}
          unit="s"
          step={0.1}
          digits={1}
          min={0.1}
          nullable
          placeholder="Never"
          testId="proposal-timeout"
          hint="The longest this step may run before the robot moves on. Empty removes it."
          onChange={(value) => {
            proposeTimeout(node.id, value);
          }}
        />
      ) : null}

      {!added && synthetic !== null && (node.kind === "path" || node.kind === "command" || node.kind === "wait") ? (
        <div className={styles.actions}>
          {envelope === null ? (
            <TextAction
              label="Propose an envelope"
              hint="Declares an area this step's robot stays inside while it runs: a 24 in square round where it starts, to drag into place on the field."
              onClick={() => {
                if (startPose === null) return;
                proposeEnvelope(node.id, defaultEnvelopeFor(synthetic, startPose, estimateS));
              }}
              testId="proposal-envelope-add"
              disabledReason={startPose === null ? "Nobody can say where this step starts." : null}
            >
              + Propose an envelope
            </TextAction>
          ) : (
            <>
              <NumberField
                label="Envelope for"
                value={envelope.maxDurationS}
                unit="s"
                step={0.1}
                digits={1}
                min={0.1}
                max={30}
                testId="proposal-envelope-seconds"
                hint="How long the envelope holds from the moment the step starts."
                onChange={(value: number) => {
                  proposeEnvelope(node.id, { ...envelope, maxDurationS: value });
                }}
              />
              <TextAction
                label="Take the envelope out"
                hint="Removes the envelope this proposal gives the step."
                onClick={() => {
                  proposeEnvelope(node.id, null);
                }}
                testId="proposal-envelope-remove"
              >
                Take the envelope out
              </TextAction>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

/** The selected point's numbers: the keyboard way to move what the field drags. */
function PointFields({ node, point }: { node: Extract<ProjectionStep, { kind: "path" }>; point: PointTarget }) {
  const segment = node.segments[point.segmentIndex];
  if (segment === undefined) return null;
  const at =
    point.pointKind === "control"
      ? segment.kind === "bezier"
        ? segment.control[point.controlIndex ?? 0]
        : undefined
      : segment[point.pointKind];
  if (at === undefined) return null;
  const name = point.pointKind === "control" ? `Control ${String((point.controlIndex ?? 0) + 1)}` : point.pointKind === "from" ? "Start" : "End";
  const move = (xIn: number, yIn: number) => {
    const headingRad = (at as { headingRad?: number }).headingRad;
    proposeMovePose(node.id, point, headingRad === undefined ? { xIn, yIn } : { xIn, yIn, headingRad });
  };
  return (
    <>
      <NumberField
        label={`${name} x`}
        value={at.xIn}
        unit="in"
        step={0.5}
        digits={2}
        testId="proposal-point-x"
        hint="Where this point sits across the field. Drag it on the field, or ↑ ↓ here."
        onChange={(value: number) => {
          move(value, at.yIn);
        }}
      />
      <NumberField
        label={`${name} y`}
        value={at.yIn}
        unit="in"
        step={0.5}
        digits={2}
        testId="proposal-point-y"
        hint="Where this point sits up the field. Drag it on the field, or ↑ ↓ here."
        onChange={(value: number) => {
          move(at.xIn, value);
        }}
      />
    </>
  );
}
