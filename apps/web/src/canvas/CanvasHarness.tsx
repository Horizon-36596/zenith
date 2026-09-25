/**
 * A dev-only page for the field canvas, served at `/canvas-dev.html`.
 *
 * It loads `examples/starter` straight from the repository, runs the real `resolve` / `plan` /
 * `estimate` / `check` pipeline and holds the document in local state, so the canvas can be worked
 * on and looked at on its own. Edits go through `core.edit`, which is what the shell calls too, so
 * a drag here exercises the same path a drag there does.
 *
 * It also shows how the shell is meant to wire the v2 props: `onDragPoses` as one edit per frame,
 * `onDragHeading` writing the full pose it is handed, `onSplitAt` through `applyFix`, a small
 * `canvasActions` table, `insertAnchorStepId`, the field view and field style, and Play/Pause.
 *
 * Nothing in this file is part of the editor. It is not in the production bundle because
 * `canvas-dev.html` is not a build input.
 */
import {
  addMarker,
  addSegment,
  addStep,
  applyFix,
  check,
  removeStep,
  estimate as computeEstimate,
  insertStepAfter,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan as buildPlan,
  resolve,
  setMarkerAt,
  setPose,
  type Estimate,
  type Finding,
  type TracePoseRow,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Auto } from "@horizon36596/zenith-schema";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import FieldCanvas from "./FieldCanvas.js";
import { readFieldImage } from "./fieldImage.js";
import type { Alliance, CanvasActions, CanvasHit, FieldView, PoseMove, Selection, Tool, TraceOverlay } from "./types.js";

import allStepKindsRaw from "../../../../examples/starter/autos/all-step-kinds.auto.json?raw";
import collectAndScoreRaw from "../../../../examples/starter/autos/collect-and-score.auto.json?raw";
import fieldRaw from "../../../../examples/starter/autos/field/biobuzz.field.json?raw";
import firstAutoRaw from "../../../../examples/starter/autos/first-auto.auto.json?raw";
import robotRaw from "../../../../examples/starter/autos/robot.json?raw";
import waypointsRaw from "../../../../examples/starter/autos/waypoints.json?raw";

const field = loadField(JSON.parse(fieldRaw) as unknown);
const robot = loadRobot(JSON.parse(robotRaw) as unknown);
const waypoints = loadWaypoints(JSON.parse(waypointsRaw) as unknown);
const season = resolveSeason(field).rules;
const AUTOS: Readonly<Record<string, Auto>> = {
  "collect-and-score": loadAuto(JSON.parse(collectAndScoreRaw) as unknown),
  "first-auto": loadAuto(JSON.parse(firstAutoRaw) as unknown),
  "all-step-kinds": loadAuto(JSON.parse(allStepKindsRaw) as unknown),
};
const STYLES = readFieldImage(field)?.variants.map((variant) => variant.name) ?? [];

const TOOLS: Array<{ tool: Tool; key: string }> = [
  { tool: "select", key: "v" },
  { tool: "addPath", key: "p" },
  { tool: "addCommand", key: "" },
  { tool: "marker", key: "" },
  { tool: "heading", key: "" },
  { tool: "measure", key: "u" },
  { tool: "pan", key: "h" },
];
const VIEWS: FieldView[] = ["image", "image+outlines", "vector"];

/**
 * `?repeat=n` stacks the routine on itself with suffixed step ids, which gives the drag budget
 * something twenty steps long to be measured on.
 */
function suffixIds(steps: Auto["steps"], suffix: string): Auto["steps"] {
  return steps.map((step) => {
    const next = { ...step, id: step.id === undefined ? undefined : `${step.id}${suffix}` };
    if (next.kind === "parallel") {
      return {
        ...next,
        steps: suffixIds(next.steps, suffix),
        deadline: next.deadline === undefined ? undefined : `${next.deadline}${suffix}`,
      };
    }
    if (next.kind === "sequence") return { ...next, steps: suffixIds(next.steps, suffix) };
    if (next.kind === "branch") {
      return {
        ...next,
        then: suffixIds(next.then, suffix),
        else: next.else === undefined ? undefined : suffixIds(next.else, suffix),
      };
    }
    return next;
  });
}

