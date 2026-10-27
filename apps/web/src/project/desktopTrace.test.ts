import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTrace, type TracePoseRow } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { StreamedTrace, TraceSettler, isPoseReset, settleTrace } from "./desktopTrace";

const trace = (poses: TracePoseRow[]) => parseTrace({ formatVersion: 1, auto: "first-auto", tickS: 0.02, poses, steps: [] });

describe("settleTrace", () => {
  it("drops the start pose the harness overwrote on its first tick", () => {
    // The shape a desktop sim trace has when the harness resets the follower after logging the
    // start: the first row is the starter's start pose, and from the second tick on the robot
    // reports poses near the follower's own origin.
    const settled = settleTrace(
      trace([
        [0, -12, -63, 1.571],
        [0.02, 0.039, 0.118, 1.571],
        [0.04, 0.039, 0.236, 1.571],
        [0.06, 0.079, 0.354, 1.571],
      ]),
    );
    expect(settled.droppedLeading).toBe(1);
    expect(settled.trace.poses[0]).toEqual([0.02, 0.039, 0.118, 1.571]);
    expect(settled.resets).toEqual([]);
  });

  it("drops a leading frame at the origin logged before the start pose was set", () => {
    const settled = settleTrace(
      trace([
        [0, 0, 0, 0],
        [0.02, -62.992, -35.984, 0],
        [0.04, -62.9, -35.9, 0],
      ]),
    );
    expect(settled.droppedLeading).toBe(1);
    expect(settled.trace.poses.map((row) => row[1])).toEqual([-62.992, -62.9]);
  });

  it("leaves a clean run alone, and returns the same trace", () => {
    const clean = trace([
      [0, -63, -36, 0],
      [0.02, -62.9, -36, 0],
      [0.04, -62.7, -36, 0],
    ]);
    expect(settleTrace(clean)).toEqual({ trace: clean, droppedLeading: 0, resets: [] });
  });

  it("keeps a reset in the middle of a run and says where it is", () => {
    const settled = settleTrace(
      trace([
        [0, -63, -36, 0],
        [0.5, -40, -36, 0],
        [0.52, 0, 0, 1.571],
        [0.54, 0.1, 0, 1.571],
      ]),
    );
    expect(settled.droppedLeading).toBe(0);
    expect(settled.resets).toEqual([2]);
    expect(settled.trace.poses).toHaveLength(4);
  });

  it("does not call a fast drive a reset", () => {
    expect(isPoseReset([0, 0, 0, 0], [0.02, 1.6, 0, 0], 0.02)).toBe(false);
    expect(isPoseReset([0, 0, 0, 0], [0.5, 40, 0, 0], 0.02)).toBe(false);
    expect(isPoseReset([0, 0, 0, 0], [0.02, 7, 0, 0], 0.02)).toBe(true);
  });
});

describe("a streamed trace settles as the finished file does", () => {
  /** A run whose harness overwrote the start pose on its first tick, then drove and was reset once mid-run. */
  const leadingAndMidRun: TracePoseRow[] = [
    [0, -12, -63, 1.571],
    [0.02, 0.039, 0.118, 1.571],
    [0.04, 0.039, 0.236, 1.571],
    ...Array.from({ length: 40 }, (_, i): TracePoseRow => [0.06 + i * 0.02, 0.1 + i * 0.5, 0.3, 1.571]),
    [0.9, 40, 40, 0],
    [0.92, 40.2, 40, 0],
  ];
  /** A clean run that sits still for a while before it moves. */
  const stillThenDrive: TracePoseRow[] = [
    ...Array.from({ length: 30 }, (_, i): TracePoseRow => [i * 0.02, -63, -36, 0]),
    ...Array.from({ length: 30 }, (_, i): TracePoseRow => [0.6 + i * 0.02, -63 + i * 0.4, -36, 0]),
  ];
  /** Still, then a jump: the leading rows are dropped only once the jump arrives. */
  const stillThenReset: TracePoseRow[] = [
    ...Array.from({ length: 30 }, (_, i): TracePoseRow => [i * 0.02, 0, 0, 0]),
    [0.6, -62.992, -35.984, 0],
    [0.62, -62.9, -35.9, 0],
  ];

  for (const [name, rows] of [
    ["a leading reset and one mid-run", leadingAndMidRun],
    ["a still start before the robot drives", stillThenDrive],
    ["a still start that a late jump decides", stillThenReset],
  ] as const) {
    it(`gives settleTrace's answer after every batch, for ${name}`, () => {
      for (const batch of [1, 3, 25]) {
        const settler = new TraceSettler(0.02);
        for (let at = 0; at < rows.length; at += batch) {
          settler.push(rows.slice(at, at + batch));
          const prefix = trace(rows.slice(0, Math.min(rows.length, at + batch)));
          expect(settler.settle({ ...prefix, poses: [] }), `${name}, batches of ${String(batch)}, ${String(at)} rows in`).toEqual(settleTrace(prefix));
        }
      }
    });
  }

  it("rebuilds the trace file from its header and row batches", () => {
    const file = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../desktop/e2e/fixtures/fake-sim-trace.json", import.meta.url)), "utf8"),
    ) as Record<string, unknown> & { poses: unknown[]; steps: Array<{ endS: number }> };
    const { steps, poses, truthPoses, structureContacts, ledger, events, ...header } = file;
    const streamed = new StreamedTrace(header);
    let sentSteps = 0;
    for (let at = 0; at < poses.length; at += 25) {
      const batch = poses.slice(at, at + 25) as TracePoseRow[];
      const lastS = batch[batch.length - 1]?.[0] ?? 0;
      // A step is sent once it has ended, as the sim server does.
      let end = sentSteps;
      while (end < steps.length && (steps[end] as { endS: number }).endS <= lastS) end += 1;
      streamed.append({ poses: batch, steps: steps.slice(sentSteps, end) });
      sentSteps = end;
    }
    streamed.append({ steps: steps.slice(sentSteps), truthPoses, structureContacts, ledger, events });
    const whole = settleTrace(parseTrace(file));
    expect(streamed.settled()).toEqual(whole);
  });

  it("refuses a batch with a row of the wrong shape, naming the key", () => {
    const streamed = new StreamedTrace({ formatVersion: 1, auto: "first-auto", tickS: 0.02 });
    expect(() => {
      streamed.append({ poses: [[0, 1, 2]] });
    }).toThrow(/poses\[0\]/);
  });
});
