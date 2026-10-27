/**
 * The tour's visuals (UI_GUIDE section 10): a ring round the stop's anchor, a coach-mark card
 * beside it, the choice card after the core tour, and the closing card after the full one. What to
 * show is entirely `model.ts`'s state; this file only draws it and turns clicks and keys into events.
 *
 * The tour is non-modal (UI_GUIDE section 10.1). Nothing it draws takes a
 * pointer event except its cards, it takes keys only while focus is in a card, and the coach mark
 * keeps off the anchor and off every open menu, tooltip and dialog (`placement.ts`), so every
 * control in the app works exactly as it does with the tour closed.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { TOUR_REVEAL_EVENT } from "./signals";
import { Check, MapPlus, MousePointer2 } from "lucide-react";
import { indexSteps } from "../lib/stepOps";
import type { Heading, Step } from "@horizon36596/zenith-schema";
import { isDesktop } from "../project/desktop";
import { getState, selectStep, setDialog, setPaletteOpen, setSelection, useSelector } from "../state/store";
import { anyMenuOpen, closeMenus, openInsertMenu } from "../state/ui";
import { currentStop, withinStops, type TourPrepare, type TourStop } from "./model";
import { placeCard, type Box, type Placement } from "./placement";
import { getFeatures, useFeatures } from "../state/features";
import { chosenPresetName } from "../settings/presets";
import { useUserPresets } from "../settings/presetStore";
import { currentTourStops } from "./stops";
import { dispatchTour, isTaskDone, useTour } from "./store";
import styles from "./Tour.module.css";

type Rect = Box;

/** `--tour-cutout-pad`: the ring's distance from the anchor. */
const CUTOUT_PAD = 8;
/** `--tour-card-w`, and the narrowest the coach mark gets to keep clear of a big anchor. */
const CARD_WIDTH = 340;
const CARD_MIN_WIDTH = 260;

/**
 * The popovers the coach mark keeps off: menus (Insert, help, right-click), tooltips (every `?`
 * and every control's), listboxes, and dialogs such as the palette. The tour's own cards are
 * dialogs too, so anything inside the tour layer is left out.
 */
const POPOVER_SELECTOR = '[role="menu"], [role="tooltip"], [role="listbox"], [role="dialog"]';

const boxOf = (element: Element): Box => {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
};

/**
 * Every open popover, and the trigger of every open tooltip. The trigger matters as much as the
 * bubble: a card that moved on top of the control under the pointer would take the hover from it,
 * and the tooltip would close with the card still in the way.
 */
function openPopovers(): Box[] {
  const boxes: Box[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(POPOVER_SELECTOR)) {
    if (element.closest("[data-tour-layer]") !== null) continue;
    const box = boxOf(element);
    if (box.width === 0 || box.height === 0) continue;
    // A tooltip renders hidden while it measures itself; its box is not where it will show.
    if (getComputedStyle(element).visibility === "hidden") continue;
    boxes.push(box);
    if (element.getAttribute("role") === "tooltip" && element.id !== "") {
      for (const trigger of document.querySelectorAll(`[aria-describedby~="${CSS.escape(element.id)}"]`)) {
        const at = boxOf(trigger);
        if (at.width > 0 && at.height > 0) boxes.push(at);
      }
    }
  }
  return boxes;
}

/** The stop's anchor measured now, grown by the cut-out pad: the ring's box without waiting for a render. */
function ringBox(anchor: string | null): Box | null {
  const element = anchorElement(anchor);
  if (element === null) return null;
  const box = boxOf(element);
  if (box.width === 0) return null;
  return {
    left: box.left - CUTOUT_PAD,
    top: box.top - CUTOUT_PAD,
    width: box.width + CUTOUT_PAD * 2,
    height: box.height + CUTOUT_PAD * 2,
  };
}

/** The boxes of a stop's `keepClear` anchors: where its task happens, when that is not its anchor. */
function keepClearBoxes(anchors: readonly string[] | undefined): Box[] {
  const boxes: Box[] = [];
  for (const anchor of anchors ?? []) {
    const box = anchorElement(anchor)?.getBoundingClientRect();
    if (box !== undefined && box.width > 0) boxes.push({ left: box.left, top: box.top, width: box.width, height: box.height });
  }
  return boxes;
}

