/**
 * The Code tab of the bottom panel (issue #102): the Java `zenith codegen` would write for the open
 * auto, read only, in mono with line numbers, updated on every edit, with Copy. The lines the
 * selected step wrote are highlighted, and clicking a step's line selects that step. Which lines
 * belong to which step comes from the generator itself (`codeView.ts`), never from reading the text.
 *
 * When there is no code, one line says why: the auto has errors, `zenith.json` cannot say where the
 * class goes, which is followed by the exact `codegen` JSON to add (issue #156), or it names no
 * command library, which points to Settings, Robot because Zenith
 * never picks one for a team. The tab shows with every feature switch off: an auto of paths alone
 * still has code.
 *
 * With no step selected the code starts at `buildRoutine()`, past the licence and the imports, and a
 * line that is only comment wraps at the panel's edge instead of running off it (issue #413).
 * Collapsed, the tab is its header alone. The header carries the Problems tab's severity counts, and
 * a click on one opens Problems.
 *
 * A switch in a row under the header picks the class (issues #534 and #535): Reference, the class the
 * robot does not run, which builds the same routine the runtime builds from the file, and Export, the
 * standalone OpMode `zenith codegen --export` writes for a team to paste in and own, which is not
 * recommended. A line beside the switch says which it is. Copy copies the class shown. The row stays
 * while Export is refused, so the switch is there to go back.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { CodegenForm } from "@horizon36596/zenith-core";
import { actionById } from "../app/actions";
import { useCopy } from "../app/copyText";
import { Segmented, type SegmentOption } from "../components/Segmented";
import { HelpTip } from "../help/HelpTip";
import { tokenizeJava, type JavaToken } from "../lib/javaTokens";
import { getState, selectStep, setStatus, useAllFindings, useDerived, useEditor } from "../state/store";
import { severityCounts } from "../state/derived";
import { errorsHidden, featureLabel, turnOnFeatures } from "../state/features";
import { codeViewOf, EXPORT_NOTE, linesOfStep, REFERENCE_NOTE, routineLine, stepAtLine } from "./codeView";
import { openBottomTab } from "./bottomTab";
import { SeverityCounts } from "./FindingsPanel";
import { problemsListed } from "./findingRows";
import styles from "./CodePanel.module.css";

/** The switch between the two classes, in the row under the header. */
const FORMS: ReadonlyArray<SegmentOption<CodegenForm>> = [
  {
    value: "reference",
    label: "Reference",
    does: "Show the class zenith codegen writes: the routine the robot builds from the auto file, as Java to read.",
  },
  {
    value: "export",
    label: "Export",
    does: "Show the OpMode zenith codegen --export writes: Java you paste in and own, which reads no auto file. Not recommended.",
  },
];

/** True for a line with a comment and nothing else, which wraps rather than scrolls. */
const onlyComment = (tokens: readonly JavaToken[]): boolean =>
  tokens.some((token) => token.kind === "comment") && tokens.every((token) => token.kind === "comment" || token.text.trim() === "");

