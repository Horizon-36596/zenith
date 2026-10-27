import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints, type OptimizeOptions } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { describe, expect, it } from "vitest";
import { inputOf, serveOptimizer } from "./driver";
import type { DriverMessage, HostMessage, OptimizeRequest, Port } from "./protocol";

/**
 * The optimizer driver on its own (issue #306), with a port and a schedule the test runs by hand: a
 * Stop that arrives before the first batch is still answered, a closed run runs no further batch, the
 * season rules are resolved where it runs, and a request the search refuses is reported as `failed` in
 * a full sentence.
 */

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
const link = loadLink(read("zenith.json"));
const robot = loadRobot(read(link.robot));
const field = loadField(read(link.field));
const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
const auto = loadAuto(read("autos/collect-and-score.auto.json"));
const contract: OptimizeRequest = { auto, robot, field, waypoints, stepId: "toOtherSide" };
const OPTIONS: OptimizeOptions = { budget: 150 };

/** A driver behind a port whose messages and batches the test delivers itself, in order. */
function harness() {
  const posted: DriverMessage[] = [];
  const tasks: (() => void)[] = [];
  const port: Port<HostMessage, DriverMessage> = {
    onmessage: null,
    postMessage: (message) => {
      posted.push(message);
    },
  };
  const served = serveOptimizer(port, (task) => {
    tasks.push(task);
  });
  return {
    posted,
    tasks,
    served,
    send: (message: HostMessage) => port.onmessage?.({ data: message }),
    /** Runs one scheduled batch; false when none is waiting. */
    runOne: (): boolean => {
      const task = tasks.shift();
      if (task === undefined) return false;
      task();
      return true;
    },
    /** Runs batches until one posts something other than progress, or none is left. */
    runUntilAnswer: (): DriverMessage | undefined => {
      for (;;) {
        const task = tasks.shift();
        if (task === undefined) return undefined;
        const before = posted.length;
        task();
        const answer = posted.slice(before).find((message) => message.type !== "progress");
        if (answer !== undefined) return answer;
      }
    },
  };
}

describe("Stop", () => {
  it("is answered when it arrives before the first batch, as the fallback to the slices sends it", () => {
    const driver = harness();
    driver.send({ type: "start", request: contract, options: OPTIONS });
    driver.send({ type: "stop" });
    const answer = driver.runUntilAnswer();
    expect(answer?.type).toBe("stopped");
    if (answer?.type !== "stopped") return;
    expect(answer.result.status).toBe("stoppedEarly");
    // It answered at the first batch that could, not at the end of the budget.
    expect(driver.posted.filter((message) => message.type === "progress")).toHaveLength(1);
    // It stays paused: nothing more is scheduled until Continue.
    expect(driver.tasks).toHaveLength(0);
  }, 60_000);

  it("is answered at the next batch when it arrives after the first", () => {
    const driver = harness();
    driver.send({ type: "start", request: contract, options: OPTIONS });
    expect(driver.runOne()).toBe(true);
    driver.send({ type: "stop" });
    expect(driver.runOne()).toBe(true);
    expect(driver.posted.at(-1)?.type).toBe("stopped");
  }, 60_000);
});

describe("close", () => {
  it("runs no further batch and posts nothing more", () => {
    const driver = harness();
    driver.send({ type: "start", request: contract, options: OPTIONS });
    expect(driver.runOne()).toBe(true);
    expect(driver.tasks).toHaveLength(1);
    const posted = driver.posted.length;
    driver.served.close();
    // The batch already scheduled does nothing and schedules nothing.
    expect(driver.runOne()).toBe(true);
    expect(driver.tasks).toHaveLength(0);
    expect(driver.posted).toHaveLength(posted);
    // And a later message does not start it again.
    driver.send({ type: "continue" });
    driver.send({ type: "start", request: contract, options: OPTIONS });
    expect(driver.tasks).toHaveLength(0);
    expect(driver.posted).toHaveLength(posted);
  }, 60_000);
});

describe("the request", () => {
  it("gets the season rules where it runs when it names withSeason, and none otherwise", () => {
    const withSeason = inputOf({ ...contract, withSeason: true });
    expect(withSeason).not.toHaveProperty("withSeason");
    expect(withSeason.season).toBeDefined();
    expect(withSeason.season).toBe(resolveSeason(field).rules);
    const without = inputOf(contract);
    expect(without).not.toHaveProperty("season");
    expect(inputOf({ ...contract, withSeason: false })).not.toHaveProperty("season");
  });

  it("is reported as failed, in a full sentence, when the search refuses it", () => {
    for (const stepId of ["nope", "shootPreloads"]) {
      const driver = harness();
      driver.send({ type: "start", request: { ...contract, stepId }, options: OPTIONS });
      const answer = driver.runUntilAnswer() ?? driver.posted.at(-1);
      expect(answer?.type, stepId).toBe("failed");
      if (answer?.type !== "failed") continue;
      expect(answer.message).toContain(stepId);
      expect(answer.message).toMatch(/[.!?]$/);
      expect(driver.tasks).toHaveLength(0);
    }
  });
});
