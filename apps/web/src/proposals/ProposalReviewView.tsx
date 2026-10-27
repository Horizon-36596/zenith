/**
 * The owner's review of a proposal (spec 13 section 14, in the review mode
 * of spec 06 section 4): the auto as it is now ghosted and the
 * proposal over it, every change with what it does in the owner's own names, the proposer's
 * comment, whether it can be taken and what it does to the time, the findings of the result, and
 * the proposer's robot when their projection is loaded in the alliance view.
 *
 * Accept and Reject are choices; Apply makes the accepted ones through the editor's normal edit
 * path, one undo step per Apply. Nothing is written to a file until the owner saves as usual.
 */
import { useCallback, useMemo, useState } from "react";
import { FileCheck2 } from "lucide-react";
import { canonicalize } from "@horizon36596/zenith-core";
import { cloudEnabled } from "../account/config";
import { FieldCanvas } from "../canvas/FieldCanvas";
import { Panel } from "../components/primitives";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import { allianceRunS, buildPartnerScene } from "../alliance/model";
import { allianceView } from "../alliance/useAlliance";
import { useAllianceState } from "../alliance/store";
import { derive } from "../state/derived";
import { redo, setPlayback, setPlaying, undo, useEditor } from "../state/store";
import appStyles from "../app/App.module.css";
import {
  acceptChange,
  acceptEveryValidChange,
  applyAccepted,
  applyBlockedReason,
  leaveOwnerReview,
  rejectCloudProposal,
  rejectEveryChange,
  reviewFor,
} from "./ownerActions";
import { setFocus, useOwnerReview, type CloudReviewRef, type OwnerReviewState } from "./ownerStore";
import type { OwnerReview, ReviewChangeRow } from "./review";
import { deltaSign, deltaText, FindingGroup, Scrubber, secondsText, TextAction, useKeyGuard } from "./parts";
import styles from "./proposals.module.css";

/** The words for what became of a change, for its chip. */
function statusOf(row: ReviewChangeRow, rejected: boolean): { key: string; words: string } {
  if (row.applied) return { key: "applied", words: "applied" };
  if (row.validity === "conflict") return { key: "conflict", words: "conflict" };
  if (row.validity === "invalid") return { key: "invalid", words: "does not fit" };
  if (row.validity === "refused") return { key: "refused", words: "refused" };
  if (row.accepted) return { key: "accepted", words: "accepted" };
  return rejected ? { key: "rejected", words: "rejected" } : { key: "open", words: "not accepted" };
}