function prepare(kind: TourPrepare | undefined): void {
  if (kind === undefined) return;
  const { auto, selection } = getState();
  if (kind === "closeMenus") {
    closeMenus();
    if (getState().paletteOpen) setPaletteOpen(false);
    if (getState().dialog !== null) setDialog(null);
  }
  if (kind === "openInsertMenu") openInsertMenu();
  if (kind === "selectNothing") selectStep(undefined);
  if (kind in PATH_WANTED && auto !== null) {
    const steps = indexSteps(auto);
    const asked = PATH_WANTED[kind as PathPick];
    // With Advanced heading off, a piecewise path's inspector says it was made with a switch the
    // settings turn off, which is not what a stop is about: such a path is picked only when no other
    // path will do (0.1.2 UX sweep, W1-6).
    const advanced = getFeatures().advancedHeading;
    const plain = (step: Step): boolean => asked(step) && (advanced || step.kind !== "path" || step.heading?.mode !== "piecewise");
    const wanted = steps.some((entry) => plain(entry.step)) ? plain : asked;
    const current = selection.stepId === undefined ? undefined : steps.find((entry) => entry.id === selection.stepId);
    const pick =
      current !== undefined && wanted(current.step)
        ? current
        : (steps.find((entry) => wanted(entry.step)) ?? steps.find((entry) => entry.step.kind === "path"));
    if (pick === undefined) return;
    if (pick !== current) selectStep(pick.id);
    if (kind === "selectPathWithPose") showControlChip(pick.id, pick.step);
  }
}

/**
 * A curve's control point shows its provenance chip only while it is the selected point (issue
 * #409), so a path whose only numbers are control points gets its first one selected for the
 * provenance stop.
 */
function showControlChip(stepId: string, step: Step): void {
  if (step.kind !== "path") return;
  if (step.segments.some((segment) => isLiteralPose(segment.from) || isLiteralPose(segment.to))) return;
  const segmentIndex = step.segments.findIndex((segment) => segment.kind === "bezier" && segment.control.length > 0);
  if (segmentIndex < 0) return;
  setSelection({ stepId, point: { segmentIndex, pointKind: "control", controlIndex: 0 } });
}

/** A pose written out in numbers, rather than a waypoint reference or "current". */
const isLiteralPose = (source: unknown): boolean =>
  typeof source === "object" && source !== null && "xIn" in source;

/** A heading whose arrows on the canvas can be dragged: Constant and Linear, alone or as a range. */
const hasDraggableArrows = (heading: Heading | undefined): boolean => {
  if (heading === undefined) return false;
  if (heading.mode === "constant" || heading.mode === "linear") return true;
  if (heading.mode === "piecewise") return heading.ranges.some((range) => hasDraggableArrows(range.heading));
  return false;
};

type PathPick = "selectFirstPath" | "selectPathWithMarker" | "selectPathWithPose" | "selectPathWithHeadingArrows";

/** Which path each select-a-path preparation looks for. */
const PATH_WANTED: Record<PathPick, (step: Step) => boolean> = {
  selectPathWithHeadingArrows: (step) => step.kind === "path" && hasDraggableArrows(step.heading),
  selectFirstPath: (step) => step.kind === "path",
  selectPathWithMarker: (step) => step.kind === "path" && (step.markers ?? []).length > 0,
  selectPathWithPose: (step) =>
    step.kind === "path" &&
    step.segments.some(
      (segment) =>
        isLiteralPose(segment.from) ||
        isLiteralPose(segment.to) ||
        (segment.kind === "bezier" && segment.control.length > 0),
    ),
};

/**
 * The stop's anchor, or, in a window too narrow for its toolbar group, the More button that holds it
 * (`data-tour-holds`), so the stop still rings where the button is.
 */
const anchorElement = (anchor: string | null): HTMLElement | null =>
  anchor === null
    ? null
    : (document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(anchor)}"]`) ??
      document.querySelector<HTMLElement>(`[data-tour-holds~="${CSS.escape(anchor)}"]`));

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

