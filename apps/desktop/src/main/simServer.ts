/**
 * Full sim speed (site/docs/full-sim-simloop.md, "Full sim speed"): the High-fidelity sim run by a
 * warm sim server instead of a Gradle build per run.
 *
 * `zenith.json`'s `sim.server` names a `prepare` command, which builds the robot code and writes a
 * Java argument file, and that `args` file. The server is `java @<args>`, started with the same
 * `findJava` the sim command uses, and it speaks protocol 1 over its own stdin and stdout, one JSON
 * object per line (site/docs/sim-server-protocol.md describes protocol 1): a `ready` handshake,
 * then for each `run` a `start` with the trace's header, `rows` as the run goes, and `done`,
 * `failed` or `cancelled`. Anything the robot code prints goes to its stderr, which the
 * sim panel shows as the log.
 *
 * Three speeds, the person's choice in Settings:
 *
 * - **Basic** runs `sim.command` per click (`SimRunner`), as before.
 * - **Fast** starts the server on the first click and stops it after `FAST_IDLE_MS` with no run.
 * - **Ultrafast** starts it when the project opens, runs an auto again in the background shortly
 *   after it is saved, and keeps the latest trace of each auto, so a click on an auto that has not
 *   changed since plays at once. A trace is reused only for the same auto, waypoints and robot files
 *   on the same server generation; a change to a watched path starts a new generation.
 *
 * Whatever goes wrong with the server (the prepare command fails, the server speaks another
 * protocol, it crashes or never says it is ready), that click falls back to Basic and the panel says
 * why. A run that fails inside a working server (the auto threw) is that run's failure, as in Basic.
 *
 * The server process and everything it started is killed on quit, when the project closes or the
 * speed goes back to Basic, when Fast's idle time runs out, when a watched path changes, and when
 * `zenith.json`'s `sim.server` changes (it is read again for every click).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { posix } from "node:path";
import { parseTrace } from "@horizon36596/zenith-core";
import type { DesktopSimEvent, DesktopSimSpeed } from "../../../web/src/project/desktopBridge.js";
import { confinePath, hostPlatform, splitShellWords, type Platform, type SimLaunch } from "./cli.js";
import { BridgeError } from "./confine.js";
import { unthrottleProcess } from "./powerThrottling.js";
import { autoRelPath, loadDesktopProject } from "./project.js";
import {
  ANSI,
  SimRunner,
  TAIL_LINES,
  buildSimPlan,
  cannotStart,
  defaultKillTree,
  explainFailure,
  findJava,
  resolveLauncher,
  type SimPlan,
} from "./sim.js";

/** The protocol this build speaks. A server that says another is refused, and the click runs Basic. */
export const SIM_SERVER_PROTOCOL = 1;

/** Fast stops the server after this long with no run (SET BY HAND: ten minutes, the agreed plan). */
export const FAST_IDLE_MS = 10 * 60_000;

/** Ultrafast runs a saved auto again this long after the last save (SET BY HAND: the agreed plan). */
export const ULTRAFAST_DEBOUNCE_MS = 500;

/** How long a started server has to say `ready` before the click falls back (SET BY HAND). */
const READY_TIMEOUT_MS = 120_000;

/** How long the prepare command may run before it is killed and the click runs Basic (SET BY HAND: ten minutes, far past a cold Gradle build). */
export const PREPARE_TIMEOUT_MS = 10 * 60_000;

/** How long a cancelled run has to say `cancelled` before the server is stopped instead (SET BY HAND). */
const CANCEL_GRACE_MS = 3_000;

/** How long `shutdown` has before the process tree is killed (SET BY HAND: the contract's ~1 s, doubled). */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * How long after prepare ends a change the watch hears still counts as prepare's own writing (SET BY
 * HAND: a build's last writes can be reported just after its process has gone).
 */
const PREPARE_SETTLE_MS = 1_000;

/**
 * A server that spoke another protocol is not tried again for this long, unless its args file changes
 * or a watched path does (SET BY HAND: without a watch list, nothing else would ever clear it).
 */
export const STUCK_RETRY_MS = 5 * 60_000;

/** The arrays of a trace, in the order the trace file writes them. */
const TRACE_ARRAYS = ["steps", "poses", "truthPoses", "structureContacts", "ledger", "events"] as const;

/** Everything `sim.server` asks for, worked out before anything starts. */
export interface ServerPlan {
  root: string;
  prepare: SimLaunch;
  /** Absolute, confined to the root. */
  argsPath: string;
  /** Relative to the root, with `/`. */
  argsRel: string;
  /** Absolute, confined to the root. */
  cwd: string;
  /** Relative to the root, with `/`; empty for the root itself. */
  cwdRel: string;
  /** Relative to the root, with `/`, no trailing `/`; empty for the whole root. */
  watch: string[];
  /**
   * Inside the watched paths but never robot code: the args file's folder (or the file, when it is at
   * the root), the folder the trace template writes into, and the autos folder. The server reads autos
   * fresh for every run, and prepare and the server write the others.
   */
  ignore: string[];
  /** Windows paths are compared without case. */
  ignoreCase: boolean;
}

const slash = (path: string): string => path.split("\\").join("/");

/** `path` relative to the root with `/`, normalised (`./a/./b/` is `a/b`); empty for the root itself. */
const trimRel = (path: string): string => {
  const normal = posix.normalize(slash(path)).replace(/\/+$/, "");
  return normal === "." ? "" : normal;
};

