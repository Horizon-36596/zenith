/**
 * "See it as they will" (spec 13 section 8.4): the projection a share
 * sends, shown the way the other team will get it. A read-only field draws the one bounding box
 * moving along the projected trajectory, with its own play and scrub control; under it are the
 * phases as a strip, the field elements it claims, the envelopes, and at the propose level the
 * structure, named only by opaque ids and tokens. When the sharer included command names, each
 * command reads by its real name and settings instead, and the commands are listed with when they
 * ran. "Show the exact data" opens the canonical text that is sent, with its size.
 *
 * Everything drawn here is read from the projection itself, never from the auto, so nothing can
 * appear here that the other team would not get. The field is the public season field.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { fieldBounds } from "@horizon36596/zenith-core";
import type { Field, Projection } from "@horizon36596/zenith-schema";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { drawStatic } from "../canvas/staticLayer";
import { fallbackTheme, observeTheme, readTheme, withAlpha, type CanvasTheme } from "../canvas/theme";
import { fitView, orientationFor, worldToScreen, type AudienceAt, type View } from "../canvas/view";
import { advancePlayhead, type PlayClock } from "../panels/playClock";
import {
  boxCornersAt,
  claimPointIn,
  kilobytes,
  namedCommandWords,
  PHASE_WORDS,
  phaseAt,
  projectionEndS,
  projectionPoseAt,
  structureRows,
} from "./projectionModel";
import { useSelector, type State } from "../state/store";
import styles from "./cloud.module.css";

const secondsText = (value: number): string => `${value.toFixed(1)} s`;

export function ProjectionPreview({
  projection,
  canonical,
  bytes,
  field,
}: {
  projection: Projection;
  canonical: string;
  bytes: number;
  field: Field;
}) {
  const endS = projectionEndS(projection);
  const [atS, setAtS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const atRef = useRef(atS);
  atRef.current = atS;
  const scrubId = useId();

  // A new projection (another level, Coarsen, an edit) keeps the playhead where it can.
  useEffect(() => {
    if (atRef.current > endS) setAtS(endS);
  }, [endS]);

  useEffect(() => {
    if (!playing) return;
    let clock: PlayClock = { lastMs: null };
    let frame = 0;
    const tick = (nowMs: number): void => {
      const next = advancePlayhead(clock, atRef.current, nowMs);
      clock = next.clock;
      if (next.playheadS >= endS) {
        setAtS(endS);
        setPlaying(false);
        return;
      }
      setAtS(next.playheadS);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [playing, endS]);

  const phase = phaseAt(projection, atS);
  const rows = structureRows(projection);
  const pose = projectionPoseAt(projection, atS);

  return (
    <div className={styles.projection} data-testid="share-projection" data-level={projection.level}>
      {projection.title === undefined ? null : (
        <p className={styles.hint} data-testid="share-projection-title">
          Named “{projection.title}”
        </p>
      )}
      <PreviewField projection={projection} field={field} atS={atS} />

      <div className={styles.player}>
        <RowButton
          icon={playing ? Pause : Play}
          label={playing ? "Pause" : "Play"}
          hint="Play what they will see, one second of the auto per second."
          onClick={() => {
            if (!playing && atRef.current >= endS) setAtS(0);
            setPlaying(!playing);
          }}
          testId="share-preview-play"
        />
        <input
          id={scrubId}
          type="range"
          className={styles.scrub}
          min={0}
          max={endS}
          step={0.1}
          value={atS}
          aria-label="Time in their view"
          aria-valuetext={secondsText(atS)}
          data-testid="share-preview-scrub"
          onChange={(event) => {
            setPlaying(false);
            setAtS(Number(event.target.value));
          }}
        />
        <span
          className={styles.mono}
          data-testid="share-preview-time"
          data-at-s={atS.toFixed(2)}
          data-x-in={pose.xIn.toFixed(1)}
          data-y-in={pose.yIn.toFixed(1)}
        >
          {secondsText(atS)} of {secondsText(endS)}
        </span>
      </div>

      <PhaseStrip projection={projection} atS={atS} endS={endS} />
      <p className={styles.hint} data-testid="share-preview-phase">
        {phase === null ? "Between phases." : `${PHASE_WORDS[phase]} at this moment.`}
      </p>

      <div className={styles.facts}>
        <h4 className={styles.factsHead}>Field elements they will see you claim</h4>
        {projection.claims.length === 0 ? (
          <p className={styles.hint}>None.</p>
        ) : (
          <ul className={styles.factList} data-testid="share-preview-claims">
            {projection.claims.map((claim, index) => (
              <li key={`${claim.elementId}-${String(index)}`} className={styles.fact}>
                <span className={styles.mono}>{secondsText(claim.atS)}</span>
                <span>{claim.action === "take" ? "Takes from" : "Scores into"}</span>
                <span className={styles.mono}>{claim.elementId}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.facts}>
        <Tooltip label="Envelopes" hint="The area a step promises to stay inside." delay="long">
          <h4 className={styles.factsHead}>Envelopes</h4>
        </Tooltip>
        {projection.envelopes.length === 0 ? (
          <p className={styles.hint}>None.</p>
        ) : (
          <ul className={styles.factList} data-testid="share-preview-envelopes">
            {projection.envelopes.map((envelope, index) => (
              <li key={String(index)} className={styles.fact}>
                <span className={styles.mono}>
                  {secondsText(envelope.startS)} to {secondsText(envelope.endS)}
                </span>
                <span>
                  inside an area with {envelope.polygon.length} corners
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {projection.commands === undefined ? null : (
        <div className={styles.facts}>
          <Tooltip label="Commands, by name" hint="Each command's name and settings. Never the code behind it." delay="long">
            <h4 className={styles.factsHead}>Commands, by name</h4>
          </Tooltip>
          {projection.commands.length === 0 ? (
            <p className={styles.hint}>None.</p>
          ) : (
            <ul className={styles.factList} data-testid="share-preview-commands">
              {projection.commands.map((entry) => (
                <li key={entry.token} className={styles.fact}>
                  <span className={styles.mono}>{entry.startS === undefined ? "not run" : secondsText(entry.startS)}</span>
                  <span>{entry.kind === "marker" ? "During a path" : "Runs"}</span>
                  <span className={styles.mono}>{namedCommandWords(entry)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {projection.level === "propose" ? (
        <div className={styles.facts}>
          <h4 className={styles.factsHead}>The shape of your steps</h4>
          <p className={styles.hint}>
            {projection.commands === undefined
              ? "Steps and commands show stand-in names."
              : "Steps show stand-in names; commands show their real names."}
          </p>
          <ol className={styles.structure} data-testid="share-preview-structure">
            {rows.map((row, index) => (
              <li
                key={`${row.id}-${String(index)}`}
                className={styles.structureRow}
                style={{ paddingLeft: `calc(var(--space-4) * ${String(row.depth)})` }}
                data-kind={row.kind}
              >
                <span className={styles.mono}>{row.id}</span>
                {row.kind === "arm" ? null : <span className={styles.structureKind}>{row.kind}</span>}
                {row.words === "" ? null : <span className={styles.structureWords}>{row.words}</span>}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <details className={styles.exact} data-testid="share-preview-exact">
        <summary className={styles.exactSummary}>
          Show the exact data <span className={styles.mono}>({kilobytes(bytes)})</span>
        </summary>
        <pre className={styles.preview} data-testid="share-preview-json">
          {canonical}
        </pre>
      </details>
    </div>
  );
}

/** The phases, laid along the auto's time, with a line where the playhead is. */
function PhaseStrip({ projection, atS, endS }: { projection: Projection; atS: number; endS: number }) {
  const span = Math.max(endS, 1e-6);
  const labels = [...new Set(projection.phases.map((phase) => phase.label))];
  return (
    <div className={styles.phases}>
      <div className={styles.phaseStrip} role="img" aria-label={phaseSummary(projection)} data-testid="share-preview-phases">
        {projection.phases.map((phase, index) => (
          <span
            key={String(index)}
            className={styles.phase}
            data-label={phase.label}
            style={{
              left: `${String((phase.startS / span) * 100)}%`,
              width: `${String(((phase.endS - phase.startS) / span) * 100)}%`,
            }}
          />
        ))}
        <span className={styles.phaseHead} style={{ left: `${String((atS / span) * 100)}%` }} aria-hidden />
      </div>
      <ul className={styles.phaseLegend} aria-hidden>
        {labels.map((label) => (
          <li key={label} className={styles.phaseKey}>
            <span className={styles.phaseSwatch} data-label={label} />
            {PHASE_WORDS[label]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function phaseSummary(projection: Projection): string {
  if (projection.phases.length === 0) return "No phases.";
  return projection.phases
    .map((phase) => `${PHASE_WORDS[phase.label]} from ${secondsText(phase.startS)} to ${secondsText(phase.endS)}`)
    .join(", ");
}

const selectFieldGrid = (value: State): State["prefs"]["fieldGrid"] => value.prefs.fieldGrid;

/** The read-only field: the public field, the trajectory, the envelopes, the claims and the box. */
function PreviewField({ projection, field, atS }: { projection: Projection; field: Field; atS: number }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  const [theme, setTheme] = useState<CanvasTheme>(fallbackTheme);
  const fieldGrid = useSelector(selectFieldGrid);

  useEffect(() => {
    const root = document.documentElement;
    setTheme(readTheme(root));
    return observeTheme(root, () => {
      setTheme(readTheme(root));
    });
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    setWidthPx(wrap.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidthPx(wrap.clientWidth);
    });
    observer.observe(wrap);
    return () => {
      observer.disconnect();
    };
  }, []);

  const bounds = useMemo(() => fieldBounds(field), [field]);
  const orientation = orientationFor((field.frame.view?.audienceAt ?? "bottom") as AudienceAt);
  const aspect = (bounds.maxYIn - bounds.minYIn) / Math.max(bounds.maxXIn - bounds.minXIn, 1e-6);
  const heightPx = Math.round(widthPx * (Math.abs(orientation.xAxis.xPx) === 1 ? aspect : 1 / aspect));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || widthPx <= 0 || heightPx <= 0) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(widthPx * scale);
    canvas.height = Math.round(heightPx * scale);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const view = fitView(bounds, widthPx, heightPx, 6, orientation);
    // Obstacles are drawn as walls: the other team's own robot decides what it can pass under.
    drawStatic(ctx, { field, waypoints: null, robotHeightIn: Number.POSITIVE_INFINITY, view, theme, widthPx, heightPx, fieldGrid });
    drawProjection(ctx, view, theme, field, projection, atS);
  }, [projection, field, atS, theme, widthPx, heightPx, bounds, orientation, fieldGrid]);

  return (
    <div ref={wrapRef} className={styles.previewField}>
      <canvas
        ref={canvasRef}
        className={styles.previewCanvas}
        style={{ width: `${String(widthPx)}px`, height: `${String(heightPx)}px` }}
        role="img"
        aria-label="Their view of the field: your robot's box moving along the path they receive."
        data-testid="share-preview-field"
      />
    </div>
  );
}

function tracePolygon(ctx: CanvasRenderingContext2D, view: View, points: ReadonlyArray<{ xIn: number; yIn: number }>): void {
  ctx.beginPath();
  points.forEach((point, index) => {
    const screen = worldToScreen(view, point);
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  });
  ctx.closePath();
}

function drawProjection(
  ctx: CanvasRenderingContext2D,
  view: View,
  theme: CanvasTheme,
  field: Field,
  projection: Projection,
  atS: number,
): void {
  // Envelopes: dashed outlines, filled faintly while they are in force.
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const envelope of projection.envelopes) {
    tracePolygon(ctx, view, envelope.polygon);
    if (atS >= envelope.startS && atS <= envelope.endS) {
      ctx.fillStyle = withAlpha(theme.canvasAnnotation, 0.12);
      ctx.fill();
    }
    ctx.strokeStyle = theme.canvasAnnotation;
    ctx.stroke();
  }
  ctx.restore();

  // The trajectory they receive, row by row.
  ctx.beginPath();
  projection.trajectory.poses.forEach(([xIn, yIn], index) => {
    const screen = worldToScreen(view, { xIn, yIn });
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  });
  ctx.strokeStyle = theme.pathEstimated;
  ctx.lineWidth = theme.pathWidthNormalPx;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Claims: a ring on each claimed element, filled once the claim has happened.
  for (const claim of projection.claims) {
    const point = claimPointIn(field, claim.elementId);
    if (point === null) continue;
    const screen = worldToScreen(view, point);
    ctx.beginPath();
    ctx.arc(screen.xPx, screen.yPx, 5, 0, Math.PI * 2);
    const colour = claim.action === "score" ? theme.fieldTarget : theme.fieldElement;
    if (atS >= claim.atS) {
      ctx.fillStyle = withAlpha(colour, 0.5);
      ctx.fill();
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // The one box, where the playhead is, with a tick for the heading.
  const pose = projectionPoseAt(projection, atS);
  tracePolygon(ctx, view, boxCornersAt(projection, pose));
  ctx.fillStyle = theme.robotOutlineFill;
  ctx.fill();
  ctx.strokeStyle = theme.robotOutline;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const centre = worldToScreen(view, pose);
  const reachIn = projection.boundingBox.lengthIn / 2;
  const nose = worldToScreen(view, {
    xIn: pose.xIn + Math.cos(pose.headingRad) * reachIn,
    yIn: pose.yIn + Math.sin(pose.headingRad) * reachIn,
  });
  ctx.beginPath();
  ctx.moveTo(centre.xPx, centre.yPx);
  ctx.lineTo(nose.xPx, nose.yPx);
  ctx.stroke();
}
