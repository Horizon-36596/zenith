/**
 * Compares a robot's `robot.json` with what its Java registers (`scanCommands.ts`), and fills in
 * what is missing without touching what a person wrote (Zenith's ADR 0014).
 *
 * - `checkCommandRegistry` lists every way the two disagree, for `zenith validate --java` and
 *   `zenith import-commands --check`.
 * - `mergeCommandScan` adds the commands, conditions and params the Java has and `robot.json`
 *   lacks. A new command gets `estimateS: "unknown"` and a provenance naming the file it came from;
 *   an existing entry keeps its summary, estimate, requires, flags, ledger hints and every param it
 *   already declares. Nothing is ever removed: a `robot.json` entry with no registration is a
 *   finding for a person to settle.
 *
 * Pure: data in, data out. The caller canonicalizes and writes the result.
 */
import type { CommandParam, CommandSpec, ConditionSpec, Robot } from "@horizon36596/zenith-schema";
import type { CommandScan, ScannedCommand, ScannedParam, SourceLocation } from "./scanCommands.js";

export interface RegistryFinding {
  severity: "error" | "warning" | "info";
  /** What the finding is about: a command, a condition, or something the scan could not read. */
  subject: "command" | "condition" | "scan";
  /** The command or condition, when there is one. */
  name?: string;
  /** The argument, when the finding is about one. */
  key?: string;
  /** Where in the Java, when the finding points at code. */
  at?: SourceLocation;
  message: string;
}

export interface RobotChange {
  kind: "addCommand" | "addCondition" | "addParam";
  name: string;
  key?: string;
  /** One sentence for a preview. */
  message: string;
}

export interface CommandMerge {
  /** The robot with the additions; the input robot is not changed. */
  robot: Robot;
  changes: RobotChange[];
  /** `checkCommandRegistry` of the merged robot: what is still wrong after the additions. */
  findings: RegistryFinding[];
}

const where = (at: SourceLocation): string => `${at.path}:${String(at.line)}`;
const quote = (value: unknown): string => JSON.stringify(value);

/** `robot.json`'s param for a scanned one, or null when there is not enough to write one (an enum whose constants are unknown). */
function paramFor(scanned: ScannedParam, provenance?: string): CommandParam | null {
  let param: CommandParam;
  switch (scanned.type) {
    case "integer":
    case "number":
      param = { type: scanned.type };
      if (typeof scanned.default === "number") param.default = scanned.default;
      break;
    case "string":
      param = { type: "string" };
      if (typeof scanned.default === "string") param.default = scanned.default;
      break;
    case "enum":
      if (scanned.values === undefined || scanned.values.length === 0) return null;
      param = { type: "enum", values: [...scanned.values] };
      if (typeof scanned.default === "string") param.default = scanned.default;
      break;
  }
  if (provenance !== undefined) param.provenance = provenance;
  return param;
}

const HELPER_OF: Record<ScannedParam["type"], string> = {
  integer: "argInt",
  number: "argDouble",
  string: "argString",
  enum: "argEnum",
};