function repeatAuto(auto: Auto, times: number): Auto {
  if (times <= 1) return auto;
  const steps: Auto["steps"] = [];
  for (let round = 0; round < times; round += 1) {
    steps.push(...(round === 0 ? auto.steps : suffixIds(auto.steps, `-r${String(round)}`)));
  }
  return { ...auto, steps };
}

const REPEAT = Math.max(1, Number(new URLSearchParams(window.location.search).get("repeat") ?? "1"));

/**
 * `?trace=reset` draws a made-up recorded run whose localizer is re-seeded halfway, to look at the
 * gap the canvas leaves at a pose reset instead of a line across the field.
 */
function resetTrace(): TraceOverlay | null {
  if (new URLSearchParams(window.location.search).get("trace") !== "reset") return null;
  const poses: TracePoseRow[] = [];
  for (let i = 0; i <= 40; i += 1) poses.push([i * 0.02, -40 - i * 0.45, -63 + i * 0.95, Math.PI / 2]);
  for (let i = 0; i <= 40; i += 1) poses.push([0.82 + i * 0.02, 10 + i * 0.6, 20 + i * 0.3, 0]);
  return { poses, steps: [], tickS: 0.02 };
}
const RESET_TRACE = resetTrace();

const shell: CSSProperties = {
  display: "grid",
  gridTemplateRows: "var(--toolbar-h) 1fr var(--row-h)",
  height: "100vh",
  background: "var(--bg-app)",
  color: "var(--text-hi)",
  font: "var(--fs-sm)/var(--lh-sm) var(--font-ui)",
};

const bar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "0 var(--pad-panel)",
  background: "var(--bg-panel)",
  borderBottom: "1px solid var(--border-default)",
  overflowX: "auto",
};

const status: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "0 var(--pad-panel)",
  background: "var(--bg-panel)",
  borderTop: "1px solid var(--border-default)",
  font: "var(--fs-xs)/var(--lh-xs) var(--font-mono)",
  color: "var(--text-lo)",
};

const button = (active: boolean): CSSProperties => ({
  height: "var(--ctl-h-md)",
  padding: "0 var(--pad-control-x)",
  borderRadius: "var(--radius-xs)",
  border: `1px solid ${active ? "var(--border-strong)" : "var(--border-default)"}`,
  background: active ? "var(--bg-selected)" : "transparent",
  color: active ? "var(--text-hi)" : "var(--text-mid)",
  font: "var(--fs-xs)/var(--lh-xs) var(--font-ui)",
  cursor: "pointer",
  whiteSpace: "nowrap",
});

const divider = <span style={{ width: 1, height: 20, background: "var(--border-default)", flex: "none" }} />;