/** The folder a path template writes into, up to its first `{placeholder}` part; empty for the root. */
function templateDir(template: string): string {
  const parts = trimRel(template).split("/").slice(0, -1);
  const fixed = parts.findIndex((part) => part.includes("{"));
  return (fixed === -1 ? parts : parts.slice(0, fixed)).join("/");
}

/** The confined absolute path of `rel`, as a bridge error when it leaves the root. */
function confined(root: string, rel: string): string {
  try {
    return confinePath(root, rel);
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
}

/** `sim.server` as a plan, or null when the project has none (it then only has Basic). */
export function buildServerPlan(root: string, host: Platform = hostPlatform()): ServerPlan | null {
  const link = loadDesktopProject(root).link;
  const server = link.sim?.server;
  if (server === undefined) return null;
  const argsRel = trimRel(server.args);
  const cwdRel = server.cwd === undefined ? "" : trimRel(server.cwd);
  const watchRel = [...new Set((server.watch ?? []).map(trimRel))];
  // Every path is confined here, before anything runs, the way the trace path is.
  for (const rel of watchRel) confined(root, rel);
  const argsDir = posix.dirname(argsRel);
  const ignore = [argsDir === "." ? argsRel : argsDir, templateDir(link.sim?.trace ?? ""), trimRel(link.autosDir)];
  return {
    root,
    prepare: resolveLauncher(splitShellWords(server.prepare), root, host),
    argsPath: confined(root, argsRel),
    argsRel,
    cwd: cwdRel === "" ? root : confined(root, cwdRel),
    cwdRel,
    watch: watchRel,
    // The root itself is never ignored: that would ignore everything.
    ignore: [...new Set(ignore.filter((path) => path !== ""))],
    ignoreCase: host.platform === "win32",
  };
}

/**
 * True when `rel` (relative to the root) is one of `watched` or inside one; an empty entry is the
 * whole root. Both sides are normalised first, and compared without case when `ignoreCase` is set.
 */
export function isWatched(rel: string, watched: readonly string[], ignoreCase = false): boolean {
  const fold = (path: string): string => (ignoreCase ? trimRel(path).toLowerCase() : trimRel(path));
  const path = fold(rel);
  return watched.some((raw) => {
    const entry = fold(raw);
    return entry === "" || path === entry || path.startsWith(`${entry}/`);
  });
}

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/** A failure of the server itself, worded for a person, after which a click runs Basic. */
class ServerFailure extends Error {
  constructor(
    message: string,
    /** True when the server cannot work until the robot code changes: retrying each click would only fail again. */
    readonly sticky = false,
  ) {
    super(message);
    this.name = "ServerFailure";
  }
}

export interface ServerDeps {
  spawnImpl?: typeof nodeSpawn;
  killTree?: (child: ChildProcess) => void;
  now?: () => number;
  /** How the server is launched from its args file: `java @<args>` unless a test gives another. */
  serverLaunch?: (argsPath: string) => { file: string; args: string[] };
  /**
   * Watches the root for changes to the `watch` paths; `fs.watch`, recursive, unless a test gives
   * another. The listener hears null when the watch could not say which file changed.
   */
  watchImpl?: (root: string, listener: (rel: string | null) => void) => { close(): void };
  host?: Platform;
  idleMs?: number;
  debounceMs?: number;
  readyTimeoutMs?: number;
  prepareTimeoutMs?: number;
  /** Opts the server's JVM (the `pid` its `ready` names) out of Windows power throttling; see powerThrottling.ts. */
  unthrottle?: (pid: number) => void;
  cancelGraceMs?: number;
  shutdownGraceMs?: number;
  prepareSettleMs?: number;
  stuckRetryMs?: number;
}

function defaultWatch(root: string, listener: (rel: string | null) => void): { close(): void } {
  let watcher: FSWatcher | null = watch(root, { recursive: true }, (_event, filename) => {
    // No file name: on Windows, the change buffer overflowed and any file may have changed.
    listener(filename === null ? null : slash(filename));
  });
  watcher.on("error", () => {
    // A watch that dies just stops reporting; the next project open starts a fresh one.
    watcher?.close();
    watcher = null;
  });
  return {
    close: () => {
      watcher?.close();
      watcher = null;
    },
  };
}

const readOrEmpty = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/**
 * What a trace of the auto depends on that Zenith can see: the text of the auto file, the waypoints
 * file, the project's robot file and the `robot.json` in the autos folder, which the runtime reads
 * for the default path speed (`PathSpeeds.defaultFromRobotFile`). The robot code is the server's
 * generation.
 */
export function autoContentKey(root: string, fileName: string): string {
  const project = loadDesktopProject(root);
  const hash = createHash("sha256");
  const robotInAutos = `${slash(project.link.autosDir).replace(/\/+$/, "")}/robot.json`;
  const files = [autoRelPath(project, fileName), project.link.waypoints, project.link.robot, robotInAutos];
  for (const rel of files) {
    hash.update(rel === undefined ? "" : readOrEmpty(confined(root, rel)));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/* ---- One run on the server ------------------------------------------------ */

interface Job {
  /** The renderer's run id for a click, or null for an Ultrafast background run. */
  clickId: string | null;
  plan: SimPlan;
  fileName: string;
  key: string;
  startedAt: number;
  cancelled: boolean;
}

interface Active extends Job {
  /** The id Zenith gave the server: `r1`, `r2`, … per server lifetime. */
  serverId: string;
  /** The server process the run was sent to: an older one going away has no say in this run. */
  proc: ServerProcess;
  generation: number;
  header: Record<string, unknown> | null;
  arrays: Record<(typeof TRACE_ARRAYS)[number], unknown[]>;
  /** Set once the run has been asked to stop: a background run a click replaced, or a cancel. */
  stopping: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
}

interface CacheEntry {
  key: string;
  generation: number;
  trace: unknown;
  tracePath: string;
}

interface ServerProcess {
  child: ChildProcess;
  exited: boolean;
  /** The `fatal` message, when the server sent one before it went. */
  fatal: string | null;
  /** Called once when the process has gone. */
  onGone: (() => void)[];
}

/**
 * The sim server of one open project: prepares and starts it, sends it runs one at a time, stops it,
 * and holds Ultrafast's traces. Runs that are not clicks emit nothing.
 */
export class SimServerManager {
  private proc: ServerProcess | null = null;
  private ready: Promise<void> | null = null;
  /** Bumped by every server start and every change to a watched path; a cached trace holds the one it ran on. */
  private generation = 0;
  private stale = false;
  /** A failure that holds until the robot code changes, such as a protocol the server does not speak. */
  private stuck: ServerFailure | null = null;
  /** When `stuck` was set, and the args file's modification time then: a later one tries again. */
  private stuckAt = 0;
  private stuckArgsMtime: number | null = null;
  /**
   * Set when getting the server ready failed: an Ultrafast save then runs nothing, so a broken build is
   * not prepared again (for up to ten minutes) on every save. A click or a watched change clears it.
   */
  private gaveUp = false;
  /** Changes heard before this time are prepare's own writing (`PREPARE_SETTLE_MS`). */
  private quietUntil = 0;
  /** The folders the server said it wrote traces into, which are never robot code. */
  private readonly outputDirs: string[] = [];
  private active: Active | null = null;
  private queue: Job[] = [];
  private nextServerId = 1;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly tail: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: { close(): void } | null = null;
  /** The click waiting on the server to be ready, which hears the prepare output and the status. */
  private waiting: Job | null = null;
  /** The last status said while the server gets ready, for a click that starts waiting part way. */
  private lastStatus: { status: "preparing" | "starting"; message: string } | null = null;
  /** The prepare command while it runs, so a close can kill it. */
  private prepareChild: ChildProcess | null = null;
  /** Settles when the last server asked to stop has gone; a start waits for it. */
  private stopping: Promise<void> | null = null;
  private closed = false;

  private readonly spawnImpl: typeof nodeSpawn;
  private readonly killTree: (child: ChildProcess) => void;
  private readonly now: () => number;
  private readonly serverLaunch: NonNullable<ServerDeps["serverLaunch"]>;
  private readonly idleMs: number;
  private readonly debounceMs: number;
  private readonly readyTimeoutMs: number;
  private readonly prepareTimeoutMs: number;
  private readonly unthrottle: (pid: number) => void;
  private readonly cancelGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly prepareSettleMs: number;
  private readonly stuckRetryMs: number;

  constructor(
    readonly plan: ServerPlan,
    private speed: DesktopSimSpeed,
    private readonly emit: (event: DesktopSimEvent) => void,
    /** Runs a click as Basic, under the click's own run id, after the server failed it. */
    private readonly fallback: (job: { clickId: string; plan: SimPlan }, reason: string) => void,
    deps: ServerDeps = {},
  ) {
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn;
    this.killTree = deps.killTree ?? defaultKillTree;
    this.now = deps.now ?? Date.now;
    const host = deps.host ?? hostPlatform();
    this.serverLaunch = deps.serverLaunch ?? ((argsPath) => ({ file: findJava(host), args: [`@${argsPath}`] }));
    this.idleMs = deps.idleMs ?? FAST_IDLE_MS;
    this.debounceMs = deps.debounceMs ?? ULTRAFAST_DEBOUNCE_MS;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.prepareTimeoutMs = deps.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    this.unthrottle = deps.unthrottle ?? ((pid) => unthrottleProcess(pid, host));
    this.cancelGraceMs = deps.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.shutdownGraceMs = deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.prepareSettleMs = deps.prepareSettleMs ?? PREPARE_SETTLE_MS;
    this.stuckRetryMs = deps.stuckRetryMs ?? STUCK_RETRY_MS;
    if (plan.watch.length > 0) {
      this.watcher = (deps.watchImpl ?? defaultWatch)(plan.root, (rel) => {
        // Prepare builds into the tree, perhaps inside a watched folder. Nothing heard while it runs,
        // or just after, counts: otherwise every prepare would make the server stale again, and it
        // would rebuild forever. A change saved during prepare is the price; the next one is heard.
        if (this.prepareChild !== null || this.now() < this.quietUntil) return;
        // A change the watch could not name may be a watched one.
        if (rel === null || this.isRobotCode(rel)) this.markStale();
      });
    }
  }

  /** Whether a changed path is robot code: watched, and not the args file, a trace or an auto. */
  private isRobotCode(rel: string): boolean {
    const plan = this.plan;
    return isWatched(rel, plan.watch, plan.ignoreCase) && !isWatched(rel, [...plan.ignore, ...this.outputDirs], plan.ignoreCase);
  }

  /** Whether a server process is up, for tests and the status line. */
  get running(): boolean {
    return this.proc !== null && !this.proc.exited;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** The speed changed (never to Basic: the dispatcher closes the manager for that). */
  setSpeed(speed: DesktopSimSpeed): void {
    this.speed = speed;
    if (speed === "ultrafast") {
      this.clearIdle();
      this.warm();
    } else {
      this.cache.clear();
      if (this.active === null) this.armIdle();
    }
  }

  /** Ultrafast: start the server now, so the first click does not wait for it. Failures wait for a click to report them. */
  warm(): void {
    this.readyAndFresh().catch(() => {
      if (!this.closed) this.gaveUp = true;
    });
  }

  /** A click: plays a cached trace, joins a background run of the same file, or queues a run. */
  click(clickId: string, plan: SimPlan, fileName: string): void {
    // A click always tries the server again, even after it failed to get ready.
    this.gaveUp = false;
    const job: Job = { clickId, plan, fileName, key: this.keyOf(fileName), startedAt: this.now(), cancelled: false };
    const hit = this.cachedFor(plan.autoName, job.key);
    if (hit !== null) {
      this.emit({
        runId: clickId,
        kind: "done",
        trace: hit.trace,
        tracePath: hit.tracePath,
        elapsedS: 0,
        streamed: false,
        cached: true,
      });
      this.armIdle();
      return;
    }
    const active = this.active;
    if (
      active !== null &&
      active.clickId === null &&
      !active.stopping &&
      active.plan.autoName === plan.autoName &&
      active.key === job.key &&
      active.generation === this.generation &&
      !this.stale
    ) {
      // The background run already under way is this click's run: hand it over, rows so far included.
      active.clickId = clickId;
      active.startedAt = job.startedAt;
      if (active.header !== null) {
        this.emit({ runId: clickId, kind: "traceStart", header: active.header });
        const rows = Object.fromEntries(TRACE_ARRAYS.map((name) => [name, active.arrays[name]]));
        this.emit({ runId: clickId, kind: "rows", rows });
      }
      return;
    }
    // A click goes before every background run, and replaces one under way.
    this.queue = [job, ...this.queue];
    if (active !== null && active.clickId === null) this.stopActive();
    if (this.pumping && this.waiting === null) {
      // The server is getting ready for a background run: this click hears how it goes from here.
      this.waiting = job;
      if (this.lastStatus !== null) this.emit({ runId: clickId, kind: "status", ...this.lastStatus });
    }
    this.pump();
  }

  /** Ultrafast: an auto file was saved; run it again shortly, unless a newer save comes first. */
  autoSaved(fileName: string): void {
    if (this.speed !== "ultrafast" || this.closed) return;
    const pending = this.debounce.get(fileName);
    if (pending !== undefined) clearTimeout(pending);
    this.debounce.set(
      fileName,
      setTimeout(() => {
        this.debounce.delete(fileName);
        this.background(fileName);
      }, this.debounceMs),
    );
  }

  private background(fileName: string): void {
    if (this.speed !== "ultrafast" || this.closed || this.gaveUp) return;
    let plan: SimPlan;
    let key: string;
    try {
      plan = buildSimPlan(this.plan.root, fileName);
      key = this.keyOf(fileName);
    } catch {
      // An auto that does not load has nothing to run; the click will say why.
      return;
    }
    if (this.cachedFor(plan.autoName, key) !== null) return;
    const job: Job = { clickId: null, plan, fileName, key, startedAt: this.now(), cancelled: false };
    this.queue = [...this.queue.filter((queued) => queued.clickId !== null || queued.plan.autoName !== plan.autoName), job];
    this.queue.sort((a, b) => Number(a.clickId === null) - Number(b.clickId === null));
    const active = this.active;
    if (active !== null && active.clickId === null && active.plan.autoName === plan.autoName) this.stopActive();
    this.pump();
  }

  /** The renderer's cancel. True when the run was this manager's. */
  cancel(clickId: string): boolean {
    const queued = this.queue.find((job) => job.clickId === clickId) ?? (this.waiting?.clickId === clickId ? this.waiting : null);
    if (queued !== null && queued !== undefined) {
      queued.cancelled = true;
      this.queue = this.queue.filter((job) => job !== queued);
      this.emit({ runId: clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
      if (this.waiting === queued) {
        // The next click, if there is one, hears how the getting ready goes from here.
        this.waiting = this.queue.find((job) => job.clickId !== null) ?? null;
        const next = this.waiting?.clickId ?? null;
        if (next !== null && this.lastStatus !== null) this.emit({ runId: next, kind: "status", ...this.lastStatus });
      }
      return true;
    }
    const active = this.active;
    if (active === null || active.clickId !== clickId) return false;
    active.cancelled = true;
    this.stopActive();
    return true;
  }

  /** Stops the server and forgets everything: project closed, Basic chosen, or quit. */
  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    this.clearIdle();
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    const active = this.active;
    this.active = null;
    if (active !== null && active.cancelTimer !== null) clearTimeout(active.cancelTimer);
    if (active?.clickId != null) {
      this.emit({ runId: active.clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
    }
    // The click waiting on the server to get ready is off the queue, and is told too, once. A queued
    // click already cancelled was told by `cancel`.
    const waiting = new Set<Job>([...(this.waiting === null ? [] : [this.waiting]), ...this.queue]);
    for (const job of waiting) {
      if (job.clickId !== null && !job.cancelled) {
        job.cancelled = true;
        this.emit({ runId: job.clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
      }
    }
    this.waiting = null;
    this.queue = [];
    this.cache.clear();
    if (this.prepareChild !== null) this.killTree(this.prepareChild);
    void this.stopProcess();
  }

  /* ---- The queue ---- */

  private pumping = false;

  private pump(): void {
    if (this.pumping || this.active !== null || this.closed) return;
    const job = this.queue.shift();
    if (job === undefined) {
      this.armIdle();
      return;
    }
    this.clearIdle();
    this.pumping = true;
    if (job.clickId !== null) {
      this.waiting = job;
      // Ultrafast may already be getting the server ready: say how far it has got.
      if (this.lastStatus !== null) this.emit({ runId: job.clickId, kind: "status", ...this.lastStatus });
    }
    this.readyAndFresh().then(
      () => {
        this.pumping = false;
        this.waiting = null;
        this.lastStatus = null;
        let next: Job = job;
        if (next.clickId === null && this.queue.some((queued) => queued.clickId !== null)) {
          // A click arrived while the server got ready for a background run: the click goes first.
          this.queue.push(next);
          next = this.queue.shift() as Job;
        }
        if (next.cancelled || this.closed) {
          this.pump();
          return;
        }
        this.send(next);
      },
      (error: unknown) => {
        this.pumping = false;
        this.waiting = null;
        this.lastStatus = null;
        // A closed manager told every click it was cancelled; none of them runs Basic now.
        if (this.closed) return;
        this.gaveUp = true;
        if (!job.cancelled && job.clickId !== null) {
          this.fallback({ clickId: job.clickId, plan: job.plan }, failureText(error));
        }
        // Every click waiting behind it has the same server, and the same problem.
        const clicks = this.queue.filter((queued) => queued.clickId !== null);
        this.queue = [];
        for (const queued of clicks) this.fallback({ clickId: queued.clickId as string, plan: queued.plan }, failureText(error));
        this.armIdle();
      },
    );
  }

  /** Ready, on a server no watched change has made out of date while it got ready. */
  private async readyAndFresh(): Promise<void> {
    do {
      await this.ensureReady();
    } while (this.stale && !this.closed);
  }

  private send(job: Job): void {
    const proc = this.proc;
    if (proc === null || proc.exited) {
      // It went between ready and now: try again from the top, which starts it again.
      this.queue.unshift(job);
      this.pump();
      return;
    }
    const serverId = `r${String(this.nextServerId++)}`;
    this.active = {
      ...job,
      serverId,
      proc,
      generation: this.generation,
      header: null,
      arrays: { steps: [], poses: [], truthPoses: [], structureContacts: [], ledger: [], events: [] },
      stopping: false,
      cancelTimer: null,
    };
    this.tail.length = 0;
    this.write({ type: "run", id: serverId, auto: job.plan.autoName });
  }

  /** Asks the server to stop the run under way; if it does not say so in time, stops the server. */
  private stopActive(): void {
    const active = this.active;
    if (active === null || active.stopping) return;
    active.stopping = true;
    this.write({ type: "cancel", id: active.serverId });
    active.cancelTimer = setTimeout(() => {
      if (this.active !== active) return;
      void this.stopProcess();
      this.finishActive(() => {
        if (active.clickId !== null) {
          this.emit({ runId: active.clickId, kind: "failed", message: "The sim was cancelled.", tail: [...this.tail], cancelled: true });
        }
      });
    }, this.cancelGraceMs);
  }

  private finishActive(report: () => void): void {
    const active = this.active;
    if (active?.cancelTimer != null) clearTimeout(active.cancelTimer);
    this.active = null;
    report();
    if (this.stale) void this.stopProcess();
    this.pump();
  }

  /* ---- Messages from the server ---- */

  private onMessage(proc: ServerProcess, message: Record<string, unknown>): void {
    const type = message["type"];
    if (type === "fatal") {
      proc.fatal = typeof message["message"] === "string" ? message["message"] : "The sim server stopped.";
      return;
    }
    const active = this.active;
    if (active === null || active.proc !== proc || message["id"] !== active.serverId) return;
    switch (type) {
      case "start": {
        const header = message["trace"];
        active.header = typeof header === "object" && header !== null && !Array.isArray(header) ? (header as Record<string, unknown>) : {};
        if (active.clickId !== null && !active.stopping) {
          this.emit({ runId: active.clickId, kind: "traceStart", header: active.header });
        }
        break;
      }
      case "rows": {
        const rows: Record<string, unknown[]> = {};
        for (const name of TRACE_ARRAYS) {
          const value = message[name];
          if (!Array.isArray(value) || value.length === 0) continue;
          active.arrays[name].push(...(value as unknown[]));
          rows[name] = value as unknown[];
        }
        if (active.clickId !== null && !active.stopping) this.emit({ runId: active.clickId, kind: "rows", rows });
        break;
      }
      case "done":
        this.onDone(active, message);
        break;
      case "failed":
        this.finishActive(() => {
          if (active.clickId === null) return;
          if (active.cancelled) {
            this.emit({ runId: active.clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
            return;
          }
          const said = typeof message["message"] === "string" && message["message"] !== "" ? message["message"] : "The run failed in the sim server.";
          const tail = Array.isArray(message["tail"]) ? message["tail"].map(String) : [...this.tail];
          this.emit({ runId: active.clickId, kind: "failed", message: said, tail, cancelled: false });
        });
        break;
      case "cancelled":
        this.finishActive(() => {
          if (active.clickId !== null) {
            this.emit({ runId: active.clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
          }
        });
        break;
      default:
        // Unknown types are ignored (protocol 1 is forward compatible).
        break;
    }
  }

  private onDone(active: Active, message: Record<string, unknown>): void {
    const header = active.header ?? {};
    const trace: Record<string, unknown> = { ...header };
    if (typeof message["simTimeS"] === "number") trace["simTimeS"] = message["simTimeS"];
    for (const name of TRACE_ARRAYS) trace[name] = active.arrays[name];
    const serverPath = typeof message["tracePath"] === "string" ? slash(message["tracePath"]) : "";
    const tracePath = serverPath === "" ? "" : posix.normalize(this.plan.cwdRel === "" ? serverPath : `${this.plan.cwdRel}/${serverPath}`);
    const outputDir = trimRel(posix.dirname(tracePath));
    if (outputDir !== "" && !this.outputDirs.includes(outputDir)) this.outputDirs.push(outputDir);
    let readError: string | null = null;
    try {
      parseTrace(trace);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    // The server read the files when the run started, which can be a whole prepare after the key was
    // taken: a file that changed in between makes the trace another file's, which is never kept.
    const unchanged = this.speed === "ultrafast" && this.keyOf(active.fileName) === active.key;
    this.finishActive(() => {
      if (readError === null && unchanged && active.generation === this.generation && !this.stale) {
        this.cache.set(active.plan.autoName, { key: active.key, generation: active.generation, trace, tracePath });
      }
      if (active.clickId === null) return;
      if (active.cancelled) {
        this.emit({ runId: active.clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
        return;
      }
      if (readError !== null) {
        this.emit({ runId: active.clickId, kind: "failed", message: `The sim server's trace could not be read: ${readError}`, tail: [...this.tail], cancelled: false });
        return;
      }
      this.emit({
        runId: active.clickId,
        kind: "done",
        trace,
        tracePath,
        elapsedS: (this.now() - active.startedAt) / 1000,
        streamed: true,
      });
    });
  }

  private onExit(proc: ServerProcess, code: number | null): void {
    if (proc.exited) return;
    proc.exited = true;
    for (const gone of proc.onGone.splice(0)) gone();
    if (this.proc === proc) this.proc = null;
    const active = this.active;
    // An older server going after a newer one took over has nothing to do with the run under way.
    if (active === null || this.closed || active.proc !== proc) return;
    // The server went with a run under way: the click runs Basic, and a background run is dropped.
    this.finishActive(() => {
      if (active.clickId === null) return;
      if (active.cancelled || active.stopping) {
        this.emit({ runId: active.clickId, kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
        return;
      }
      const why = proc.fatal ?? `it exited with code ${String(code)}`;
      this.fallback({ clickId: active.clickId, plan: active.plan }, `The sim server stopped during the run: ${why}`);
    });
  }

  /* ---- Starting and stopping ---- */

  private ensureReady(): Promise<void> {
    if (this.proc !== null && !this.proc.exited && !this.stale && this.ready === null) return Promise.resolve();
    this.ready ??= this.start().finally(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private async start(): Promise<void> {
    const closed = (): ServerFailure => new ServerFailure("The sim server was stopped.");
    if (this.closed) throw closed();
    if (this.stuck !== null && !this.stale && !this.stuckExpired()) throw this.stuck;
    const rebuilding = this.stale || this.generation > 0;
    // Wait for the old JVM to go: on Windows it holds the jars on its class path open, and prepare rebuilds them.
    await this.stopProcess();
    if (this.closed) throw closed();
    this.stale = false;
    this.stuck = null;
    this.status("preparing", rebuilding ? "Rebuilding the robot code for the sim server." : "Building the robot code for the sim server.");
    await this.runPrepare();
    if (this.closed) throw closed();
    if (!existsSync(this.plan.argsPath)) {
      throw new ServerFailure(`The sim server's prepare command finished but wrote no ${this.plan.argsRel}. Check zenith.json's sim.server.args.`);
    }
    this.status("starting", "Starting the sim server.");
    await this.spawnServer();
    if (this.closed) {
      // Closed while it said ready: nothing else would ever stop it.
      void this.stopProcess();
      throw closed();
    }
  }

  /** A stuck server is tried again once its args file changed, or after `stuckRetryMs`. */
  private stuckExpired(): boolean {
    return this.now() - this.stuckAt >= this.stuckRetryMs || mtimeOf(this.plan.argsPath) !== this.stuckArgsMtime;
  }

  private runPrepare(): Promise<void> {
    const launch = this.plan.prepare;
    return new Promise((resolve, reject) => {
      const tail: string[] = [];
      let child: ChildProcess;
      try {
        child = this.spawnImpl(launch.file, launch.args, {
          cwd: this.plan.root,
          shell: false,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      } catch (error) {
        reject(new ServerFailure(`Could not start the sim server's prepare command: ${failureText(error)}`));
        return;
      }
      this.prepareChild = child;
      const timer = setTimeout(() => {
        this.killTree(child);
        const ms = this.prepareTimeoutMs;
        const limit = ms >= 60_000 ? `${String(Math.round(ms / 60_000))} min` : `${String(Math.round(ms / 1000))} s`;
        reject(new ServerFailure(`The sim server's prepare command did not finish within ${limit}, so it was stopped.`));
      }, this.prepareTimeoutMs);
      const settled = (): void => {
        clearTimeout(timer);
        if (this.prepareChild === child) {
          this.prepareChild = null;
          this.quietUntil = this.now() + this.prepareSettleMs;
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const lines = new LineSplitter((text) => {
        tail.push(text);
        if (tail.length > TAIL_LINES) tail.shift();
        this.line("stdout", text);
      });
      const errLines = new LineSplitter((text) => {
        tail.push(text);
        if (tail.length > TAIL_LINES) tail.shift();
        this.line("stderr", text);
      });
      child.stdout?.on("data", (chunk: Buffer | string) => {
        lines.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        errLines.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        settled();
        reject(
          new ServerFailure(
            error.code === "ENOENT"
              ? cannotStart(launch.file, "the sim server's prepare command")
              : `Could not start the sim server's prepare command: ${error.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        settled();
        lines.flush();
        errLines.flush();
        if (code === 0) resolve();
        else {
          // Its output gets no "exited with code" line, so the code goes in the message.
          const how = code === null ? "it was stopped" : `it exited with code ${String(code)}`;
          const why = explainFailure(code, tail, "Show the sim's output to see what it printed.");
          reject(new ServerFailure(`The sim server's prepare command failed: ${how}. ${why}`));
        }
      });
    });
  }

  private spawnServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let launch: { file: string; args: string[] };
      try {
        launch = this.serverLaunch(this.plan.argsPath);
      } catch (error) {
        reject(new ServerFailure(failureText(error)));
        return;
      }
      let child: ChildProcess;
      try {
        child = this.spawnImpl(launch.file, launch.args, {
          cwd: this.plan.cwd,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      } catch (error) {
        reject(new ServerFailure(`Could not start the sim server: ${failureText(error)}`));
        return;
      }
      const proc: ServerProcess = { child, exited: false, fatal: null, onGone: [] };
      this.proc = proc;
      let handshake: "waiting" | "ready" | "failed" = "waiting";
      const timer = setTimeout(() => {
        fail(new ServerFailure(`The sim server did not say it was ready within ${String(Math.round(this.readyTimeoutMs / 1000))} s.`));
      }, this.readyTimeoutMs);
      const fail = (failure: ServerFailure): void => {
        if (handshake !== "waiting") return;
        handshake = "failed";
        clearTimeout(timer);
        if (this.proc === proc) void this.stopProcess();
        reject(failure);
      };

      const out = new LineSplitter((text) => {
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          // Not protocol: something printed to stdout that should have gone to stderr. Show it as a line.
          this.line("stdout", text);
          return;
        }
        if (typeof message !== "object" || message === null || Array.isArray(message)) return;
        const record = message as Record<string, unknown>;
        if (handshake === "waiting") {
          if (record["type"] === "fatal") {
            fail(new ServerFailure(`The sim server could not start: ${typeof record["message"] === "string" ? record["message"] : "it gave no reason"}`));
            return;
          }
          if (record["type"] !== "ready") return;
          if (record["protocol"] !== SIM_SERVER_PROTOCOL) {
            const said = typeof record["protocol"] === "number" ? `protocol ${String(record["protocol"])}` : "no protocol version";
            const failure = new ServerFailure(
              `The robot code's sim server speaks ${said}, and this version of Zenith speaks protocol ${String(SIM_SERVER_PROTOCOL)}. Update whichever is older.`,
              true,
            );
            this.stuck = failure;
            this.stuckAt = this.now();
            this.stuckArgsMtime = mtimeOf(this.plan.argsPath);
            fail(failure);
            return;
          }
          handshake = "ready";
          clearTimeout(timer);
          // The JVM's own pid: the process spawned may be a `java` launcher stub that started it.
          if (typeof record["pid"] === "number") this.unthrottle(record["pid"]);
          this.generation += 1;
          resolve();
          return;
        }
        this.onMessage(proc, record);
      });
      const err = new LineSplitter((text) => {
        // An older server going away still prints; its lines are not the current run's log.
        if (this.proc !== proc) return;
        this.tail.push(text);
        if (this.tail.length > TAIL_LINES) this.tail.shift();
        this.line("stderr", text);
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: Buffer | string) => {
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        err.push(chunk);
      });
      child.stdin?.on("error", () => {
        // Writing to a server that just went: its exit says what happened.
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        fail(
          new ServerFailure(
            error.code === "ENOENT" ? `Could not start ${launch.file}: it is not installed or not on the PATH.` : `Could not start the sim server: ${error.message}`,
          ),
        );
        this.onExit(proc, null);
      });
      child.on("close", (code) => {
        out.flush();
        err.flush();
        fail(new ServerFailure(proc.fatal === null ? `The sim server stopped before it was ready (exit code ${String(code)}).` : `The sim server could not start: ${proc.fatal}`));
        this.onExit(proc, code);
      });
    });
  }

  /**
   * Asks the server to go, and kills its process tree if it has not gone shortly after. Settles once
   * it has gone, and with no server up, once the last one asked to go has, so a start never races it.
   */
  private stopProcess(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc === null || proc.exited) return this.stopping ?? Promise.resolve();
    // Settles when the process has gone, or a second after the kill in case its exit is never reported.
    const gone = new Promise<void>((resolve) => {
      proc.onGone.push(resolve);
      setTimeout(resolve, this.shutdownGraceMs + 1_000).unref?.();
    });
    const before = this.stopping;
    const stopping: Promise<void> = Promise.all([before, gone]).then(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    try {
      proc.child.stdin?.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      proc.child.stdin?.end();
    } catch {
      // Already closing.
    }
    const timer = setTimeout(() => {
      if (!proc.exited) this.killTree(proc.child);
    }, this.shutdownGraceMs);
    timer.unref?.();
    if (this.closed) this.killTree(proc.child);
    return stopping;
  }

  /** A watched path changed: the server and every cached trace are out of date. */
  markStale(): void {
    if (this.closed) return;
    this.stale = true;
    this.gaveUp = false;
    this.generation += 1;
    this.cache.clear();
    // A run under way finishes first; a server getting ready is started again once it is.
    if (this.active === null && this.ready === null) void this.stopProcess();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.speed !== "fast" || this.closed || this.proc === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active === null && this.queue.length === 0) void this.stopProcess();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private cachedFor(autoName: string, key: string): CacheEntry | null {
    if (this.speed !== "ultrafast" || this.stale) return null;
    const hit = this.cache.get(autoName);
    return hit !== undefined && hit.key === key && hit.generation === this.generation ? hit : null;
  }

  private keyOf(fileName: string): string {
    try {
      return autoContentKey(this.plan.root, fileName);
    } catch {
      return randomUUID();
    }
  }

  private write(message: Record<string, unknown>): void {
    const proc = this.proc;
    if (proc === null || proc.exited) return;
    try {
      proc.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler reports the server going.
    }
  }

  private status(status: "preparing" | "starting", message: string): void {
    this.lastStatus = { status, message };
    const clickId = this.waiting?.clickId ?? null;
    if (clickId !== null) this.emit({ runId: clickId, kind: "status", status, message });
  }

  /** A line the prepare command or the server printed, for the click it belongs to. */
  private line(stream: "stdout" | "stderr", raw: string): void {
    const clickId = this.active?.clickId ?? this.waiting?.clickId ?? null;
    if (clickId === null) return;
    this.emit({ runId: clickId, kind: "line", stream, text: raw.replace(ANSI, "") });
  }
}

const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Splits a stream into lines, keeping a partial last line until the next chunk. */
class LineSplitter {
  private partial = "";
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    const lines = (this.partial + chunk.toString()).split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    for (const line of lines) if (line !== "") this.onLine(line);
  }

  flush(): void {
    if (this.partial !== "") this.onLine(this.partial);
    this.partial = "";
  }
}

/* ---- Choosing Basic or the server ---------------------------------------- */

/**
 * What the IPC handlers call: runs a click at the person's speed, and keeps one sim server for the
 * open project. A project without `sim.server`, or the Basic speed, runs the sim command.
 */
export class SimDispatcher {
  private manager: SimServerManager | null = null;
  private root: string | null = null;
  private speed: DesktopSimSpeed = "fast";

  constructor(
    private readonly emit: (event: DesktopSimEvent) => void,
    readonly runner: SimRunner,
    private readonly deps: ServerDeps = {},
  ) {}

  /** The open project and the person's speed, after an open and every change. */
  configure(root: string | null, speed: DesktopSimSpeed): void {
    this.speed = speed;
    if (root !== this.root || speed === "basic") this.closeManager();
    this.root = root;
    if (root === null || speed === "basic") return;
    if (this.manager !== null) {
      this.manager.setSpeed(speed);
      return;
    }
    if (speed !== "ultrafast") return;
    try {
      this.managerFor(root)?.warm();
    } catch {
      // A sim.server that cannot start says why on the first click.
    }
  }

  /** Starts a click and returns its run id. Throws a bridge error for anything wrong before a run starts. */
  start(root: string, fileName: string, speed: DesktopSimSpeed = "basic"): string {
    const plan = buildSimPlan(root, fileName, this.deps.host);
    if (this.runner.running) throw new BridgeError("A sim is already running. Wait for it or cancel it first.");
    if (speed !== "basic" && (root !== this.root || speed !== this.speed)) this.configure(root, speed);
    let manager: SimServerManager | null = null;
    let unusable: string | null = null;
    if (speed !== "basic") {
      try {
        manager = this.managerFor(root);
      } catch (error) {
        unusable = failureText(error);
      }
    }
    if (unusable !== null) {
      const clickId = randomUUID();
      this.emit({ runId: clickId, kind: "started", command: plan.launch.display, autoName: plan.autoName, speed });
      this.fallback({ clickId, plan }, `The sim server cannot start: ${unusable}`);
      return clickId;
    }
    if (manager === null) return this.runner.start(plan);
    const runId = randomUUID();
    this.emit({ runId, kind: "started", command: `java @${manager.plan.argsRel}`, autoName: plan.autoName, speed });
    manager.click(runId, plan, fileName);
    return runId;
  }

  cancel(runId: string): void {
    if (this.runner.has(runId)) {
      this.runner.cancel(runId);
      return;
    }
    this.manager?.cancel(runId);
  }

  /** An auto file in `root` was written, by Zenith or by an edit elsewhere. */
  autoSaved(root: string, fileName: string): void {
    if (root === this.root) this.manager?.autoSaved(fileName);
  }

  /** Quit, or the window going: nothing the sim started may outlive the app. */
  shutdown(): void {
    this.runner.cancelAll();
    this.closeManager();
    this.root = null;
  }

  /** The manager, for tests. */
  get current(): SimServerManager | null {
    return this.manager;
  }

  /**
   * The manager for `root`'s `sim.server` as `zenith.json` has it now. It is read again for every
   * click, which is cheap, so an edit counts at once: a section that changed or went stops the old
   * server, and the click runs on a new one, or as Basic.
   */
  private managerFor(root: string): SimServerManager | null {
    let plan: ServerPlan | null;
    try {
      // Throws, worded for a person, when sim.server names a path outside the root or a command
      // that is not installed; the click then runs Basic and says so.
      plan = buildServerPlan(root, this.deps.host);
    } catch (error) {
      this.closeManager();
      throw error;
    }
    if (plan === null) {
      this.closeManager();
      return null;
    }
    if (this.manager !== null && JSON.stringify(this.manager.plan) === JSON.stringify(plan)) return this.manager;
    this.closeManager();
    this.root = root;
    this.manager = new SimServerManager(plan, this.speed, this.emit, (job, reason) => this.fallback(job, reason), this.deps);
    return this.manager;
  }

  private fallback(job: { clickId: string; plan: SimPlan }, reason: string): void {
    this.emit({ runId: job.clickId, kind: "status", status: "fallback", message: `${reason} Running the Basic sim instead.` });
    try {
      this.runner.start(job.plan, job.clickId);
    } catch (error) {
      this.emit({ runId: job.clickId, kind: "failed", message: failureText(error), tail: [], cancelled: false });
    }
  }

  private closeManager(): void {
    this.manager?.close();
    this.manager = null;
  }
}