export function ProposalReviewView() {
  const state = useOwnerReview();
  const editor = useEditor();
  const allianceState = useAllianceState();

  // Undo and Redo stay the editor's, so an Apply can be taken back; every other editing key waits.
  const handleKey = useCallback((event: KeyboardEvent): boolean => {
    const chord = event.ctrlKey || event.metaKey;
    if (chord && (event.key === "z" || event.key === "Z") && !event.shiftKey) {
      undo();
      return true;
    }
    if (chord && (event.key === "y" || event.key === "Y" || ((event.key === "z" || event.key === "Z") && event.shiftKey))) {
      redo();
      return true;
    }
    return false;
  }, []);
  const passes = useCallback((event: KeyboardEvent): boolean => {
    if (event.key === "Escape" || /^F\d+$/.test(event.key) || event.key === "?") return true;
    const chord = event.ctrlKey || event.metaKey;
    return chord && ["k", "K", "s", "S"].includes(event.key);
  }, []);
  useKeyGuard(handleKey, passes);

  const review = state === null ? null : reviewFor(state, editor);
  const project = editor.project;
  const robot = editor.autoRobot ?? project?.robot ?? null;
  const field = editor.autoField ?? project?.field ?? null;
  const proposedDerived = useMemo(
    () => (review === null ? null : derive(review.proposed, robot, field, project?.waypoints)),
    [review, robot, field, project?.waypoints],
  );
  const currentDerived = useMemo(
    () => (editor.auto === null ? null : derive(editor.auto, robot, field, project?.waypoints)),
    [editor.auto, robot, field, project?.waypoints],
  );
  const alliance = useMemo(
    () => allianceView(proposedDerived?.plan ?? null, allianceState),
    [proposedDerived, allianceState],
  );
  const allianceS = editor.playbackS ?? 0;
  const partnerScene = useMemo(
    () => (alliance.result === null ? [] : buildPartnerScene(alliance.result.partners, allianceS)),
    [alliance.result, allianceS],
  );

  if (state === null || review === null || project === null || editor.auto === null || robot === null || field === null) return null;
  const changed = canonicalize("auto", review.proposed) !== canonicalize("auto", editor.auto);
  const shareWords =
    typeof state.proposal === "object" && state.proposal !== null && "shareRef" in state.proposal
      ? (state.proposal as { shareRef: { shareId: string; revision: number } }).shareRef
      : null;

  return (
    <>
      <div className={styles.banner} data-testid="owner-review-banner">
        <FileCheck2 size={16} strokeWidth={1.75} aria-hidden />
        <span className={styles.bannerTitle}>Reviewing a proposal for {editor.auto.title ?? editor.auto.name}</span>
        <span className={styles.mono}>
          {state.fileName}
          {shareWords === null ? "" : ` · share ${shareWords.shareId} · revision ${String(shareWords.revision)}`}
        </span>
        <span className={styles.spacer} />
        <span className={styles.mono} data-testid="owner-review-counts">
          {review.rows.length} {review.rows.length === 1 ? "change" : "changes"} · {review.validIndexes.length} can be accepted
        </span>
        {state.cloud === undefined ? null : (
          // Keyed so a Reject confirm left open never carries over to another proposal, or to the
          // same one after its status changed: one click would reject what was never asked about.
          <CloudDecision key={`${state.cloud.proposalId}:${state.cloud.status}`} cloud={state.cloud} />
        )}
        <TextAction
          label="Leave the review"
          hint="Back to editing. Applied changes stay in the auto, unsaved, like any edit; Undo still takes them out."
          onClick={leaveOwnerReview}
          testId="owner-review-leave"
        >
          Leave
        </TextAction>
      </div>

      <div className={appStyles.body}>
        <aside className={appStyles.left} style={{ width: `${String(editor.prefs.panelLeftW + 60)}px` }} data-region tabIndex={-1} aria-label="Proposed changes">
          <div className={appStyles.leftSteps}>
            <Panel label="Proposal" title="Proposal" help="review" testId="owner-review-changes">
              <ChangeRows state={state} review={review} />
            </Panel>
          </div>
        </aside>

        <main className={appStyles.centre}>
          <div className={appStyles.canvas} data-region tabIndex={-1} aria-label="Field canvas, the proposal over your auto">
            {proposedDerived?.plan === null || proposedDerived?.plan === undefined || proposedDerived.resolved === null ? (
              <p className={styles.empty}>{proposedDerived?.findingsReason ?? "The proposed auto cannot be drawn."}</p>
            ) : (
              <FieldCanvas
                field={proposedDerived.plan.field}
                robot={proposedDerived.plan.robot}
                auto={review.proposed}
                resolved={proposedDerived.resolved}
                plan={proposedDerived.plan}
                basePlan={changed ? (currentDerived?.plan ?? null) : null}
                estimate={proposedDerived.estimate}
                findings={proposedDerived.findings}
                selection={{}}
                tool="select"
                alliance={editor.alliance}
                waypoints={project.waypoints ?? null}
                snap={false}
                showGhosts={false}
                playbackS={alliance.active ? Math.max(0, allianceS - alliance.ownOffsetS) : allianceS}
                partners={partnerScene}
                trace={null}
                staticSvg={proposedDerived.staticSvg}
                fieldView={editor.prefs.fieldView}
                fieldImageVariant={editor.prefs.fieldStyle}
                fieldGrid={editor.prefs.fieldGrid}
                onSelect={() => undefined}
                onHover={() => undefined}
                onDragStart={() => undefined}
                onDragEnd={() => undefined}
                onDragPose={() => undefined}
                onDragHeading={() => undefined}
                onAddPathPoint={() => undefined}
                onAddMarker={() => undefined}
                onDragMarker={() => undefined}
                onAddCommandAt={() => undefined}
              />
            )}
          </div>
          <Scrubber
            testId="owner-review"
            playbackS={allianceS}
            playing={editor.playing}
            onPlayback={setPlayback}
            onPlaying={setPlaying}
            runS={
              (alliance.active
                ? allianceRunS(proposedDerived?.totalS ?? null, alliance.ownOffsetS, allianceState.partners)
                : proposedDerived?.totalS) ?? 0
            }
          />
          <section className={styles.bottom} data-region tabIndex={-1} aria-label="Findings of the result">
            <FindingGroup
              title="Result"
              help="findings"
              note={changed ? "your auto with the accepted changes" : "your auto as it is"}
              findings={proposedDerived?.findings ?? []}
              empty="No problems found in the result."
              testId="owner-review-findings"
            />
            {alliance.active ? (
              <FindingGroup
                title="Alliance"
                help="alliance"
                note="predicted against the partners loaded in the alliance view, the proposer's robot among them"
                findings={alliance.result?.findings.map((item) => item.finding) ?? []}
                empty="No predicted conflicts with your partners."
                testId="owner-review-alliance"
                time
              />
            ) : null}
          </section>
        </main>

        <aside className={appStyles.right} style={{ width: `${String(editor.prefs.panelRightW)}px` }} data-region tabIndex={-1} aria-label="Read against">
          <Panel label="Read against" title="Read against" help="pinned" testId="owner-review-pinned">
            <PinnedNote state={state} review={review} />
          </Panel>
        </aside>
      </div>
    </>
  );
}