function compareParam(command: string, declared: CommandParam, scanned: ScannedParam, out: RegistryFinding[]): void {
  const finding = (severity: RegistryFinding["severity"], message: string): void => {
    out.push({ severity, subject: "command", name: command, key: scanned.key, at: scanned.at, message });
  };
  const helper = HELPER_OF[scanned.type];
  const label = `${command}.${scanned.key}`;

  switch (scanned.type) {
    case "integer":
      if (declared.type === "number") {
        finding("warning", `robot.json lets ${label} be any number, but the Java reads it with argInt (${where(scanned.at)}), which refuses a fraction at init. Make it "integer".`);
      } else if (declared.type !== "integer") {
        finding("warning", `robot.json declares ${label} as ${declared.type}, but the Java reads it as a whole number with argInt (${where(scanned.at)}).`);
      }
      break;
    case "number":
      if (declared.type !== "integer" && declared.type !== "number") {
        finding("warning", `robot.json declares ${label} as ${declared.type}, but the Java reads it as a number with argDouble (${where(scanned.at)}).`);
      }
      break;
    case "string":
      if (declared.type !== "string" && declared.type !== "enum") {
        finding("warning", `robot.json declares ${label} as ${declared.type}, but the Java reads it as text with argString (${where(scanned.at)}).`);
      }
      break;
    case "enum":
      if (declared.type === "enum") {
        if (scanned.values !== undefined) {
          const unknown = declared.values.filter((value) => !(scanned.values as string[]).includes(value));
          if (unknown.length > 0) {
            finding("error", `robot.json offers ${unknown.map(quote).join(", ")} for ${label}, but ${scanned.enumType ?? "the enum"} has no such constant (it has ${scanned.values.join(", ")}), so the robot refuses ${unknown.length === 1 ? "it" : "them"} at init. Constants match case-sensitively.`);
          }
          const missing = scanned.values.filter((value) => !declared.values.includes(value));
          if (missing.length > 0) {
            finding("info", `${scanned.enumType ?? "The enum"} also has ${missing.join(", ")}, which robot.json does not offer for ${label}.`);
          }
        }
      } else if (declared.type === "string") {
        finding("warning", `robot.json lets ${label} be any text, but the Java reads it as the enum ${scanned.enumType ?? "(unknown)"} (${where(scanned.at)})${scanned.values === undefined ? "" : `, so only ${scanned.values.join(", ")} work`}. Make it an enum.`);
      } else {
        finding("warning", `robot.json declares ${label} as ${declared.type}, but the Java reads it as an enum with argEnum (${where(scanned.at)}).`);
      }
      break;
  }

  const declaredDefault = "default" in declared ? declared.default : undefined;
  if (scanned.required) {
    if (declaredDefault !== undefined) {
      finding("warning", `robot.json gives ${label} a default of ${quote(declaredDefault)}, but the Java requires it (${helper} with no fallback, ${where(scanned.at)}): a step that leaves it out fails at init.`);
    }
  } else if (scanned.default !== undefined) {
    if (declaredDefault === undefined) {
      finding("info", `The robot uses ${quote(scanned.default)} when a step leaves ${label} out (${where(scanned.at)}); robot.json could say so with "default": ${quote(scanned.default)}.`);
    } else if (declaredDefault !== scanned.default) {
      finding("warning", `The robot uses ${quote(scanned.default)} when a step leaves ${label} out (${where(scanned.at)}), but robot.json's default is ${quote(declaredDefault)}, so the editor shows and estimates the wrong value.`);
    }
  }
}

/**
 * Every way `robot.json`'s commands and conditions disagree with the Java's registrations, most
 * serious first, then in `robot.json` order. The scan's own issues come last.
 */
