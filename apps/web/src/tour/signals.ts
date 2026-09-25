/**
 * Where the editor store sends the things a tour stop can wait for. A sink rather than a direct
 * import so the store does not depend on the tour: `tour/store.ts` installs itself here, and
 * until it does every signal goes nowhere.
 */
import type { TourSignal } from "./model";

let sink: (signal: TourSignal) => void = () => undefined;

export const setTourSink = (next: (signal: TourSignal) => void): void => {
  sink = next;
};

export const emitTourSignal = (signal: TourSignal): void => {
  sink(signal);
};

/**
 * The event the tour dispatches on `window`, with a stop's anchor id as its detail, just before it
 * points at that anchor: whatever holds the anchor shows it, so a collapsed inspector section opens
 * (`Section` in `components/fields.tsx` listens). A plain DOM event keeps components free of the tour.
 */
export const TOUR_REVEAL_EVENT = "zenith:tour-reveal";