function ChangeRows({ state, review }: { state: OwnerReviewState; review: OwnerReview }) {
  const toApply = review.toApply.length;
  const toReject = review.rows.filter((row) => !row.applied && !state.rejected.has(row.index)).length;
  return (
    <div className={styles.list}>
      {review.refusals.length === 0 ? null : (
        <div data-testid="owner-review-refused">
          {review.refusals.map((finding, index) => (
            <p key={String(index)} className={styles.changeWhy} style={{ padding: "var(--space-2) var(--pad-row-x)" }}>
              {finding.message}
            </p>
          ))}
        </div>
      )}
      {review.rows.length === 0 ? <p className={styles.empty}>This proposal holds no changes.</p> : null}
      <div role="list">
        {review.rows.map((row) => (
          <ChangeRow key={row.index} row={row} rejected={state.rejected.has(row.index)} focused={state.focus === row.index} />
        ))}
      </div>
      <div className={styles.totals} data-testid="owner-review-totals">
        <span>total</span>
        <span className={styles.delta}>{secondsText(review.model.totals.baseS)}</span>
        <span aria-hidden>→</span>
        <span className={styles.delta}>{secondsText(review.model.totals.headS)}</span>
        <span className={styles.delta} data-sign={deltaSign(review.model.totals.deltaS)}>
          {deltaText(review.model.totals.deltaS)}
        </span>
      </div>
      <div className={styles.listFoot}>
        <TextAction
          label="Accept all valid"
          hint="Accepts every change that can be taken. Conflicts and changes that do not fit stay out."
          disabledReason={review.validIndexes.length === 0 ? "No change can be accepted." : null}
          onClick={acceptEveryValidChange}
          testId="owner-review-accept-all"
        >
          Accept all valid
        </TextAction>
        <TextAction
          label="Reject all"
          hint="Rejects every change not applied yet. Nothing is applied until you press Apply."
          disabledReason={toReject === 0 ? "Every change is rejected or applied already." : null}
          onClick={rejectEveryChange}
          testId="owner-review-reject-all"
        >
          Reject all
        </TextAction>
        <span className={styles.spacer} />
        <TextAction
          kind="primary"
          label="Apply the accepted changes"
          hint="Makes them in your auto as one edit: Undo takes them all out. The file is not saved until you save."
          disabledReason={toApply === 0 ? "Accept at least one change first." : applyBlockedReason(state)}
          onClick={applyAccepted}
          testId="owner-review-apply"
        >
          {toApply === 0 ? "Apply" : `Apply ${String(toApply)}`}
        </TextAction>
      </div>
    </div>
  );
}

