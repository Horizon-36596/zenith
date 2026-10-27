/**
 * The `zenith-host/1` protocol (site/docs/host-protocol.md): the messages another web app and
 * Zenith pass each other with `window.postMessage` when that app opens Zenith in a popup to edit
 * an auto for it.
 *
 * Pure on purpose: the types, the one validator `parseHostMessage` and the constructors of what
 * Zenith sends, with no `window` and no DOM, so every rule here is unit-tested in node
 * (`hostProtocol.test.ts`). The origin check is `hostOrigins.ts`; the browser side is
 * `hostSession.ts`.
 */

export const HOST_PROTOCOL = "zenith-host/1";

/** A JSON document the host may send either parsed or as the text of the file. */
export type JsonDocument = Record<string, unknown> | string;

/** The robot project the host hands over in `open`. */
export interface HostProject {
  /** What the title bar shows for the project when there is no `hostLabel`. */
  name: string;
  /** A line naming what is being edited, such as the host's own name for the robot build. */
  hostLabel?: string;
  robot: JsonDocument;
  field: JsonDocument;
  waypoints?: JsonDocument;
  /** Auto name to the auto file's text. A name may or may not end in `.auto.json`. */
  autos: Record<string, string>;
}

export interface HostCapabilities {
  /** The host can run an auto through its own simulator and answer `run` with `trace`. */
  simulate?: boolean;
}

/**
 * Where the host's robot starts, offered as the start of a new auto: the start the person picked in
 * the host, as a pose on that alliance's side of the field (field inches and radians, the file
 * format's frame). Zenith mirrors it onto the field's own alliance, which a new auto is written for.
 */
export interface HostStartPose {
  alliance: "RED" | "BLUE";
  xIn: number;
  yIn: number;
  headingRad: number;
}

/** Host to Zenith: here is the project to edit. */
export interface HostOpenMessage {
  type: "open";
  protocol: typeof HOST_PROTOCOL;
  project: HostProject;
  /** The auto to open first. */
  open?: string;
  /** The robot comes from the host's own builder, so Zenith shows it as read only. */
  readOnlyRobot?: boolean;
  capabilities?: HostCapabilities;
  /**
   * Start a new auto once the project is open, even though `autos` is not empty. A host sends the
   * autos it already has with it, so the new auto gets a name none of them uses. Absent or false is
   * the older behaviour: a new auto is started only when `autos` is empty.
   */
  newAuto?: boolean;
  /**
   * Where a new auto made in this session starts, in place of a `start` waypoint or a legal start
   * Zenith finds by itself. Absent is the older behaviour.
   */
  newAutoStart?: HostStartPose;
  /**
   * The host's own build number, a whole number the host raises whenever what it sends in `open`
   * changes (its field, its robot builder's output). Zenith compares it with the lowest build it
   * expects from this host (`HostInfo.minBuild`); when it is older, Zenith says the host needs an
   * update and turns Save to and Simulate in off.
   * Absent means unknown, and nothing is said.
   */
  hostBuild?: number;
}

/** Host to Zenith: a recorded run of one auto, in the trace format `core.parseTrace` reads. */
export interface HostTraceMessage {
  type: "trace";
  auto: string;
  trace: Record<string, unknown>;
}

/**
 * Host to Zenith: the host could not run the auto a `run` asked for. Optional for a host to send:
 * without it Zenith waits out `RUN_TIMEOUT_MS`. `auto` is the name from the `run`; a host may leave
 * it out or send null, and then the answer is for the run Zenith is waiting on. With no run
 * waiting, or for another auto, Zenith ignores it.
 */
export interface HostRunFailedMessage {
  type: "runFailed";
  auto?: string;
  reason: string;
}

/** The longest `runFailed` reason Zenith shows; a longer one is cut there. */
export const RUN_FAILED_REASON_MAX = 500;

/** Host to Zenith: the answer to a `save`. */
export interface HostSavedMessage {
  type: "saved";
  name: string;
  ok: boolean;
  error?: string;
}

