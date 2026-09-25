/**
 * The argument form for a named command, built from `robot.json`'s `commands[].params`
 * (site/docs/file-format.md). The registry is the only source of the fields, their types and
 * their ranges, so the editor never guesses what a command takes.
 */
import type { CommandSpec } from "@horizon36596/zenith-schema";
import { CheckboxField, NumberField, SelectField, TextField } from "./fields";

export type Args = Record<string, string | number | boolean>;

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
              label={name}
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
              label={name}
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
              label={name}
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
            label={name}
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
