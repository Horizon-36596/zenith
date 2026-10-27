/**
 * Two revisions of one team library auto in the review view (spec 13 section 5.3, in the review
 * mode of spec 6 section 4): one drawn solid over the other, ghosted, the steps that differ with
 * what each does to the time, and on the right the choice. Keep mine, Keep theirs, or Open either
 * in the project. Nothing is overwritten and nothing in the project changes until the person picks
 * one of those.
 *
 * It is the editor's frame with its panels swapped, as the pull-request review is, and it reuses
 * that view's model and styles. The editor's own document stays underneath untouched: every key
 * that would edit it waits while this view is open.
 */
import { useEffect, useMemo } from "react";
import { GitCompare } from "lucide-react";
import type { Revision } from "@horizon36596/zenith-cloud";
import type { Auto } from "@horizon36596/zenith-schema";
import { FieldCanvas } from "../canvas/FieldCanvas";
import { Panel } from "../components/primitives";
import { SheetButton } from "../cloud/controls";
import { TextAction } from "../proposals/parts";
import { whyCannotPublish } from "../account/permissions";
import { account, useAccount } from "../account/store";
import { timeAgo, whenWords } from "../account/words";
import { derive, severityCounts } from "../state/derived";
import { useEditor } from "../state/store";
import appStyles from "../app/App.module.css";
import reviewStyles from "../github/github.module.css";
import { autoOfRevision, projectFromRevision } from "./libraryModel";
import { keepRevision, leaveRevisionReview, openReviewedRevision } from "./actions";
import {
  describePair,
  keepWords,
  pairReviewModel,
  solidWords,
  type ReviewSide,
  type RevisionPair,
  type SolidSide,
} from "./revisionReview";
import { selectLibraryReviewStep, swapLibraryReview, useLibraryReview } from "./reviewStore";
import styles from "./library.module.css";