/** Host to Zenith: the host has ended the session. */
export interface HostCloseMessage {
  type: "close";
}

export type HostMessage =
  | HostOpenMessage
  | HostTraceMessage
  | HostRunFailedMessage
  | HostSavedMessage
  | HostCloseMessage;

/** Zenith to host: Zenith has loaded and is listening. Posted with target origin `"*"`. */
export interface ZenithReadyMessage {
  type: "ready";
  protocol: typeof HOST_PROTOCOL;
}

/** Zenith to host: write this auto. `text` is the canonical auto JSON. */
export interface ZenithSaveMessage {
  type: "save";
  name: string;
  text: string;
}

/** Zenith to host: simulate this auto and answer with `trace`. `text` is the canonical auto JSON. */
export interface ZenithRunMessage {
  type: "run";
  name: string;
  text: string;
}

/** Zenith to host: the window is going away. */
export interface ZenithByeMessage {
  type: "bye";
}

export type ZenithMessage = ZenithReadyMessage | ZenithSaveMessage | ZenithRunMessage | ZenithByeMessage;

export const readyMessage = (): ZenithReadyMessage => ({ type: "ready", protocol: HOST_PROTOCOL });
export const saveMessage = (name: string, text: string): ZenithSaveMessage => ({ type: "save", name, text });
export const runMessage = (name: string, text: string): ZenithRunMessage => ({ type: "run", name, text });
export const byeMessage = (): ZenithByeMessage => ({ type: "bye" });

/* ---- Validation ---------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDocument = (value: unknown): value is JsonDocument => typeof value === "string" || isRecord(value);

const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";

/** A build number: a whole number from 0 up, small enough to compare exactly. */
const optionalBuild = (value: unknown): boolean =>
  value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** The largest coordinate a start may name, in inches: far past any field, so only nonsense is refused. */
const START_LIMIT_IN = 1000;

/** A start pose: an alliance and three finite numbers, nothing else copied. Null for anything else. */
function parseStartPose(value: unknown): HostStartPose | null {
  if (!isRecord(value)) return null;
  const { alliance, xIn, yIn, headingRad } = value;
  if (alliance !== "RED" && alliance !== "BLUE") return null;
  const finite = (n: unknown, limit: number): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit;
  if (!finite(xIn, START_LIMIT_IN) || !finite(yIn, START_LIMIT_IN) || !finite(headingRad, 4 * Math.PI)) return null;
  return { alliance, xIn, yIn, headingRad };
}

/**
 * An auto name becomes a file name inside the synthesized `autos/` folder, so it may not climb out
 * of it or name a folder: no slashes, no backslashes, not `.` or `..`, and nothing unprintable.
 */
export function isSafeAutoName(name: string): boolean {
  if (name.trim() === "" || name.length > 200) return false;
  if (name === "." || name === "..") return false;
  return !/[/\\\u0000-\u001f\u007f]/.test(name);
}

/**
 * The autos map. Each value is the auto file's text; a host that sends the parsed object instead
 * gets it serialised, because Zenith re-reads and canonicalizes every auto either way.
 */
function parseAutos(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  // No prototype, so an auto a host really named `__proto__` is kept rather than swallowed by the
  // setter a plain object inherits.
  const autos: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, text] of Object.entries(value)) {
    if (!isSafeAutoName(name)) return null;
    if (typeof text === "string") autos[name] = text;
    else if (isRecord(text)) autos[name] = JSON.stringify(text);
    else return null;
  }
  return autos;
}

function parseProject(value: unknown): HostProject | null {
  if (!isRecord(value)) return null;
  const { name, hostLabel, robot, field, waypoints } = value;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (!optionalString(hostLabel)) return null;
  if (!isDocument(robot) || !isDocument(field)) return null;
  if (waypoints !== undefined && !isDocument(waypoints)) return null;
  const autos = parseAutos(value["autos"]);
  if (autos === null) return null;
  return {
    name,
    ...(typeof hostLabel === "string" && hostLabel.trim() !== "" ? { hostLabel } : {}),
    robot,
    field,
    ...(waypoints === undefined ? {} : { waypoints }),
    autos,
  };
}

