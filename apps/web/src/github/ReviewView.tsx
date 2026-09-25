/**
 * Review mode (site/docs/github.md): the head drawn over the base,
 * the changed steps listed with what each one did to the estimate, the head's findings, and every
 * row linked to its line in the pull request's own diff view.
 *
 * It is the editor's frame with two panels swapped, not a second application: the same canvas, the
 * same findings panel, the same tokens. Editing is off — comments and approval happen on GitHub,
 * and the inspector says so rather than accepting keystrokes that would go nowhere.
 */
import { ExternalLink, GitPullRequest } from "lucide-react";
import { FieldCanvas } from "../canvas/FieldCanvas";
import { Panel } from "../components/primitives";
import { FindingsPanel } from "../panels/FindingsPanel";
import { LedgerPanel } from "../panels/LedgerPanel";
import { selectStep, setPrefs, useDerived, useEditor } from "../state/store";
import { closeReview } from "./actions";
import type { ReviewStepRow } from "./reviewModel";
import appStyles from "../app/App.module.css";
import styles from "./github.module.css";

/** `+1.4 s`, `−0.6 s`, or a dash when one side has no estimate to compare. */
function deltaText(deltaS: number | null): string {
  if (deltaS === null) return "—";
  if (Math.abs(deltaS) < 0.05) return "0.0 s";
  return `${deltaS > 0 ? "+" : "−"}${Math.abs(deltaS).toFixed(1)} s`;
}

const deltaSign = (deltaS: number | null): string =>
  deltaS === null || Math.abs(deltaS) < 0.05 ? "same" : deltaS > 0 ? "slower" : "faster";

