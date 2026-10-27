/**
 * The argument form for a named command, built from `robot.json`'s `commands[].params`
 * (site/docs/file-format.md). The registry is the only source of the fields, their types and
 * their ranges, so the editor never guesses what a command takes.
 */
import type { CommandParam, CommandSpec } from "@horizon36596/zenith-schema";
import { CheckboxField, NumberField, SelectField, TextField } from "./fields";

export type Args = Record<string, string | number | boolean>;

/** A raw key in sentence case: `count` is Count, `preloadCount` is Preload count, `arm_state` is Arm state. */
export function sentenceCase(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * What an argument's row is called: the label robot.json gives it when it has one, otherwise its key
 * in sentence case (issue #410). The raw key stays in the row's hint (`argHint`).
 */
export function argLabel(key: string, param: object): string {
  const label = (param as { label?: unknown }).label;
  return typeof label === "string" && label.trim() !== "" ? label.trim() : sentenceCase(key);
}

/**
 * The row hint (W2-19 of the 0.1.2 sweep): what the argument means, from the sentence of the
 * command's summary that names it, what it takes and its range, from robot.json's schema for it, and
 * the raw key, which is what robot.json and the robot's code call it.
 */
export function argHint(key: string, param?: CommandParam, summary?: string): string {
  const parts: string[] = [];
  const named = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const said = (summary ?? "").match(/[^.!?]+[.!?]?/g)?.map((sentence) => sentence.trim()).find((sentence) => named.test(sentence));
  if (said !== undefined) parts.push(said.endsWith(".") ? said : `${said}.`);
  if (param !== undefined) parts.push(takes(param));
  parts.push(`The argument's key in robot.json: ${key}.`);
  return parts.join(" ");
}

/** What an argument takes, in words: "A whole number from 1 to 4, 1 by default." */
function takes(param: CommandParam): string {
  const fallback = param.default === undefined ? "" : `, ${String(param.default)} by default`;
  if (param.type === "enum") return `One of ${param.values.join(", ")}${fallback}.`;
  if (param.type === "boolean") return `On or off${fallback === "" ? "" : `, ${param.default === true ? "on" : "off"} by default`}.`;
  if (param.type === "string") return `Text${fallback}.`;
  const kind = param.type === "integer" ? "A whole number" : "A number";
  const range =
    param.min !== undefined && param.max !== undefined
      ? ` from ${String(param.min)} to ${String(param.max)}`
      : param.min !== undefined
        ? ` of at least ${String(param.min)}`
        : param.max !== undefined
          ? ` of at most ${String(param.max)}`
          : "";
  return `${kind}${range}${fallback}.`;
}

export function CommandArgsForm({
  spec,
  args,
  onChange,
  idPrefix = "arg",
}: {
  spec: CommandSpec | undefined;
  args: Args;
  onChange: (args: Args) => void;
  idPrefix?: string;
}) {
  if (spec === undefined) {
    return (
      <p className="unit" style={{ display: "block", padding: "var(--space-2) var(--pad-row-x)" }}>
        robot.json does not register this command, so it has no parameter form.
      </p>
    );
  }
  const params = Object.entries(spec.params ?? {});
  if (params.length === 0) {
    return (
      <p className="unit" style={{ display: "block", padding: "var(--space-2) var(--pad-row-x)" }}>
        This command takes no parameters.
      </p>
    );
  }

  const set = (name: string, value: string | number | boolean): void => {
    onChange({ ...args, [name]: value });
  };

  return (
    <>
      {params.map(([name, param]) => {
        const testId = `${idPrefix}-${name}`;
        if (param.type === "enum") {
          const current = args[name];
          const value =
            typeof current === "string" ? current : (param.default ?? param.values[0] ?? "");
          return (
            <SelectField
              key={name}
              label={argLabel(name, param)}
              rowHint={argHint(name, param, spec.summary)}
              value={value}
              testId={testId}
              options={param.values.map((option) => ({ value: option, label: option }))}
              onChange={(next) => {
                set(name, next);
              }}
            />
          );
        }
        if (param.type === "boolean") {
          const current = args[name];
          return (
            <CheckboxField
              key={name}
              label={argLabel(name, param)}
              rowHint={argHint(name, param, spec.summary)}
              checked={typeof current === "boolean" ? current : (param.default ?? false)}
              onChange={(next) => {
                set(name, next);
              }}
            />
          );
        }
        if (param.type === "string") {
          const current = args[name];
          return (
            <TextField
              key={name}
              label={argLabel(name, param)}
              rowHint={argHint(name, param, spec.summary)}
              testId={testId}
              value={typeof current === "string" ? current : (param.default ?? "")}
              onChange={(next) => {
                set(name, next);
              }}
            />
          );
        }
        const current = args[name];
        // No value and no declared default is an empty field, never the minimum dressed up as a
        // value the file carries (CLAUDE.md rule 4). The hint says the command is waiting for it.
        const value = typeof current === "number" ? current : (param.default ?? null);
        return (
          <NumberField
            key={name}
            label={argLabel(name, param)}
              rowHint={argHint(name, param, spec.summary)}
            testId={testId}
            value={value}
            step={param.type === "integer" ? 1 : 0.1}
            digits={param.type === "integer" ? 0 : 2}
            min={param.min}
            max={param.max}
            hint={
              value === null
                ? `This command needs ${name}; the step has no estimate until it has one. ${rangeHint(param.min, param.max) ?? ""}`.trim()
                : rangeHint(param.min, param.max)
            }
            onChange={(next) => {
              set(name, param.type === "integer" ? Math.round(next) : next);
            }}
          />
        );
      })}
    </>
  );
}

const rangeHint = (min: number | undefined, max: number | undefined): string | undefined => {
  if (min === undefined && max === undefined) return undefined;
  if (min === undefined) return `At most ${String(max)}.`;
  if (max === undefined) return `At least ${String(min)}.`;
  return `Between ${String(min)} and ${String(max)}.`;
};