/** The nearest ancestor of `element` that scrolls it up and down, or null. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/** Whether `element` shows whole inside `scroller`'s visible box. */
function wholeIn(element: HTMLElement, scroller: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.top >= view.top - 0.5 && box.bottom <= view.bottom + 0.5;
}

/**
 * Brings the selected step's row whole into the steps list before the stop's anchor is revealed
 * (0.1.2 UX sweep, W1-5): a stop that selects a step, or the anchor's own reveal, left the row half
 * under the list's top edge. The anchor is scrolled to after this, so it wins when the list cannot
 * show both; then a row it would cut in half is scrolled the rest of the way out instead.
 */
function revealSelectedStep(anchor: HTMLElement): void {
  const id = getState().selection.stepId;
  if (id === undefined) return;
  const row = document.querySelector<HTMLElement>(`[data-testid="step-row-${CSS.escape(id)}"]`);
  if (row === null) return;
  const scroller = scrollerOf(row);
  if (scroller === null) return;
  row.scrollIntoView({ block: "nearest" });
  if (!scroller.contains(anchor)) return;
  anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (wholeIn(row, scroller)) return;
  const box = row.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  // Cut at the top: the anchor is below, so scrolling down by the part still showing hides the row
  // and keeps the anchor in view.
  if (box.top < view.top && box.bottom > view.top) scroller.scrollTop += box.bottom - view.top;
}