const seconds = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)} s`);

function deltaText(deltaS: number | null): string {
  if (deltaS === null) return "—";
  if (Math.abs(deltaS) < 0.05) return "0.0 s";
  return `${deltaS > 0 ? "+" : "−"}${Math.abs(deltaS).toFixed(1)} s`;
}

const deltaSign = (deltaS: number | null): string =>
  deltaS === null || Math.abs(deltaS) < 0.05 ? "same" : deltaS > 0 ? "slower" : "faster";

/** Parses a revision's auto, or null when it cannot be read. */
function autoOf(revision: Revision): Auto | null {
  try {
    return autoOfRevision(revision).auto;
  } catch {
    return null;
  }
}

/**
 * Every key waits while the view is open, except the ones that never edit: Escape, the F-keys
 * (F6 cycles the regions), `?`, Tab and the command palette, and Enter or Space on one of this
 * view's own buttons, which press it (a change row's handler marks the key used, so the editor's
 * shortcut for it does nothing). Typing in a field is left alone.
 */
function useReadOnlyKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "Escape" || /^F\d+$/.test(event.key) || event.key === "?" || event.key === "Tab") return;
      if (
        (event.key === "Enter" || event.key === " ") &&
        target?.closest("[data-library-review] button, [data-library-review] [role='button']") != null
      ) {
        return;
      }
      const chord = event.ctrlKey || event.metaKey;
      if (chord && (event.key === "k" || event.key === "K")) return;
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}

export function RevisionReviewView() {
  const review = useLibraryReview();
  const accountState = useAccount();
  const editor = useEditor();
  useReadOnlyKeys();

  const revisions = review === null ? [] : (accountState.library.revisions[review.autoId] ?? []);
  const pair = useMemo(
    () =>
      review === null
        ? "Nothing to compare."
        : describePair({
            revisions,
            ids: review.ids,
            members: accountState.team?.members ?? [],
            uid: accountState.user?.uid ?? null,
            deviceBase: account.baseOf(review.autoId),
          }),
    [review, revisions, accountState.team, accountState.user],
  );

  if (review === null) return null;
  const solid: SolidSide = review.solid;

  return (
    <div className={styles.frame} data-library-review data-testid="library-review">
      <div className={reviewStyles.banner} data-testid="library-review-banner">
        <GitCompare size={16} strokeWidth={1.75} aria-hidden />
        <span className={reviewStyles.bannerTitle}>
          {typeof pair !== "string" && pair.diverged ? "Two versions of " : "Two revisions of "}
          {review.title}
        </span>
        {typeof pair === "string" ? null : (
          <span className={reviewStyles.bannerMono} data-testid="library-review-meta">
            {pair.diverged
              ? `both published from ${pair.commonBaseN === null ? "nothing" : `revision ${String(pair.commonBaseN)}`}`
              : `revision ${String(pair.first.n)} and revision ${String(pair.second.n)}`}
            {pair.moreSiblings > 0 ? ` · ${String(pair.moreSiblings)} more from the same revision` : ""}
          </span>
        )}
        <span className={reviewStyles.bannerSpacer} />
        {typeof pair === "string" ? null : (
          <SheetButton
            kind="text"
            tooltip="Swap which one is drawn solid"
            hint={solidWords(pair, solid)}
            onClick={swapLibraryReview}
            testId="library-review-swap"
          >
            Swap
          </SheetButton>
        )}
        <TextAction
          label="Leave the comparison"
          hint="Back to the editor as it was. Nothing is published or written."
          onClick={leaveRevisionReview}
          testId="library-review-leave"
        >
          Leave
        </TextAction>
      </div>
      {typeof pair === "string" ? (
        <div className={appStyles.body}>
          <p className={reviewStyles.empty} data-testid="library-review-error">
            {pair}
          </p>
        </div>
      ) : (
        <PairBody pair={pair} solid={solid} stepId={review.stepId} title={review.title} project={editor.project} />
      )}
    </div>
  );
}

function PairBody({
  pair,
  solid,
  stepId,
  title,
  project,
}: {
  pair: RevisionPair;
  solid: SolidSide;
  stepId: string | null;
  title: string;
  project: ReturnType<typeof useEditor>["project"];
}) {
  const editor = useEditor();
  const accountState = useAccount();
  const solidSide = solid === "first" ? pair.first : pair.second;
  const ghostSide = solid === "first" ? pair.second : pair.first;

  // The open project's robot and field when there is one, else the ones the revision carries.
  const files = useMemo(() => {
    if (project !== null) return { robot: project.robot, field: project.field, waypoints: project.waypoints };
    try {
      return projectFromRevision(title, solidSide.revision) ?? projectFromRevision(title, ghostSide.revision);
    } catch {
      return null;
    }
  }, [project, title, solidSide.revision, ghostSide.revision]);
  const model = useMemo(() => pairReviewModel(pair, solid, files), [pair, solid, files]);
  const solidAuto = useMemo(() => autoOf(solidSide.revision), [solidSide.revision]);
  const ghostAuto = useMemo(() => autoOf(ghostSide.revision), [ghostSide.revision]);
  const solidDerived = useMemo(
    () => derive(solidAuto, files?.robot ?? null, files?.field ?? null, files?.waypoints),
    [solidAuto, files],
  );
  const ghostDerived = useMemo(
    () => derive(ghostAuto, files?.robot ?? null, files?.field ?? null, files?.waypoints),
    [ghostAuto, files],
  );
  const publishWhy = whyCannotPublish(account.role()) ?? (accountState.busy ? "Publishing…" : null);

  return (
    <div className={appStyles.body}>
      <aside
        className={appStyles.left}
        style={{ width: `${String(editor.prefs.panelLeftW)}px` }}
        data-region
        tabIndex={-1}
        aria-label="Changed steps"
      >
        <div className={appStyles.leftSteps}>
          <Panel label="Changed steps" title="Changed steps" help="versions" testId="library-review-changes">
            {typeof model === "string" ? (
              <p className={reviewStyles.empty} data-testid="library-review-no-model">
                {model}
              </p>
            ) : (
              <>
                <p className={reviewStyles.empty}>
                  What {solidSide.phrase} does differently from {ghostSide.phrase}.
                </p>
                {model.rows.length === 0 ? (
                  <p className={reviewStyles.empty} data-testid="library-review-no-changes">
                    {model.identical ? "The two versions are identical." : (model.reason ?? "No step changed.")}
                  </p>
                ) : (
                  model.rows.map((row) => (
                    <div
                      key={`${row.kind}:${row.stepId}`}
                      className={reviewStyles.changeRow}
                      aria-selected={stepId === row.stepId}
                      data-testid={`library-review-change-${row.stepId}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        selectLibraryReviewStep(row.stepId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        selectLibraryReviewStep(row.stepId);
                      }}
                    >
                      <span className={reviewStyles.changeHead}>
                        <span className={reviewStyles.kind} data-kind={row.kind}>
                          {row.kind}
                        </span>
                        <span className={reviewStyles.changeId}>{row.stepId}</span>
                      </span>
                      <span
                        className={reviewStyles.delta}
                        data-sign={deltaSign(row.deltaS)}
                        title={`${seconds(row.baseS)} → ${seconds(row.headS)}`}
                      >
                        {deltaText(row.deltaS)}
                      </span>
                      <span className={reviewStyles.changeSummary}>
                        {row.summary}
                        {row.movedIn === null ? "" : ` Moved ${row.movedIn.toFixed(1)} in.`}
                      </span>
                    </div>
                  ))
                )}
                <div className={reviewStyles.totals} data-testid="library-review-totals">
                  <span>total</span>
                  <span className={reviewStyles.totalValue}>{seconds(model.totals.baseS)}</span>
                  <span aria-hidden>→</span>
                  <span className={reviewStyles.totalValue}>{seconds(model.totals.headS)}</span>
                  <span className={reviewStyles.delta} data-sign={deltaSign(model.totals.deltaS)}>
                    {deltaText(model.totals.deltaS)}
                  </span>
                </div>
                {model.header.length === 0 ? null : (
                  <p className={reviewStyles.empty}>The document itself differs: {model.header.join(", ")}.</p>
                )}
              </>
            )}
          </Panel>
        </div>
      </aside>

      <main className={appStyles.centre}>
        <div
          className={appStyles.canvas}
          data-region
          tabIndex={-1}
          aria-label={`Field canvas: ${solidWords(pair, solid)}`}
          data-testid="library-review-canvas"
          data-solid={String(solidSide.revision.id)}
        >
          {files === null || solidAuto === null || solidDerived.plan === null || solidDerived.resolved === null ? (
            <p className={reviewStyles.empty}>
              {files === null
                ? "Open your robot's folder first: these revisions were published without robot.json and a field."
                : (solidDerived.findingsReason ?? "This version of the auto cannot be drawn.")}
            </p>
          ) : (
            <FieldCanvas
              field={files.field}
              robot={files.robot}
              auto={solidAuto}
              resolved={solidDerived.resolved}
              plan={solidDerived.plan}
              basePlan={ghostDerived.plan}
              estimate={solidDerived.estimate}
              findings={solidDerived.findings}
              selection={stepId === null ? {} : { stepId }}
              tool="select"
              alliance={editor.alliance}
              waypoints={files.waypoints ?? null}
              snap={false}
              showGhosts={false}
              trace={null}
              staticSvg={solidDerived.staticSvg}
              fieldView={editor.prefs.fieldView}
              fieldImageVariant={editor.prefs.fieldStyle}
              fieldGrid={editor.prefs.fieldGrid}
              onSelect={(selection) => {
                selectLibraryReviewStep(selection.stepId ?? null);
              }}
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
      </main>

      <aside
        className={appStyles.right}
        style={{ width: `${String(editor.prefs.panelRightW)}px` }}
        data-region
        tabIndex={-1}
        aria-label="Choose a version"
      >
        <Panel label="Choose" title={pair.diverged ? "Choose one" : "Open one"} help="keep" testId="library-review-choose">
          <div className={styles.choose}>
            <p className={styles.note} data-testid="library-review-lead">
              {pair.diverged
                ? "Both were published from the same revision."
                : "Two revisions from one line of work."}
            </p>
            {(["first", "second"] as const).map((which) => (
              <SideChoice
                key={which}
                which={which}
                side={which === "first" ? pair.first : pair.second}
                drawn={which === solid ? "solid" : "ghost"}
                totalS={(which === solid ? solidDerived : ghostDerived).totalS}
                findings={(which === solid ? solidDerived : ghostDerived).findings}
                pair={pair}
                title={title}
                publishWhy={publishWhy}
              />
            ))}
            {pair.whyNoKeep === null ? null : (
              <p className={styles.hint} data-testid="library-review-why-no-keep">
                {pair.whyNoKeep}
              </p>
            )}
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function SideChoice({
  which,
  side,
  drawn,
  totalS,
  findings,
  pair,
  title,
  publishWhy,
}: {
  which: "first" | "second";
  side: ReviewSide;
  drawn: "solid" | "ghost";
  totalS: number | null;
  findings: ReturnType<typeof derive>["findings"];
  pair: RevisionPair;
  title: string;
  publishWhy: string | null;
}) {
  const counts = severityCounts(findings);
  const problems =
    counts.error + counts.warning === 0
      ? "no problems"
      : [
          counts.error === 0 ? null : `${String(counts.error)} error${counts.error === 1 ? "" : "s"}`,
          counts.warning === 0 ? null : `${String(counts.warning)} warning${counts.warning === 1 ? "" : "s"}`,
        ]
          .filter((part) => part !== null)
          .join(", ");
  return (
    <section className={styles.side} data-testid={`library-review-side-${which}`} data-owner={side.owner}>
      <h3 className={styles.sideHead}>{side.name}</h3>
      <div className={styles.meta}>
        <span>
          Revision <span className={styles.mono}>{side.n}</span> by {side.authorName}
        </span>
        <span title={whenWords(side.createdAt)}>{timeAgo(side.createdAt, Date.now())}</span>
        <span className={styles.mono}>{seconds(totalS)}</span>
        <span>{problems}</span>
        <span>{drawn === "solid" ? "drawn solid" : "the dashed ghost"}</span>
      </div>
      <div className={styles.actions}>
        {pair.diverged ? (
          <SheetButton
            tooltip={side.keepLabel}
            hint={keepWords(pair, which)}
            whyDisabled={pair.whyNoKeep ?? publishWhy}
            onClick={() => void keepRevision(title, pair, which)}
            testId={`library-review-keep-${which}`}
          >
            {side.keepLabel}
          </SheetButton>
        ) : null}
        <SheetButton
          kind="text"
          tooltip="Open in project"
          hint={`Writes ${side.phrase} into the open folder, ready to commit; it asks first if the open auto has unsaved edits.`}
          onClick={() => void openReviewedRevision(title, side.revision)}
          testId={`library-review-open-${which}`}
        >
          Open in project
        </SheetButton>
      </div>
    </section>
  );
}