function parseOpen(data: Record<string, unknown>): HostOpenMessage | null {
  if (data["protocol"] !== HOST_PROTOCOL) return null;
  const project = parseProject(data["project"]);
  if (project === null) return null;
  const { open, readOnlyRobot, capabilities, newAuto, hostBuild } = data;
  if (!optionalString(open) || !optionalBoolean(readOnlyRobot)) return null;
  if (!optionalBoolean(newAuto) || !optionalBuild(hostBuild)) return null;
  const newAutoStart = data["newAutoStart"] === undefined ? undefined : parseStartPose(data["newAutoStart"]);
  if (newAutoStart === null) return null;
  if (capabilities !== undefined && (!isRecord(capabilities) || !optionalBoolean(capabilities["simulate"]))) {
    return null;
  }
  return {
    type: "open",
    protocol: HOST_PROTOCOL,
    project,
    ...(typeof open === "string" ? { open } : {}),
    ...(typeof readOnlyRobot === "boolean" ? { readOnlyRobot } : {}),
    ...(capabilities === undefined
      ? {}
      : { capabilities: capabilities["simulate"] === undefined ? {} : { simulate: capabilities["simulate"] as boolean } }),
    ...(typeof newAuto === "boolean" ? { newAuto } : {}),
    ...(newAutoStart === undefined ? {} : { newAutoStart }),
    ...(typeof hostBuild === "number" ? { hostBuild } : {}),
  };
}

/**
 * The protocol an `open` names when it is not this one, or null. A host on a newer (or older)
 * protocol than this build still says `type: "open"`, and `parseHostMessage` drops the message; this
 * lets the page say that the versions differ instead of waiting out the clock and reporting that
 * no project came. Only a short printable name is returned, since it is shown to the person.
 */
export function otherOpenProtocol(data: unknown): string | null {
  if (!isRecord(data) || data["type"] !== "open") return null;
  const protocol = data["protocol"];
  if (typeof protocol !== "string" || protocol === HOST_PROTOCOL) return null;
  const trimmed = protocol.trim();
  if (trimmed === "" || trimmed.length > 40 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * The one gate every incoming message goes through: returns the message in its typed shape, or
 * null for anything that is not exactly a `zenith-host/1` host message. Only the fields the
 * protocol names are copied over, so nothing else a host sends can reach the editor. A message
 * other than `open` may carry `protocol`, and if it does it has to be this one.
 *
 * This checks shape only. Whether the robot, field and autos are valid Zenith files is decided
 * when they are loaded (`hostBackend.ts`), which reports a readable reason; whether the sender may
 * speak at all is the origin check in `hostSession.ts`.
 */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isRecord(data)) return null;
  const { type } = data;
  if (type === "open") return parseOpen(data);
  if (data["protocol"] !== undefined && data["protocol"] !== HOST_PROTOCOL) return null;
  if (type === "trace") {
    const { auto, trace } = data;
    if (typeof auto !== "string" || auto === "" || !isRecord(trace)) return null;
    return { type: "trace", auto, trace };
  }
  if (type === "runFailed") {
    const { reason } = data;
    // `auto: null` is a host saying it does not know which auto; it is read as no auto named.
    const auto = data["auto"] === null ? undefined : data["auto"];
    if (auto !== undefined && (typeof auto !== "string" || auto === "")) return null;
    if (typeof reason !== "string") return null;
    // Shown to the person, so only printable text, and not a page of it.
    const shown = reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, RUN_FAILED_REASON_MAX);
    if (shown === "") return null;
    return { type: "runFailed", ...(typeof auto === "string" ? { auto } : {}), reason: shown };
  }
  if (type === "saved") {
    const { name, ok, error } = data;
    if (typeof name !== "string" || typeof ok !== "boolean" || !optionalString(error)) return null;
    return { type: "saved", name, ok, ...(typeof error === "string" ? { error } : {}) };
  }
  if (type === "close") return { type: "close" };
  return null;
}