function ChangeRow({ row, rejected, focused }: { row: ReviewChangeRow; rejected: boolean; focused: boolean }) {
  const status = statusOf(row, rejected);
  const canTake = row.validity === "valid" && !row.applied;
  return (
    <div
      role="listitem"
      className={styles.change}
      aria-selected={focused}
      data-testid={`owner-change-${String(row.number)}`}
      data-status={status.key}
      onClick={() => {
        setFocus(row.index);
      }}
    >
      <div className={styles.changeHead}>
        <span className={styles.changeNumber}>{row.number}</span>
        <span className={styles.changeSummary}>{row.summary}</span>
        <span className={styles.status} data-status={status.key} data-testid="owner-change-status">
          {status.words}
        </span>
      </div>
      {row.comment === null ? null : (
        <p className={styles.quote} data-testid="owner-change-comment">
          “{row.comment}”
        </p>
      )}
      {row.reason === null ? null : (
        <span className={styles.changeWhy} data-kind={row.validity} data-testid="owner-change-why">
          {row.reason}
        </span>
      )}
      <div className={styles.changeFoot}>
        <div className={styles.segmented} role="group" aria-label={`Change ${String(row.number)}`}>
          <Tooltip
            label="Accept"
            hint={canTake ? "Takes this change when you press Apply." : row.applied ? "Already applied. Undo takes it out." : "A change that conflicts or does not fit can only be rejected."}
          >
            <button
              type="button"
              className={styles.segment}
              aria-pressed={row.accepted || row.applied}
              aria-disabled={canTake ? undefined : true}
              data-testid={`owner-accept-${String(row.number)}`}
              onClick={(event) => {
                event.stopPropagation();
                if (canTake) acceptChange(row.index, true);
              }}
            >
              Accept
            </button>
          </Tooltip>
          <Tooltip label="Reject" hint="Leaves this change out.">
            <button
              type="button"
              className={styles.segment}
              aria-pressed={rejected && !row.accepted && !row.applied}
              aria-disabled={row.applied ? true : undefined}
              data-testid={`owner-reject-${String(row.number)}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!row.applied) acceptChange(row.index, false);
              }}
            >
              Reject
            </button>
          </Tooltip>
        </div>
        <Tooltip label="What it does to the time" hint="Seconds this change adds to its step, or saves, with every valid change made. A dash means the estimate cannot say.">
          <span className={styles.delta} data-sign={deltaSign(row.deltaS)} tabIndex={0}>
            {deltaText(row.deltaS)}
          </span>
        </Tooltip>
        {row.stepId === null ? null : <span className={styles.mono}>{row.stepId}</span>}
      </div>
    </div>
  );
}

/**
 * A proposal from the cloud: what the team that sent it will see, and Reject proposal. The first
 * Apply marks it accepted by itself.
 */
function CloudDecision({ cloud }: { cloud: CloudReviewRef }) {
  // Rejecting reaches the other team and cannot be taken back, so it asks first (UI_GUIDE 9.14).
  const [asking, setAsking] = useState(false);
  const words =
    cloud.status === "open"
      ? cloud.deciding
        ? "Recording your decision…"
        : `From ${cloud.fromTeam}: open`
      : `From ${cloud.fromTeam}: ${cloud.status}`;
  return (
    <>
      <Tooltip
        label="What they see"
        hint={
          cloud.status === "open"
            ? `${cloud.fromTeam} sees this proposal as open. Apply marks it accepted; Reject proposal marks it rejected.`
            : `${cloud.fromTeam} sees this proposal as ${cloud.status}.`
        }
      >
        <span className={styles.mono} tabIndex={0} data-testid="owner-review-cloud-status" data-status={cloud.status}>
          {words}
        </span>
      </Tooltip>
      {cloud.status === "open" && asking ? (
        <ConfirmRow
          inline
          testId="owner-review-reject-confirm"
          sentence={`Reject the whole proposal? ${cloud.fromTeam} sees it as rejected. Nothing in your auto changes.`}
          verb="Reject proposal"
          verbHint="This cannot be undone."
          whyDisabled={cloud.deciding ? "Your decision is on its way." : null}
          onConfirm={() => {
            setAsking(false);
            void rejectCloudProposal();
          }}
          onCancel={() => {
            setAsking(false);
          }}
        />
      ) : cloud.status === "open" ? (
        <TextAction
          label="Reject proposal"
          hint={`Marks the whole proposal rejected, so ${cloud.fromTeam} sees it. Nothing in your auto changes. Asks first.`}
          disabledReason={cloud.deciding ? "Your decision is on its way." : null}
          onClick={() => {
            setAsking(true);
          }}
          testId="owner-review-reject-proposal"
        >
          Reject proposal
        </TextAction>
      ) : null}
    </>
  );
}

function PinnedNote({ state, review }: { state: OwnerReviewState; review: OwnerReview }) {
  return (
    <div className={styles.inspector} data-testid="owner-review-pinned-note">
      {state.pinnedSource === "current" ? (
        <p className={styles.note}>
          <strong>Your auto as it was when you opened this proposal.</strong>{" "}
          {cloudEnabled()
            ? "No team library revision exists yet. If the auto has changed since you shared it, the proposal is refused as stale."
            : "If the auto has changed since you made the share file, the proposal is refused as stale."}
        </p>
      ) : (
        <p className={styles.note}>
          <strong>The team library revision the proposal was made against.</strong> Steps that have changed since then are
          conflicts and can only be rejected.
        </p>
      )}
      {state.shareRef === undefined ? null : (
        <p className={styles.note}>
          Opened from share <code>{state.shareRef.shareId}</code>, revision {state.shareRef.revision}, which is{" "}
          {state.share ?? "live"}.
        </p>
      )}
      <p className={styles.note}>{review.rows.filter((row) => row.applied).length} applied so far.</p>
    </div>
  );
}
