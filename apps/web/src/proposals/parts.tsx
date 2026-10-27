/**
 * The pieces the proposer's editor and the owner's review share: a group of findings in the
 * findings panel's row language (UI_GUIDE section 9.7), the keyboard guard that keeps the editor's
 * own shortcuts off the auto while one of them is open, and the small formatters.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Info, OctagonAlert, Pause, Play, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Finding, Severity } from "@horizon36596/zenith-core";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { advancePlayhead, type PlayClock } from "../panels/playClock";
import { HelpTip } from "../help/HelpTip";
import { findingHelp, type PanelHelpId } from "../help/content";
import findingStyles from "../panels/FindingsPanel.module.css";
import styles from "./proposals.module.css";

const SEVERITY_ICON: Record<Severity, LucideIcon> = { error: OctagonAlert, warning: TriangleAlert, info: Info };

/** One group of findings: a title, its `?`, a note, and the rows, worst first. */
export function FindingGroup({
  title,
  help,
  note,
  findings,
  empty,
  testId,
  onPick,
  time,
}: {
  title: string;
  help?: PanelHelpId;
  note?: ReactNode;
  findings: readonly Finding[];
  empty: string;
  testId: string;
  onPick?: (finding: Finding) => void;
  /** Shows each finding's time, for the predicted alliance findings. */
  time?: boolean;
}) {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const rows = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || (a.timeS ?? 0) - (b.timeS ?? 0));
  return (
    <section className={styles.group} aria-label={title} data-testid={testId}>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle}>{title}</h3>
        {help === undefined ? null : <HelpTip id={help} />}
        {note === undefined ? null : <span className={styles.groupNote}>{note}</span>}
      </div>
      <div role="list">
        {rows.length === 0 ? (
          <p className={findingStyles.empty} data-testid={`${testId}-empty`}>
            {empty}
          </p>
        ) : (
          rows.map((finding, index) => {
            const Icon = SEVERITY_ICON[finding.severity];
            const helpLine = findingHelp(finding.code, finding.severity);
            return (
              <div
                key={`${finding.code}-${String(index)}`}
                role="listitem"
                className={findingStyles.row}
                data-severity={finding.severity}
                data-code={finding.code}
                data-testid={`${testId}-row`}
              >
                <Icon className={findingStyles.icon} size={16} strokeWidth={1.75} aria-label={finding.severity} />
                <div className={styles.rowBody}>
                  <button
                    type="button"
                    className={findingStyles.message}
                    onClick={() => {
                      onPick?.(finding);
                    }}
                  >
                    <span>{finding.message}</span>
                  </button>
                </div>
                <Tooltip
                  label={helpLine?.title ?? finding.code}
                  hint={helpLine === null ? undefined : `${helpLine.means} How to fix: ${helpLine.fix}`}
                >
                  <span className={findingStyles.code} tabIndex={0}>
                    {finding.code}
                  </span>
                </Tooltip>
                {time === true ? <span className={styles.mono}>{`${(finding.timeS ?? 0).toFixed(1)} s`}</span> : <span aria-hidden />}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** True when the keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * While a proposal is open, the editor's own shortcuts must not reach the auto behind it: Delete
 * would delete a step of the user's own auto, the arrows would nudge one of its points. This catches
 * every key before the editor's handler does and lets through only what `handle` does not claim
 * and `passes` allows: Escape, the function keys, the palette and the shortcut sheet by default.
 * Typing into a field is never touched.
 */
export function useKeyGuard(handle: (event: KeyboardEvent) => boolean, passes: (event: KeyboardEvent) => boolean = defaultPass): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return;
      if (handle(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (passes(event)) return;
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [handle, passes]);
}

/** The editor keys that stay live while a proposal is open: Escape, F-keys, the palette and `?`. */
export function defaultPass(event: KeyboardEvent): boolean {
  if (event.key === "Escape" || /^F\d+$/.test(event.key) || event.key === "?") return true;
  const chord = event.ctrlKey || event.metaKey;
  return chord && (event.key === "k" || event.key === "K");
}

/** `+1.4 s`, `−0.6 s`, or a dash when there is nothing to compare. */
export function deltaText(deltaS: number | null): string {
  if (deltaS === null) return "—";
  if (Math.abs(deltaS) < 0.05) return "0.0 s";
  return `${deltaS > 0 ? "+" : "−"}${Math.abs(deltaS).toFixed(1)} s`;
}

export const deltaSign = (deltaS: number | null): string =>
  deltaS === null || Math.abs(deltaS) < 0.05 ? "same" : deltaS > 0 ? "slower" : "faster";

export const secondsText = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)} s`);

/** A text button with a tooltip; disabled ones stay focusable and say why. */
export function TextAction({
  children,
  label,
  hint,
  disabledReason,
  onClick,
  testId,
  kind = "text",
}: {
  children: ReactNode;
  label: string;
  hint: string;
  disabledReason?: string | null;
  onClick: () => void;
  testId: string;
  kind?: "text" | "primary" | "secondary";
}) {
  const disabled = disabledReason !== undefined && disabledReason !== null;
  const className = kind === "primary" ? styles.primary : kind === "secondary" ? styles.secondary : styles.textButton;
  return (
    <Tooltip label={label} hint={disabled ? `Unavailable: ${disabledReason}` : hint}>
      <button
        type="button"
        className={className}
        aria-disabled={disabled ? true : undefined}
        data-testid={testId}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * A scrubber row with Play: the alliance clock both robots are drawn on. Playback advances by the
 * wall time between animation frames (`playClock.ts`), and the loop starts once per press of Play.
 */
export function Scrubber({
  playbackS,
  playing,
  runS,
  onPlayback,
  onPlaying,
  testId,
}: {
  playbackS: number;
  playing: boolean;
  runS: number;
  onPlayback: (seconds: number) => void;
  onPlaying: (playing: boolean) => void;
  testId: string;
}) {
  const runRef = useRef(runS);
  runRef.current = runS;
  const startRef = useRef(playbackS);
  startRef.current = playbackS;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let clock: PlayClock = { lastMs: null };
    let at = startRef.current >= runRef.current - 1e-3 ? 0 : startRef.current;
    const tick = (now: number) => {
      const advanced = advancePlayhead(clock, at, now);
      clock = advanced.clock;
      at = advanced.playheadS;
      if (at >= runRef.current) {
        onPlayback(runRef.current);
        onPlaying(false);
        return;
      }
      onPlayback(at);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing, onPlayback, onPlaying]);
  return (
    <div className={styles.scrub} data-testid={`${testId}-scrub`}>
      <RowButton
        icon={playing ? Pause : Play}
        label={playing ? "Pause" : "Play both robots"}
        hint="Plays your robot and the partner's on one alliance clock."
        onClick={() => {
          onPlaying(!playing);
        }}
        testId={`${testId}-play`}
      />
      <input
        type="range"
        min={0}
        max={Math.max(runS, 0.1)}
        step={0.05}
        value={Math.min(playbackS, Math.max(runS, 0.1))}
        aria-label="Alliance clock"
        data-testid={`${testId}-playback`}
        onChange={(event) => {
          onPlaying(false);
          onPlayback(Number(event.target.value));
        }}
      />
      <span className={styles.mono}>{`${playbackS.toFixed(2)} s`}</span>
    </div>
  );
}
