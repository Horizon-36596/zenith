// A stand-in for a robot repository's sim server (site/docs/full-sim-simloop.md, "Full sim speed"),
// for the sim server's unit tests and the desktop e2e. It speaks protocol 1 over stdin and stdout, one
// JSON object per line, and runs every auto by streaming the fixture trace (the instant sim's run of
// the starter's all-step-kinds auto), renamed for the auto it was asked for. No Java, no Gradle.
//
// Its arguments may come from an argument file, `@path`, one argument per line, as `java @path` reads
// them. Options, all optional:
//   --trace <file>            the trace to stream (default: fake-sim-trace.json beside this file)
//   --protocol <n>            the protocol it says it speaks (default 1)
//   --ready-delay-ms <ms>     how long it takes to be ready (default 0)
//   --row-delay-ms <ms>       the wall time between row batches (default 10)
//   --batch <n>               poses per batch (default 25)
//   --fail-auto <name>        a run of this auto fails, as an auto that throws would
//   --crash-after <n>         exits with code 3 after sending this many batches of a run
//   --fatal <message>         sends fatal and exits instead of ready
//   --never-ready             never sends ready
//   --shutdown-delay-ms <ms>  how long it takes to go after shutdown, as a JVM unloading does (default 0)
//   --ignore-cancel           logs a cancel but keeps running the run, as a server stuck in robot code would
//   --ignore-shutdown         logs a shutdown but never exits, so only a kill stops it
//   --bad-row                 sends a pose row with too few numbers in the first batch of every run
//   --log <file>              appends one line per event (started, run, cancel, shutdown, and
//                             "exit <epoch ms>" after a shutdown) to this file
"use strict";
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** Expands `@file` arguments the way the Java launcher does, one argument per line. */
function expand(argv) {
  const out = [];
  for (const arg of argv) {
    if (!arg.startsWith("@")) {
      out.push(arg);
      continue;
    }
    for (const line of readFileSync(arg.slice(1), "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed !== "") out.push(trimmed.replace(/^"(.*)"$/, "$1"));
    }
  }
  return out;
}

const args = expand(process.argv.slice(2));
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(name);

const tracePath = option("--trace", join(__dirname, "fake-sim-trace.json"));
const protocol = Number(option("--protocol", "1"));
const readyDelayMs = Number(option("--ready-delay-ms", "0"));
const rowDelayMs = Number(option("--row-delay-ms", "10"));
const batch = Number(option("--batch", "25"));
const failAuto = option("--fail-auto", null);
const crashAfter = option("--crash-after", null);
const fatal = option("--fatal", null);
const logFile = option("--log", null);
const shutdownDelayMs = Number(option("--shutdown-delay-ms", "0"));
const ignoreCancel = flag("--ignore-cancel");
const ignoreShutdown = flag("--ignore-shutdown");
const badRow = flag("--bad-row");
let shuttingDown = false;

const log = (line) => {
  if (logFile !== null) appendFileSync(logFile, `${line}\n`);
};
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

log(`started ${process.pid}`);
// What the robot code prints goes to stderr, as the real server redirects it.
console.error(`fake-sim-server: up, pid ${process.pid}`);

let active = null;

function run(id, auto) {
  log(`run ${id} ${auto}`);
  if (active !== null) {
    send({ type: "failed", id, message: "busy", tail: [] });
    return;
  }
  if (typeof auto !== "string" || !/^[A-Za-z0-9._-]+$/.test(auto)) {
    send({ type: "failed", id, message: "That is not an auto name.", tail: [] });
    return;
  }
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  trace.auto = auto;
  const { steps = [], poses = [], truthPoses = [], structureContacts = [], ledger = [], events = [], simTimeS, ...header } = trace;
  const state = { id, cancelled: false, timer: null };
  active = state;
  const started = Date.now();
  console.error(`fake-sim-server: running ${auto}`);
  send({ type: "start", id, trace: header });
  if (failAuto === auto) {
    active = null;
    send({ type: "failed", id, message: `${auto} threw in the sim: a fake failure.`, tail: ["java.lang.IllegalStateException: a fake failure"] });
    return;
  }
  let at = 0;
  let sentSteps = 0;
  let batches = 0;
  const next = () => {
    if (state.cancelled) {
      active = null;
      send({ type: "cancelled", id });
      return;
    }
    if (crashAfter !== null && batches >= Number(crashAfter)) {
      console.error("fake-sim-server: crashing, as asked");
      process.exit(3);
    }
    if (at < poses.length) {
      const rows = poses.slice(at, at + batch);
      at += rows.length;
      const lastS = rows[rows.length - 1][0];
      // A step is sent once it has ended.
      let end = sentSteps;
      while (end < steps.length && steps[end].endS <= lastS) end += 1;
      const message = { type: "rows", id, poses: badRow && batches === 0 ? [[0, 1], ...rows] : rows };
      if (end > sentSteps) message.steps = steps.slice(sentSteps, end);
      sentSteps = end;
      send(message);
      batches += 1;
      state.timer = setTimeout(next, rowDelayMs);
      return;
    }
    send({ type: "rows", id, steps: steps.slice(sentSteps), truthPoses, structureContacts, ledger, events });
    const dir = join(process.cwd(), "build", "sim");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${auto}.trace.json`), `${JSON.stringify(trace)}\n`);
    active = null;
    send({ type: "done", id, simTimeS, elapsedS: (Date.now() - started) / 1000, tracePath: `build/sim/${auto}.trace.json` });
  };
  state.timer = setTimeout(next, rowDelayMs);
}

function onMessage(message) {
  switch (message.type) {
    case "run":
      run(message.id, message.auto);
      break;
    case "cancel":
      log(`cancel ${message.id}`);
      if (active !== null && active.id === message.id && !ignoreCancel) active.cancelled = true;
      break;
    case "shutdown":
      log("shutdown");
      shuttingDown = true;
      if (ignoreShutdown) {
        // Stays alive with stdin closed, as a JVM with a thread still running does.
        setInterval(() => undefined, 1_000);
        break;
      }
      setTimeout(() => {
        log(`exit ${Date.now()}`);
        process.exit(0);
      }, shutdownDelayMs);
      break;
    default:
      break;
  }
}

let partial = "";
process.stdin.on("data", (chunk) => {
  const lines = (partial + chunk.toString()).split("\n");
  partial = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      // Not JSON: ignored, as the protocol says.
    }
  }
});
process.stdin.on("end", () => {
  // Asked to shut down, it goes in its own time; stdin closing with no shutdown is the app gone.
  if (!shuttingDown) process.exit(0);
});

setTimeout(() => {
  if (fatal !== null) {
    send({ type: "fatal", message: fatal });
    process.exit(1);
  }
  if (flag("--never-ready")) return;
  send({ type: "ready", protocol, simloop: "0.2.0-alpha.1", runner: "fake", pid: process.pid });
}, readyDelayMs);