/** The anchor's rectangle, grown by the cut-out pad, followed every frame while the stop shows. */
function useAnchorRect(stop: TourStop | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (stop === null) {
      setRect(null);
      return;
    }
    let raf = 0;
    // Undefined until the first frame, so a stop whose anchor is not found clears the last stop's ring.
    let last: Rect | null | undefined = undefined;
    // Each stop brings its anchor into view once (QA-01): a collapsed section is opened, and a few
    // frames later, once it has rendered open, the anchor is scrolled to the nearest edge of
    // whatever scrolls it. After that the loop only follows it, so the person can scroll away.
    let revealFrames = -1;
    // An anchor that is still growing when it is scrolled to, such as a section at the foot of the
    // inspector that renders open a frame late, is scrolled to again while it grows, for a short time.
    let settleFrames = 0;
    let scrolledHeight = 0;
    const tick = () => {
      const element = anchorElement(stop.anchor);
      if (element !== null && revealFrames === -1 && stop.anchor !== null) {
        window.dispatchEvent(new CustomEvent<string>(TOUR_REVEAL_EVENT, { detail: stop.anchor }));
        revealFrames = 2;
      }
      if (element !== null && revealFrames > 0) {
        revealFrames -= 1;
        if (revealFrames === 0) {
          revealSelectedStep(element);
          element.scrollIntoView({ block: "nearest", inline: "nearest" });
          scrolledHeight = element.getBoundingClientRect().height;
          settleFrames = 30;
        }
      } else if (element !== null && settleFrames > 0) {
        settleFrames -= 1;
        const height = element.getBoundingClientRect().height;
        if (height > scrolledHeight + 0.5) {
          scrolledHeight = height;
          element.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
      const box = element?.getBoundingClientRect();
      const next =
        box === undefined || box.width === 0
          ? null
          : {
              left: box.left - CUTOUT_PAD,
              top: box.top - CUTOUT_PAD,
              width: box.width + CUTOUT_PAD * 2,
              height: box.height + CUTOUT_PAD * 2,
            };
      if (last === undefined || !sameRect(next, last)) {
        last = next;
        setRect(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      // The stop is over: whatever it opened goes back as the person left it. The next stop's own
      // reveal, in the same commit, opens its section again, so a section it shares does not flicker.
      if (revealFrames !== -1) window.dispatchEvent(new CustomEvent<string | null>(TOUR_REVEAL_EVENT, { detail: null }));
    };
  }, [stop]);
  return rect;
}

export function Tour() {
  const state = useTour();
  // Read so the card redraws when a switch or a toolbar button in Settings changes which stops the
  // tour has, or Finding codes how one is worded.
  useFeatures();
  useSelector((editor) => editor.prefs.toolbar);
  useSelector((editor) => editor.prefs.findingCodes);
  const stops = currentTourStops();
  const stop = currentStop(state, stops);
  const rect = useAnchorRect(stop);
  const returnFocus = useRef<HTMLElement | null>(null);
  const active = state.phase !== "off";

  // Focus goes back to where it was when the tour closes.
  useEffect(() => {
    if (!active) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      returnFocus.current?.focus?.();
    };
  }, [active]);

  useEffect(() => {
    if (stop !== null) prepare(stop.prepare);
  }, [stop]);

  // Settings may have hidden the stop the tour is on, or one before it: the tour moves back onto a
  // stop it still has rather than staying on with nothing on screen (`withinStops`).
  useEffect(() => {
    if (withinStops(state, stops) !== state) dispatchTour({ type: "sync" });
  });

  // Keys: Escape skips (on the choice card it is Jump in), and the arrows and Enter walk the stops.
  // They are the tour's only while focus is in one of its cards; anywhere else every key does what
  // it always does, so Escape closes a menu or clears the selection and the shortcuts all work.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const inCard = event.target instanceof HTMLElement && event.target.closest("[data-tour-card]") !== null;
      if (!inCard) return;
      if (event.key === "Escape") {
        // An open menu or the palette takes Escape first.
        if (anyMenuOpen() || getState().paletteOpen || getState().dialog !== null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dispatchTour({ type: state.phase === "choice" ? "jumpIn" : "exit" });
        return;
      }
      if (event.key === "Enter") {
        // Enter on one of the card's buttons presses that button, as it always does. On the card
        // itself, which has focus on a stop with a task, it is Next (site/docs/getting-started.md),
        // and the editor's own Enter, which opens Insert, must not run behind it.
        // A modified Enter, or one held down, is not Next, but the editor still does not act on it
        // behind the card; a held Enter would otherwise walk several stops at once.
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (state.phase !== "choice" && state.phase !== "finished") dispatchTour({ type: "next" });
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        dispatchTour({ type: "next" });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        dispatchTour({ type: "back" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [active, state.phase]);

  if (!active) return null;

  return (
    <>
      {stop !== null && rect !== null ? (
        // Its own layer below every popover, so a menu or tooltip that opens over the ring hides
        // the ring rather than the other way round.
        <div
          className={styles.ring}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          data-testid="tour-ring"
          aria-hidden
        />
      ) : null}
      <div className={styles.layer} data-testid="tour" data-tour-layer data-phase={state.phase}>
        {stop !== null ? (
          <CoachMark
            key={`${state.phase}-${String(state.index)}`}
            stop={stop}
            index={state.index}
            total={(state.phase === "core" ? stops.core : stops.full).length}
            phase={state.phase}
            taskDone={isTaskDone(state)}
          />
        ) : null}
        {state.phase === "choice" ? <ChoiceCard /> : null}
        {state.phase === "finished" ? <FinishedCard /> : null}
      </div>
    </>
  );
}

function CoachMark({
  stop,
  index,
  total,
  phase,
  taskDone,
}: {
  stop: TourStop;
  index: number;
  total: number;
  phase: string;
  taskDone: boolean;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const next = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const [placed, setPlaced] = useState<Placement | null>(null);

  // Place the card whenever anything it keeps clear of may have changed: on every DOM change (a
  // popover opening, a tooltip positioning itself, a panel resizing), before the browser paints
  // it, and every frame as well for what no mutation reports (a scroll, a window resize). The
  // anchor is measured then and there, not taken from the last render, and the position is written
  // straight to the element, so the card never covers a popover or its anchor for even one frame.
  // Otherwise `placeCard` leaves it where it is, so it does not jump about while the person works
  // round it. When it has placed against what is on screen, the card says so in `data-settled`.
  // The first placement runs as a layout effect, in the same commit that mounts the card, so the
  // card is shown, and can take focus, before anything else gets a turn (see the focus below).
  useLayoutEffect(() => {
    let raf = 0;
    let previous: Placement | null = null;
    let lastTarget: Rect | null = null;
    let lastKey = "";
    const place = () => {
      const element = card.current;
      if (element === null) return;
      const size = boxOf(element);
      const avoid = [...openPopovers(), ...keepClearBoxes(stop.keepClear)];
      const anchor = ringBox(stop.anchor);
      const key = JSON.stringify([
        anchor,
        avoid,
        Math.round(size.width),
        Math.round(size.height),
        window.innerWidth,
        window.innerHeight,
      ]);
      if (key === lastKey) {
        // Nothing it keeps clear of has moved: where it is still holds.
        element.dataset["settled"] = "true";
        return;
      }
      lastKey = key;
      const moved = !sameRect(anchor, lastTarget);
      lastTarget = anchor;
      const at = placeCard({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        target: anchor,
        avoid,
        card: { width: size.width, height: size.height },
        preferredWidth: CARD_WIDTH,
        minWidth: CARD_MIN_WIDTH,
        side: stop.side,
        previous: moved ? null : previous,
      });
      if (
        previous === null ||
        Math.abs(previous.left - at.left) >= 0.5 ||
        Math.abs(previous.top - at.top) >= 0.5 ||
        previous.width !== at.width
      ) {
        previous = at;
        element.style.left = `${String(at.left)}px`;
        element.style.top = `${String(at.top)}px`;
        element.style.width = `${String(at.width)}px`;
        element.style.visibility = "";
        setPlaced(at);
      }
      element.dataset["settled"] = "true";
    };
    // Something changed that the card has not placed against yet.
    const unsettle = () => {
      if (card.current !== null) card.current.dataset["settled"] = "false";
      place();
    };
    const observer = new MutationObserver((records) => {
      // The card's own moves are not news; anything else may be.
      if (records.every((record) => card.current?.contains(record.target) === true)) return;
      unsettle();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-describedby", "aria-expanded", "data-state"],
    });
    const tick = () => {
      place();
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [stop.anchor, stop.side, stop.keepClear]);

  // Focus moves to the card on each stop: to Next, or to the card itself when the stop has a task.
  // It waits for the first placement, because the card is hidden until then and a hidden element
  // cannot take focus. Each stop mounts a new card, and the old one takes the focused Next button
  // with it, so focus is on the page body until this runs. Placing and focusing in layout effects
  // keeps that inside the one commit: a key pressed straight after Next (Escape to leave, an arrow
  // to walk on) reaches the new card instead of the page, where Escape would only clear the
  // selection and an arrow would nudge the selected point (issue #139).
  const shown = placed !== null;
  useLayoutEffect(() => {
    if (!shown) return;
    if (stop.task === undefined) next.current?.focus();
    else card.current?.focus();
  }, [stop, shown]);

  // Only the full tour ends at its last stop: the core tour's last Next opens the choice card.
  const last = index === total - 1;
  return (
    <div
      ref={card}
      className={styles.card}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      tabIndex={-1}
      data-tour-card
      data-testid="tour-card"
      data-stop={stop.id}
      style={placed === null ? { visibility: "hidden", left: 0, top: 0 } : placed}
    >
      <div className={styles.cardHead}>
        <h2 id={titleId} className={styles.title} data-testid="tour-title">
          {stop.title}
        </h2>
        <span className={styles.count}>
          {String(index + 1)} / {String(total)}
        </span>
      </div>
      <p id={bodyId} className={styles.body}>
        {stop.body}
      </p>
      {stop.task === undefined ? null : (
        <p className={styles.task} data-testid="tour-task" data-done={taskDone ? "true" : undefined}>
          {taskDone ? (
            <span className={styles.taskDone} aria-label="Done">
              <Check size={12} strokeWidth={2.5} aria-hidden />
            </span>
          ) : (
            <span className={styles.taskCircle} aria-hidden />
          )}
          {stop.task.label}
        </p>
      )}
      <div className={styles.dots} aria-hidden>
        {Array.from({ length: total }, (_, at) => (
          <span key={at} className={at <= index ? styles.dotOn : styles.dot} />
        ))}
      </div>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.ghost}
          data-testid="tour-skip"
          onClick={() => {
            dispatchTour({ type: "exit" });
          }}
        >
          Skip tour
        </button>
        <span className={styles.spacer} />
        {index === 0 ? null : (
          <button
            type="button"
            className={styles.ghost}
            data-testid="tour-back"
            onClick={() => {
              dispatchTour({ type: "back" });
            }}
          >
            Back
          </button>
        )}
        <button
          ref={next}
          type="button"
          className={styles.primary}
          data-testid="tour-next"
          onClick={() => {
            dispatchTour({ type: "next" });
          }}
        >
          {last && phase === "full" ? "Finish" : "Next"}
        </button>
      </div>
    </div>
  );
}

/**
 * The tour runs on the bundled example, so in the desktop app its end cards say where a team's own
 * autos come from (sweep D11). A browser has no File menu, so there the line is left out.
 */
function OwnRepoLine() {
  if (!isDesktop()) return null;
  return (
    <p className={styles.body} data-testid="tour-own-repo">
      For your own autos, open your robot repository from the ≡ menu: File &gt; Open a folder…
    </p>
  );
}

function ChoiceCard() {
  const jump = useRef<HTMLButtonElement | null>(null);
  const preset = useSelector((editor) => editor.prefs.preset);
  const users = useUserPresets();
  // The line the first-run card leads to (spec 15 section 9): only once a preset was chosen, and not
  // for a preset whose own name is gone, which Settings calls Custom.
  const chose = chosenPresetName(preset, users);
  const titleId = useId();
  useEffect(() => {
    jump.current?.focus();
  }, []);
  return (
    <div
      className={styles.choice}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-tour-card
      data-testid="tour-choice"
    >
      <h2 id={titleId} className={styles.choiceTitle}>
        You have the basics
      </h2>
      <p className={styles.body}>That is everything you need to plan an auto. Want the rest?</p>
      {chose === null ? null : (
        <p className={styles.body} data-testid="tour-chose">
          You chose {chose}. Change it any time in Settings, Presets.
        </p>
      )}
      <OwnRepoLine />
      <div className={styles.options}>
        <button
          type="button"
          className={styles.option}
          data-testid="tour-full"
          onClick={() => {
            dispatchTour({ type: "chooseFull" });
          }}
        >
          <MapPlus size={32} strokeWidth={1.75} aria-hidden className={styles.optionIcon} />
          <span className={styles.optionTitle}>Take the full tour</span>
          <span className={styles.optionBody}>
            A longer tour of every tool and panel, one at a time. About five minutes.
          </span>
        </button>
        <button
          ref={jump}
          type="button"
          className={`${styles.option} ${styles.optionDefault}`}
          data-testid="tour-jump-in"
          onClick={() => {
            dispatchTour({ type: "jumpIn" });
          }}
        >
          <MousePointer2 size={32} strokeWidth={1.75} aria-hidden className={styles.optionIcon} />
          <span className={styles.optionTitle}>Jump in</span>
          <span className={styles.optionBody}>
            Start planning. You can replay the tour from Help at any time.
          </span>
        </button>
      </div>
    </div>
  );
}

function FinishedCard() {
  const done = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    done.current?.focus();
  }, []);
  return (
    <div
      className={styles.finished}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-tour-card
      data-testid="tour-finished"
    >
      <Check size={32} strokeWidth={1.75} aria-hidden className={styles.optionIcon} />
      <h2 id={titleId} className={styles.choiceTitle}>
        That is the whole tour
      </h2>
      <p className={styles.body}>Replay it from Help or the command palette.</p>
      <OwnRepoLine />
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => {
            dispatchTour({ type: "back" });
          }}
        >
          Back
        </button>
        <span className={styles.spacer} />
        <button
          ref={done}
          type="button"
          className={styles.primary}
          data-testid="tour-done"
          onClick={() => {
            dispatchTour({ type: "next" });
          }}
        >
          Start planning
        </button>
      </div>
    </div>
  );
}