export function CanvasHarness(): ReactElement {
  const [autoName, setAutoName] = useState<keyof typeof AUTOS>("collect-and-score");
  const [auto, setAuto] = useState<Auto>(repeatAuto(AUTOS["collect-and-score"] as Auto, REPEAT));
  const [tool, setTool] = useState<Tool>("select");
  const [alliance, setAlliance] = useState<Alliance>("RED");
  const [snap, setSnap] = useState(true);
  const [fieldView, setFieldView] = useState<FieldView>("image+outlines");
  const [fieldStyle, setFieldStyle] = useState<string>(STYLES[0] ?? "dark");
  const [playing, setPlaying] = useState(false);
  const [playbackS, setPlaybackS] = useState(0);
  const [insertAfter, setInsertAfter] = useState(false);
  const [selection, setSelection] = useState<Selection>({});
  const [hover, setHover] = useState<CanvasHit | null>(null);
  const [note, setNote] = useState("Loaded examples/starter.");

  const resolved = useMemo(() => resolve(auto, waypoints), [auto]);
  const plan = useMemo(() => buildPlan(resolved, robot, field), [resolved]);
  const estimate = useMemo<Estimate | null>(() => {
    try {
      return computeEstimate(plan, robot);
    } catch {
      return null;
    }
  }, [plan]);
  const findings = useMemo<Finding[]>(() => check(plan, estimate, robot, field, season), [plan, estimate]);
  const totalS = estimate?.nominalS ?? 0;

  // The current document for callbacks fired between renders (a drag emits several per frame).
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const edit = (next: (current: Auto) => Auto): void => {
    try {
      const result = next(autoRef.current);
      autoRef.current = result;
      setAuto(result);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  // Play/Pause: the shell owns the clock; the canvas only draws the playbackS it is handed.
  useEffect(() => {
    if (!playing) return;
    let last: number | null = null;
    let frame = 0;
    const tick = (now: number): void => {
      if (last !== null) {
        setPlaybackS((value) => {
          const next = value + (now - last!) / 1000;
          return next > totalS ? 0 : next;
        });
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, totalS]);

  // A few shell keys the canvas does not own, so the harness can be driven from the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement) return;
      const key = event.key.toLowerCase();
      const match = TOOLS.find((entry) => entry.key !== "" && entry.key === key);
      if (match !== undefined) setTool(match.tool);
      else if (key === "s") setSnap((value) => !value);
      else if (key === " " && event.shiftKey) setPlaying((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const chooseAuto = (name: keyof typeof AUTOS): void => {
    setAutoName(name);
    const next = repeatAuto(AUTOS[name] as Auto, REPEAT);
    autoRef.current = next;
    setAuto(next);
    setSelection({});
    setPlaybackS(0);
  };

  const applyMoves = (moves: PoseMove[]): void => {
    edit((current) => moves.reduce((doc, move) => setPose(doc, move.stepId, move.target, move.pose), current));
  };

  const anchorStepId = insertAfter ? (selection.stepId ?? null) : null;

  const canvasActions: CanvasActions = (target) => {
    const stepId = target.stepId;
    const items = [];
    if (stepId !== undefined) {
      items.push({
        id: "step.insertAfter",
        label: "Insert path after this step",
        shortcut: "Enter",
        enabled: true,
        run: () => {
          setSelection({ stepId });
          setInsertAfter(true);
          setTool("addPath");
        },
      });
      items.push({
        id: "step.delete",
        label: "Delete step",
        shortcut: "Del",
        enabled: true,
        run: () => {
          edit((current) => removeStep(current, stepId));
          setSelection({});
        },
      });
    }
    if (target.kind === "field") {
      items.push({
        id: "field.addPath",
        label: "Add path point here",
        shortcut: "P",
        enabled: true,
        run: () => {
          setTool("addPath");
        },
      });
    }
    return items;
  };

  return (
    <div style={shell}>
      <div style={bar}>
        {(Object.keys(AUTOS) as Array<keyof typeof AUTOS>).map((name) => (
          <button key={name} style={button(name === autoName)} onClick={() => { chooseAuto(name); }}>
            {name}
          </button>
        ))}
        {divider}
        {TOOLS.map(({ tool: candidate, key }) => (
          <button
            key={candidate}
            data-tool={candidate}
            style={button(candidate === tool)}
            title={key === "" ? undefined : key.toUpperCase()}
            onClick={() => { setTool(candidate); }}
          >
            {candidate}
          </button>
        ))}
        {divider}
        <button style={button(snap)} onClick={() => { setSnap(!snap); }}>
          snap
        </button>
        <button style={button(insertAfter)} onClick={() => { setInsertAfter(!insertAfter); }}>
          insert after selected
        </button>
        <button style={button(alliance === "BLUE")} onClick={() => { setAlliance(alliance === "RED" ? "BLUE" : "RED"); }}>
          {alliance}
        </button>
        {divider}
        {VIEWS.map((view) => (
          <button key={view} data-view={view} style={button(view === fieldView)} onClick={() => { setFieldView(view); }}>
            {view}
          </button>
        ))}
        {STYLES.map((name) => (
          <button key={name} data-style={name} style={button(name === fieldStyle)} onClick={() => { setFieldStyle(name); }}>
            {name}
          </button>
        ))}
        {divider}
        <input
          type="range"
          min={0}
          max={Math.max(totalS, 0.1)}
          step={0.01}
          value={playbackS}
          onChange={(event) => { setPlaybackS(Number(event.target.value)); }}
          style={{ width: 180, flex: "none" }}
          aria-label="Playback time"
        />
        <span style={{ font: "var(--fs-xs)/var(--lh-xs) var(--font-mono)", color: "var(--text-lo)" }}>
          {playbackS.toFixed(2)} s
        </span>
      </div>

      <FieldCanvas
        field={field}
        robot={robot}
        auto={auto}
        resolved={resolved}
        plan={plan}
        estimate={estimate}
        findings={findings}
        waypoints={waypoints}
        selection={selection}
        tool={tool}
        alliance={alliance}
        snap={snap}
        showGhosts={false}
        trace={RESET_TRACE}
        playbackS={playbackS}
        playing={playing}
        onTogglePlay={() => { setPlaying((value) => !value); }}
        fieldView={fieldView}
        fieldImageVariant={fieldStyle}
        insertAnchorStepId={anchorStepId}
        canvasActions={canvasActions}
        onSelect={setSelection}
        onHover={setHover}
        onDragStart={() => undefined}
        onDragEnd={() => undefined}
        onDragPose={(stepId, target, pose) => {
          applyMoves([{ stepId, target, pose }]);
        }}
        onDragPoses={applyMoves}
        onDragHeading={(stepId, target, _headingRad, pose) => {
          applyMoves([{ stepId, target, pose }]);
        }}
        onSplitAt={(stepId, _t, at) => {
          edit((current) =>
            applyFix(current, {
              kind: "splitSegment",
              stepId,
              label: "Split here",
              params: { segmentIndex: at.segmentIndex, u: at.u },
            }),
          );
          setNote(`Split ${stepId} segment ${String(at.segmentIndex)} at u ${at.u.toFixed(3)}.`);
        }}
        onAddPathPoint={(pose) => {
          if (anchorStepId !== null) {
            try {
              const result = insertStepAfter(
                autoRef.current,
                anchorStepId,
                { kind: "path", segments: [{ kind: "line", from: "current", to: pose }], heading: { mode: "tangent" } },
                waypoints,
              );
              autoRef.current = result.auto;
              setAuto(result.auto);
              setSelection({ stepId: result.id });
              setNote(`Inserted ${result.id} after ${anchorStepId}.`);
            } catch (error) {
              setNote(error instanceof Error ? error.message : String(error));
            }
            return;
          }
          const last = [...plan.steps].reverse().find((step) => step.kind === "path");
          if (last === undefined) {
            edit((current) =>
              addStep(current, {
                kind: "path",
                segments: [{ kind: "line", from: "current", to: pose }],
                heading: { mode: "tangent" },
              }),
            );
            return;
          }
          edit((current) => addSegment(current, last.id, { kind: "line", from: "current", to: pose }));
        }}
        onAddMarker={(stepId, t) => {
          edit((current) =>
            addMarker(current, stepId, {
              at: { t },
              command: { name: "intakeOn" },
            }),
          );
        }}
        onDragMarker={(stepId, markerIndex, t) => {
          edit((current) => setMarkerAt(current, stepId, markerIndex, { t }));
        }}
        onAddCommandAt={(pose) => {
          setNote(`addCommand at ${pose.xIn.toFixed(2)}, ${pose.yIn.toFixed(2)} in: the shell opens the picker here.`);
        }}
      />

      <div style={status}>
        <span>
          {findings.filter((finding) => finding.severity === "error").length} errors ·{" "}
          {findings.filter((finding) => finding.severity === "warning").length} warnings
        </span>
        <span>{estimate === null ? "no estimate" : `${estimate.nominalS?.toFixed(2) ?? "?"} s`}</span>
        <span>selected {selection.stepId ?? "—"}{selection.points === undefined ? "" : ` +${String(selection.points.length - 1)}`}</span>
        <span>hover {hover?.stepId ?? "—"}</span>
        <span data-testid="harness-note">{note}</span>
      </div>
    </div>
  );
}

export default CanvasHarness;
