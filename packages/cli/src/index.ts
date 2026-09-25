#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { runCalibrate } from "./commands/calibrate.js";
import { runCodegen } from "./commands/codegen.js";
import { runDeploy } from "./commands/deploy.js";
import { runDiff } from "./commands/diff.js";
import { runEstimate } from "./commands/estimate.js";
import { runInit } from "./commands/init.js";
import { runNew } from "./commands/new.js";
import { runPropose } from "./commands/propose.js";
import { runRender } from "./commands/render.js";
import { runSim } from "./commands/sim.js";
import { runValidate } from "./commands/validate.js";
import { VERSION } from "./version.js";

export * from "./lib.js";
export { VERSION };

/**
 * The `zenith` binary (site/docs/cli-reference.md).
 *
 * Every verb has `--json` and none of them ever prompts, so an agent can drive the CLI. Exit codes
 * are the same convention across every verb: 0 ok, 1 the auto has findings errors, 2 usage, IO, or a
 * verb that depends on a `@horizon36596/zenith-core` M1 export (`estimate`, `ledger`, `render`, `diff`) that has
 * not landed yet.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("zenith")
    .description("An auto planner for FTC that humans and agents share. Horizon (FTC 36596).")
    .version(VERSION)
    .showHelpAfterError();

  program
    .command("validate")
    .description("Check autos against the schema and the feasibility rules; exit 1 on any error.")
    .argument("<autos...>", "paths to .auto.json files")
    .option("--json", "print findings as JSON")
    .option("--explain", "say what each finding means and how to fix it")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((autos: string[], options: { json?: boolean; explain?: boolean; project?: string }) => {
      process.exitCode = runValidate(autos, options);
    });

  program
    .command("init")
    .description("Write zenith.json and an autos directory that validates.")
    .option("--json", "print what was written as JSON")
    .option("--force", "overwrite files that already exist")
    .option("--command-library <library>", "solverslib or ivy: the command library your robot code uses")
    .action((options: { json?: boolean; force?: boolean; commandLibrary?: string }) => {
      process.exitCode = runInit(options);
    });

  program
    .command("new")
    .description("Write a new auto from a canonical skeleton.")
    .argument("<name>", "the auto's name, used for the file name too")
    .option("--json", "print what was written as JSON")
    .option("--force", "overwrite the file if it exists")
    .option("--project <dir>", "the directory holding zenith.json")
    .option("--alliance <alliance>", "RED or BLUE", "RED")
    .action(
      (name: string, options: { json?: boolean; force?: boolean; project?: string; alliance?: string }) => {
        process.exitCode = runNew(name, options);
      },
    );

  program
    .command("estimate")
    .description("Print the per-step time estimate and the total against the auto period.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--json", "print the estimate as JSON")
    .option("--explain", "also print the assumptions behind the numbers")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((auto: string, options: { json?: boolean; explain?: boolean; project?: string }) => {
      process.exitCode = runEstimate(auto, options);
    });

  program
    .command("render")
    .description("Draw an auto to SVG or PNG: the field, the path, findings and the ledger.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--svg <out>", "write an SVG file")
    .option("--png <out>", "write a PNG file (via @resvg/resvg-js)")
    .option("--alliance <alliance>", "RED or BLUE; mirrors the preview")
    .option("--base <auto>", "another auto to load for comparison (overlay pending core.render support)")
    .option("--json", "print what was written as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      async (
        auto: string,
        options: { svg?: string; png?: string; alliance?: string; base?: string; json?: boolean; project?: string },
      ) => {
        process.exitCode = await runRender(auto, options);
      },
    );

  program
    .command("codegen")
    .description("Write the readable, derived Java class for an auto (never edited by hand).")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--json", "print what was written as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((auto: string, options: { json?: boolean; project?: string }) => {
      process.exitCode = runCodegen(auto, options);
    });

  program
    .command("deploy")
    .description("Copy the autos, waypoints, robot and field files to the deploy directory, and refresh the @Autonomous stubs.")
    .option("--dry-run", "list what would happen without writing anything")
    .option("--json", "print the action list as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((options: { dryRun?: boolean; json?: boolean; project?: string }) => {
      process.exitCode = runDeploy(options);
    });

  program
    .command("diff")
    .description("Print the structural diff between two autos.")
    .argument("<a>", "path to the first .auto.json file")
    .argument("<b>", "path to the second .auto.json file")
    .option("--json", "print the diff as JSON")
    .action((a: string, b: string, options: { json?: boolean }) => {
      process.exitCode = runDiff(a, b, options);
    });

  program
    .command("sim")
    .description("Run zenith.json's sim command and print estimate vs actual per step from its trace.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--open", "also render an SVG of the plan next to the trace, and print its path")
    .option("--timeout <seconds>", "kill the sim command after this many seconds", (value: string) => Number(value))
    .option("--json", "print the report as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      async (
        auto: string,
        options: { open?: boolean; timeout?: number; json?: boolean; project?: string },
      ) => {
        process.exitCode = await runSim(auto, options);
      },
    );

  program
    .command("calibrate")
    .description("Fit accel, settleS and a per-heading-mode scale from recorded sim traces.")
    .option("--traces <dir>", "directory of *.trace.json files (default: traces/, or zenith.json's sim.trace directory)")
    .option("--write", "write the fitted accelInPerS2 and settleS into robot.json")
    .option("--date <date>", "the provenance date (default: today)")
    .option("--json", "print the fit as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((options: { traces?: string; write?: boolean; date?: string; json?: boolean; project?: string }) => {
      process.exitCode = runCalibrate(options);
    });

  program
    .command("propose")
    .description("Validate, render and print a PR body for an auto. Only --dry-run is implemented today.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--dry-run", "the only mode this build supports: print the PR body to stdout")
    .option("--base <branch>", "accepted for forward compatibility with GitHub mode; unused by --dry-run")
    .option("--json", "print the render path and the PR body as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((auto: string, options: { dryRun?: boolean; base?: string; json?: boolean; project?: string }) => {
      process.exitCode = runPropose(auto, options);
    });

  return program;
}

/**
 * Drops a single leading bare `--` from the verb's own arguments (`argv[2]`, right after the node
 * executable and the script path). `pnpm zenith -- <verb> ...` forwards that `--` literally, and
 * without stripping it commander treats it as "end of options": every flag after it, `--project`
 * included, is read as an operand instead of being parsed.
 */
export function stripWrapperSeparator(argv: readonly string[]): string[] {
  if (argv[2] !== "--") return [...argv];
  return [...argv.slice(0, 2), ...argv.slice(3)];
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    await buildProgram().parseAsync(stripWrapperSeparator(argv));
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  } catch (error) {
    process.stderr.write(`zenith: ${error instanceof Error ? error.message : String(error)}\n`);
    // Every thrown error reaching here is a usage or IO problem: loadProject not finding a project,
    // a missing zenith.json section, a bad --alliance, and so on. A verb's own findings-related
    // failure returns 1 directly from its run* function instead of throwing.
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv);
}