export function checkCommandRegistry(robot: Robot, scan: CommandScan): RegistryFinding[] {
  const out: RegistryFinding[] = [];
  const scanned = new Map(scan.commands.map((command) => [command.name, command]));
  const scannedConditions = new Map(scan.conditions.map((condition) => [condition.name, condition]));
  const unread = scan.unresolvedRegistrations;
  const files = `${String(scan.filesScanned)} scanned file${scan.filesScanned === 1 ? "" : "s"}`;
  const unlessUnread =
    unread === 0 ? "" : ` It may be one of the ${String(unread)} registration${unread === 1 ? "" : "s"} whose name could not be read; if so, this finding can be ignored.`;

  for (const command of robot.commands) {
    const found = scanned.get(command.name);
    if (found === undefined) {
      out.push({
        severity: unread === 0 ? "error" : "warning",
        subject: "command",
        name: command.name,
        message: `robot.json declares the command "${command.name}", but no NamedCommands.register("${command.name}", ...) was found in the ${files}, so an auto that uses it fails at init.${unlessUnread}`,
      });
      continue;
    }
    const params = command.params ?? {};
    for (const param of found.params) {
      const declared = params[param.key];
      if (declared === undefined) {
        out.push({
          severity: param.required ? "error" : "warning",
          subject: "command",
          name: command.name,
          key: param.key,
          at: param.at,
          message: param.required
            ? `The Java requires the argument ${command.name}.${param.key} (${HELPER_OF[param.type]}, ${where(param.at)}), which robot.json does not declare, so a step made in the editor leaves it out and fails at init.`
            : `The Java reads the optional argument ${command.name}.${param.key} (${HELPER_OF[param.type]}, ${where(param.at)}), which robot.json does not declare, so the editor cannot set it.`,
        });
        continue;
      }
      compareParam(command.name, declared, param, out);
    }
    if (found.complete) {
      for (const key of Object.keys(params)) {
        if (found.params.some((param) => param.key === key)) continue;
        out.push({
          severity: "warning",
          subject: "command",
          name: command.name,
          key,
          at: found.at[0],
          message: `robot.json declares ${command.name}.${key}, but the Java factory (${where(found.at[0] as SourceLocation)}) never reads it with an arg helper, so a value set in the editor does nothing on the robot.`,
        });
      }
    }
  }

  const declaredCommands = new Set(robot.commands.map((command) => command.name));
  for (const command of scan.commands) {
    if (declaredCommands.has(command.name)) continue;
    out.push({
      severity: "warning",
      subject: "command",
      name: command.name,
      at: command.at[0],
      message: `The Java registers the command "${command.name}" (${where(command.at[0] as SourceLocation)}), which robot.json does not declare, so the editor cannot offer it. zenith import-commands adds it.`,
    });
  }

  const conditions = robot.conditions ?? [];
  for (const condition of conditions) {
    if (scannedConditions.has(condition.name)) continue;
    out.push({
      severity: unread === 0 ? "error" : "warning",
      subject: "condition",
      name: condition.name,
      message: `robot.json declares the condition "${condition.name}", but no NamedCommands.registerCondition("${condition.name}", ...) was found in the ${files}, so an auto that waits on or branches on it fails at init.${unlessUnread}`,
    });
  }
  const declaredConditions = new Set(conditions.map((condition) => condition.name));
  for (const condition of scan.conditions) {
    if (declaredConditions.has(condition.name)) continue;
    out.push({
      severity: "warning",
      subject: "condition",
      name: condition.name,
      at: condition.at[0],
      message: `The Java registers the condition "${condition.name}" (${where(condition.at[0] as SourceLocation)}), which robot.json does not declare, so the editor cannot offer it. zenith import-commands adds it.`,
    });
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = out
    .map((finding, order) => ({ finding, order }))
    .sort((a, b) => rank[a.finding.severity] - rank[b.finding.severity] || a.order - b.order)
    .map(({ finding }) => finding);

  for (const issue of scan.issues) {
    const finding: RegistryFinding = { severity: issue.severity, subject: "scan", at: issue.at, message: issue.message };
    if (issue.command !== undefined) finding.name = issue.command;
    sorted.push(finding);
  }
  return sorted;
}

const provenanceFor = (at: SourceLocation | undefined): string => `SET FROM ${at?.path ?? "the robot's Java"}`;

function newCommand(scanned: ScannedCommand): CommandSpec {
  const params: Record<string, CommandParam> = {};
  for (const param of scanned.params) {
    const written = paramFor(param);
    if (written !== null) params[param.key] = written;
  }
  const spec: CommandSpec = { name: scanned.name, estimateS: "unknown" };
  if (Object.keys(params).length > 0) spec.params = params;
  // The command's own provenance covers its params: every one of them was read from the same factory.
  spec.provenance = `${provenanceFor(scanned.at[0])}; estimateS NEEDS MEASUREMENT`;
  return spec;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Adds what the Java registers and `robot.json` lacks. Existing entries keep everything they
 * have; new commands and conditions go after the existing ones, sorted by name, so the same
 * inputs always give the same file.
 */
export function mergeCommandScan(robot: Robot, scan: CommandScan): CommandMerge {
  const merged = copy(robot);
  const changes: RobotChange[] = [];

  for (const command of merged.commands) {
    const found = scan.commands.find((entry) => entry.name === command.name);
    if (found === undefined) continue;
    for (const param of found.params) {
      if (command.params?.[param.key] !== undefined) continue;
      const written = paramFor(param, provenanceFor(param.at));
      if (written === null) continue;
      command.params = { ...(command.params ?? {}), [param.key]: written };
      changes.push({
        kind: "addParam",
        name: command.name,
        key: param.key,
        message: `Add the ${param.required ? "required" : "optional"} ${written.type} argument ${command.name}.${param.key}${"default" in written && written.default !== undefined ? `, default ${quote(written.default)}` : ""} (${where(param.at)}).`,
      });
    }
  }

  const declared = new Set(merged.commands.map((command) => command.name));
  for (const found of scan.commands) {
    if (declared.has(found.name)) continue;
    const spec = newCommand(found);
    merged.commands.push(spec);
    const keys = Object.keys(spec.params ?? {});
    changes.push({
      kind: "addCommand",
      name: found.name,
      message: `Add the command ${found.name}${keys.length === 0 ? "" : ` with ${keys.join(", ")}`}, estimate "unknown" (${where(found.at[0] as SourceLocation)}).`,
    });
  }

  const conditions: ConditionSpec[] = merged.conditions ?? [];
  const declaredConditions = new Set(conditions.map((condition) => condition.name));
  const added: ConditionSpec[] = [];
  for (const found of scan.conditions) {
    if (declaredConditions.has(found.name)) continue;
    added.push({ name: found.name, provenance: provenanceFor(found.at[0]) });
    changes.push({ kind: "addCondition", name: found.name, message: `Add the condition ${found.name} (${where(found.at[0] as SourceLocation)}).` });
  }
  if (added.length > 0) merged.conditions = [...conditions, ...added];

  return { robot: merged, changes, findings: checkCommandRegistry(merged, scan) };
}