export function CodePanel({ tabs, collapsed = false }: { tabs: ReactNode; collapsed?: boolean }) {
  const { auto, project, fileName, selection, prefs } = useEditor();
  const derived = useDerived();
  // Every finding, not only the shown ones: the CLI refuses an error in a hidden command step too.
  const findings = useAllFindings();
  const hidden = useMemo(() => errorsHidden(findings, auto, prefs.features), [findings, auto, prefs.features]);
  const hiddenErrors = hidden.hidden;
  const [form, setForm] = useState<CodegenForm>("reference");
  const view = useMemo(
    () =>
      auto === null || project === null
        ? null
        : codeViewOf({ link: project.link, fileName, auto, plan: derived.plan, findings, hiddenErrors, form }),
    [auto, project, fileName, derived.plan, findings, hiddenErrors, form],
  );
  // The header's counts are the Problems tab's, so a collapsed panel on this tab still says
  // something is wrong, and a click on one opens Problems.
  const counts = useMemo(() => severityCounts(problemsListed(derived.findings)), [derived.findings]);
  const text = view?.kind === "code" ? view.text : null;
  const tokenLines = useMemo(() => {
    if (text === null) return [];
    const lines = tokenizeJava(text);
    // The class ends with a newline; the empty line after it is not a line of code.
    if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
    return lines;
  }, [text]);
  const stepLines = view?.kind === "code" ? view.stepLines : null;
  // The step that wrote each line, by line number less one, for the click and the line's data-step.
  const owners = useMemo(
    () => tokenLines.map((_, index) => (stepLines === null ? null : stepAtLine(stepLines, index + 1))),
    [tokenLines, stepLines],
  );
  const selected = useMemo(
    () => linesOfStep(stepLines ?? [], selection.stepId),
    [stepLines, selection.stepId],
  );

  const { copy: copyCode, state: copyState, label: copyLabel } = useCopy();

  // A newly selected step's code is scrolled into view, inside the well only. Edits to the auto
  // leave the scroll where the person put it.
  const well = useRef<HTMLDivElement>(null);
  const hasCode = text !== null;
  useEffect(() => {
    const box = well.current;
    if (box === null || selection.stepId === undefined || stepLines === null) return;
    // The step's own method when it has one, which is more to read than its call in buildRoutine().
    const mine = stepLines.filter((range) => range.stepId === selection.stepId);
    const target = mine.find((range) => range.endLine > range.startLine) ?? mine[0];
    if (target === undefined) return;
    const first = box.querySelector<HTMLElement>(`[data-line="${String(target.startLine)}"]`);
    if (first === null) return;
    const top = first.offsetTop;
    const bottom = top + first.offsetHeight;
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
    // Only a change of step moves the scroll, never a change of text.
  },[selection.stepId, hasCode, collapsed]);

  // With no step selected the tab opens on buildRoutine(), where the routine reads from. Only the
  // code first showing, or a switch to the other class, does it, never an edit.
  const routine = text === null ? null : routineLine(text);
  useEffect(() => {
    const box = well.current;
    if (box === null || routine === null || getState().selection.stepId !== undefined) return;
    const line = box.querySelector<HTMLElement>(`[data-line="${String(routine)}"]`);
    if (line !== null) box.scrollTop = line.offsetTop;
    // The routine's line moves with every edit; only the code first showing, or the other class, scrolls to it.
  }, [hasCode, collapsed, form]);

  if (auto === null || view === null) return null;

  const copy = (): void => {
    if (text === null) return;
    void copyCode("the code", text, { select: well.current });
  };

  const gutter = String(tokenLines.length).length;

  return (
    <div className={styles.panel} data-testid="code-panel">
      <div className={styles.head}>
        {tabs}
        <HelpTip id="code" />
        <SeverityCounts
          counts={counts}
          pressed={null}
          testIdPrefix="code-count"
          hiddenErrors={hiddenErrors}
          ariaLabel="Problems by severity"
          labelOf={() => "Show the problems"}
          onPick={() => {
            openBottomTab("problems", counts.error + counts.warning > 0);
          }}
        />
        {view.kind === "code" ? (
          <span className={styles.meta}>
            <span className={styles.file} data-testid="code-file">
              {view.fileName}
            </span>
            <span className={styles.library} data-testid="code-library">
              {view.libraryLabel}
            </span>
          </span>
        ) : null}
        {view.kind === "code" ? (
          <button type="button" className={styles.copy} onClick={copy} data-testid="code-copy">
            {copyState === "copied" ? <Check size={16} strokeWidth={1.75} aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />}
            <span aria-live="polite">{copyLabel("Copy")}</span>
          </button>
        ) : null}
      </div>

      {collapsed || (view.kind === "blocked" && form === "reference") ? null : (
        <div className={styles.bar}>
          <Segmented label="Which class" options={FORMS} value={form} onChange={setForm} testId="code-form" />
          {view.kind === "code" ? (
            <p className={styles.note} data-form={view.form} data-testid="code-note">
              {view.form === "export" ? EXPORT_NOTE : REFERENCE_NOTE}
            </p>
          ) : null}
        </div>
      )}
      {collapsed ? null : view.kind === "blocked" ? (
        <>
          <p className={styles.blocked} data-testid="code-blocked">
            <span>{view.message}</span>
            {view.settings ? (
              <button
                type="button"
                className={styles.link}
                data-testid="code-open-settings"
                onClick={() => {
                  void actionById("project.commandLibrary")?.run();
                }}
              >
                Open Settings
              </button>
            ) : null}
            {view.errors === true ? (
              <button
                type="button"
                className={styles.link}
                data-testid="code-show-errors"
                onClick={() => {
                  openBottomTab("problems", true);
                }}
              >
                Show the errors
              </button>
            ) : null}
            {view.hiddenErrors === true ? (
              <button
                type="button"
                className={styles.link}
                data-testid="code-show-hidden-errors"
                onClick={() => {
                  // Problems lists none of these errors until the features that hide them are on.
                  const names = hidden.features.map(featureLabel).join(" and ");
                  turnOnFeatures(hidden.features);
                  setStatus("ok", `Turned on ${names} in Settings, General.`);
                }}
              >
                {hidden.features.length === 1 ? "Turn the feature on" : "Turn the features on"}
              </button>
            ) : null}
          </p>
          {view.json === undefined ? null : (
            <pre className={styles.blockedJson} data-testid="code-blocked-json">
              {view.json}
            </pre>
          )}
        </>
      ) : (
        <div
          ref={well}
          className={styles.well}
          role="region"
          aria-label={`Generated Java, ${view.fileName}`}
          // The well scrolls on its own, so a keyboard user can reach the code past the panel's edge.
          tabIndex={0}
          data-testid="code-view"
          style={{ "--gutter": `${String(gutter)}ch` } as CSSProperties}
          onClick={(event) => {
            const line = (event.target as HTMLElement).closest<HTMLElement>("[data-line]");
            const stepId = line === null ? null : (owners[Number(line.dataset["line"]) - 1] ?? null);
            // A click that ends a text selection is for copying, not for choosing a step.
            if (stepId === null || (window.getSelection()?.toString() ?? "") !== "") return;
            selectStep(stepId);
          }}
        >
          <div className={styles.lines}>
            {tokenLines.map((tokens, index) => {
              const line = index + 1;
              const owner = owners[index] ?? null;
              return (
                <div
                  key={line}
                  className={styles.line}
                  data-line={line}
                  data-step={owner ?? undefined}
                  data-selected={selected.has(line) ? "true" : undefined}
                  data-comment={onlyComment(tokens) ? "true" : undefined}
                  data-testid="code-line"
                >
                  <span className={styles.num} aria-hidden>
                    {line}
                  </span>
                  <span className={styles.text}>
                    {tokens.length === 0
                      ? " "
                      : tokens.map((token, at) =>
                          token.kind === "plain" ? (
                            token.text
                          ) : (
                            <span key={at} className={styles[token.kind]}>
                              {token.text}
                            </span>
                          ),
                        )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