const seconds = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)} s`);

export function ReviewView() {
  const state = useEditor();
  const derived = useDerived();
  const review = state.review;
  if (review === null || state.project === null || state.auto === null) return null;

  const { model } = review;
  const otherFiles = review.files.filter((file) => file !== review.path);

  const openAnchor = (row: ReviewStepRow): void => {
    window.open(`${review.htmlUrl}/files${row.anchor ?? ""}`, "_blank", "noopener");
  };

  return (
    <>
      <div className={styles.banner} data-testid="review-banner">
        <GitPullRequest size={16} strokeWidth={1.5} aria-hidden />
        <span className={styles.bannerTitle}>{review.title}</span>
        <span className={styles.bannerMono}>
          {review.owner}/{review.repo}#{review.number} · {review.headRef} → {review.baseRef}
        </span>
        <span className={styles.bannerSpacer} />
        {otherFiles.length === 0 ? null : (
          <span className={styles.bannerMono}>
            also changes {otherFiles.length} other file{otherFiles.length === 1 ? "" : "s"}
          </span>
        )}
        <a
          className={styles.link}
          href={review.htmlUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="review-pr-link"
        >
          Open the pull request
        </a>
        <button type="button" className={styles.link} data-testid="review-leave" onClick={closeReview}>
          Leave review
        </button>
      </div>

      <div className={appStyles.body}>
        <aside
          className={appStyles.left}
          style={{ width: `${String(state.prefs.panelLeftW)}px` }}
          data-region
          tabIndex={-1}
          aria-label="Changed steps"
        >
          <div className={appStyles.leftSteps}>
            <Panel label="Changed steps" title="Changed steps" help="changes" testId="review-changes">
              {model.rows.length === 0 ? (
                <p className={styles.empty} data-testid="review-no-changes">
                  {model.identical
                    ? "The two versions of this auto are identical."
                    : (model.reason ?? "No step changed.")}
                </p>
              ) : (
                model.rows.map((row) => (
                  <div
                    key={`${row.kind}:${row.stepId}`}
                    className={styles.changeRow}
                    aria-selected={state.selection.stepId === row.stepId}
                    data-testid={`review-change-${row.stepId}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      selectStep(row.stepId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") selectStep(row.stepId);
                    }}
                  >
                    <span className={styles.changeHead}>
                      <span className={styles.kind} data-kind={row.kind}>
                        {row.kind}
                      </span>
                      <span className={styles.changeId}>{row.stepId}</span>
                      <button
                        type="button"
                        className={styles.link}
                        aria-label={`Show ${row.stepId} in the pull request's diff`}
                        data-testid={`review-anchor-${row.stepId}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openAnchor(row);
                        }}
                      >
                        <ExternalLink size={12} strokeWidth={1.5} aria-hidden />
                      </button>
                    </span>
                    <span
                      className={styles.delta}
                      data-sign={deltaSign(row.deltaS)}
                      title={`${seconds(row.baseS)} → ${seconds(row.headS)}`}
                    >
                      {deltaText(row.deltaS)}
                    </span>
                    <span className={styles.changeSummary}>
                      {row.summary}
                      {row.movedIn === null ? "" : ` Moved ${row.movedIn.toFixed(1)} in.`}
                    </span>
                  </div>
                ))
              )}
              <div className={styles.totals} data-testid="review-totals">
                <span>total</span>
                <span className={styles.totalValue}>{seconds(model.totals.baseS)}</span>
                <span aria-hidden>→</span>
                <span className={styles.totalValue}>{seconds(model.totals.headS)}</span>
                <span className={styles.delta} data-sign={deltaSign(model.totals.deltaS)}>
                  {deltaText(model.totals.deltaS)}
                </span>
              </div>
              {model.header.length === 0 ? null : (
                <p className={styles.empty}>
                  The document itself changed: {model.header.join(", ")}.
                </p>
              )}
            </Panel>
          </div>
          <div className={appStyles.leftLedger}>
            <Panel label="Ledger" title="Ledger" help="ledger" testId="ledger-panel">
              <LedgerPanel />
            </Panel>
          </div>
        </aside>

        <main className={appStyles.centre}>
          <div className={appStyles.canvas} data-region tabIndex={-1} aria-label="Field canvas">
            {derived.plan === null || derived.resolved === null ? (
              <p className={styles.empty}>
                {derived.findingsReason ?? "This version of the auto cannot be drawn."}
              </p>
            ) : (
              <FieldCanvas
                field={state.project.field}
                robot={state.project.robot}
                auto={state.auto}
                resolved={derived.resolved}
                plan={derived.plan}
                basePlan={model.basePlan}
                estimate={derived.estimate}
                findings={derived.findings}
                selection={state.selection}
                tool="select"
                alliance={state.alliance}
                waypoints={state.project.waypoints ?? null}
                snap={false}
                showGhosts={false}
                playbackS={state.playbackS ?? undefined}
                trace={state.trace}
                staticSvg={derived.staticSvg}
                onSelect={(selection) => {
                  selectStep(selection.stepId);
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

          <section
            className={appStyles.findings}
            style={{ height: `${String(state.prefs.findingsCollapsed ? 24 : state.prefs.findingsH)}px` }}
            data-region
            data-findings-panel
            tabIndex={-1}
            aria-label="Findings"
          >
            {state.prefs.findingsCollapsed ? (
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  setPrefs({ findingsCollapsed: false });
                }}
              >
                Show the findings
              </button>
            ) : (
              <FindingsPanel />
            )}
          </section>
        </main>

        <aside
          className={appStyles.right}
          style={{ width: `${String(state.prefs.panelRightW)}px` }}
          data-region
          tabIndex={-1}
          aria-label="Inspector"
        >
          <Panel label="Inspector" title="Inspector" help="inspector" testId="inspector-panel">
            <div className={styles.readOnly} data-testid="review-readonly">
              <p className={styles.warn}>
                Read only: this is someone&apos;s proposal, not your working copy.
              </p>
              <p>
                The dashed ghost is {review.baseRef}; the solid path is {review.headRef}. Comments
                and approval happen on GitHub, and merging is a human&apos;s.
              </p>
              <p>
                To edit this routine, leave review mode and open{" "}
                <code className="mono">{review.path}</code> on {review.headRef}.
              </p>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
