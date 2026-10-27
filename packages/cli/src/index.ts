#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { runAlliance } from "./commands/alliance.js";
import { runCalibrate } from "./commands/calibrate.js";
import { runCodegen } from "./commands/codegen.js";
import { runDeploy } from "./commands/deploy.js";
import { runDiff } from "./commands/diff.js";
import { runEstimate } from "./commands/estimate.js";
import { runImport } from "./commands/import.js";
import { runImportCommands } from "./commands/importCommands.js";
import { runInit } from "./commands/init.js";
import { runNew } from "./commands/new.js";
import { registerOpen } from "./commands/open.js";
import { OPTIMIZE_CLI_MODES, runOptimize, type OptimizeCliMode } from "./commands/optimize.js";
import { runGitHubStatus } from "./commands/githubStatus.js";
import { runPropose } from "./commands/propose.js";
import { runSetup } from "./commands/setup.js";
import { runProjection } from "./commands/projection.js";
import { runProposalApply, runProposalValidate } from "./commands/proposal.js";
import { runRender } from "./commands/render.js";
import { runSim } from "./commands/sim.js";
import { runValidate } from "./commands/validate.js";
import { isEntryPoint } from "./entryPoint.js";
import { VERSION } from "./version.js";

export * from "./lib.js";
export { VERSION };

/** A flag value that must be a number; commander reports anything else, and `main` exits 2. */
function parseNumber(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw new InvalidArgumentError("Expected a number.");
  return parsed;
}

/** A flag value that must be a whole number of at least 1. */
function parseWholeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("Expected a whole number of at least 1.");
  return parsed;
}

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
    .showHelpAfterError()
    // Throw instead of exiting, so a bad option or argument exits 2 (usage) like every other usage
    // error. Subcommands made after this inherit it.
    .exitOverride();

  program
    .command("validate")
    .description("Check autos against the schema and the feasibility rules, and trajectory.json or path.json files against the interchange format; exit 1 on any error.")
    .argument("[autos...]", "paths to .auto.json files, or to interchange trajectory.json or path.json files")
    .option("--json", "print findings as JSON")
    .option("--explain", "say what each finding means and how to fix it")
    .option(
      "--java <dir>",
      "also check robot.json against the NamedCommands registrations in the robot's Java or Kotlin under this directory (repeat for more)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--project <dir>", "the directory holding zenith.json")
    .action((autos: string[], options: { json?: boolean; explain?: boolean; java?: string[]; project?: string }) => {
      process.exitCode = runValidate(autos, options);
    });

  program
    .command("init")
    .description("Write zenith.json and an autos directory that validates.")
    .option("--json", "print what was written as JSON")
    .option("--force", "overwrite files that already exist")
    .option("--command-library <library>", "solverslib or ivy: the command library your robot code uses")
    .option("--robot-class <class>", "your ZenithRobot class, fully qualified: every OpMode zenith deploy writes constructs one")
    .action((options: { json?: boolean; force?: boolean; commandLibrary?: string; robotClass?: string }) => {
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
    .command("optimize")
    .description(
      "Find a faster route for one path step; a step that validate finds going through something gets the fastest clear route, even a slower one. A dry run unless you pass --write. Exit 0 improved or no better, 2 infeasible, 1 error.",
    )
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .requiredOption("--step <id>", "the id of the path step to optimize, at any depth")
    .option("--margin-in <in>", "the clearance to structures for this run, in inches (default: the robot's clearance); never saved", parseNumber)
    .option("--budget <n>", "how many candidates the search may score (default: set by the bench)", parseWholeNumber)
    .addOption(new Option("--score <model>", "score with the instant sim or the estimate (sim|estimate)").choices(["sim", "estimate"]).default("sim"))
    .addOption(new Option("--mode <mode>", "change the route and the heading, the route only, or the heading only").choices([...OPTIMIZE_CLI_MODES]).default("both"))
    .option("--no-split", "keep the route to one path")
    .option("--no-ranges", "keep the heading to one mode")
    .option("--max-paths <n>", "the most paths the route may have (default 4)", parseWholeNumber)
    .option("--hold-start-in <in>", "hold the start heading over the first this many inches of the route (default 0, off)", parseNumber)
    .option("--hold-end-in <in>", "reach the end heading this many inches before the end and hold it (default 0, off)", parseNumber)
    .option("--write", "save the improved route into the auto, in canonical form")
    .option("--json", "print the OptimizeResult as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      (
        auto: string,
        options: {
          step: string;
          marginIn?: number;
          budget?: number;
          score?: "sim" | "estimate";
          mode?: OptimizeCliMode;
          split?: boolean;
          ranges?: boolean;
          maxPaths?: number;
          holdStartIn?: number;
          holdEndIn?: number;
          write?: boolean;
          json?: boolean;
          project?: string;
        },
      ) => {
        process.exitCode = runOptimize(auto, options);
      },
    );

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
    .option(
      "--export",
      "write <Name>Exported.java instead: a standalone @Autonomous OpMode you own, which reads no auto file (not recommended)",
    )
    .action((auto: string, options: { json?: boolean; project?: string; export?: boolean }) => {
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

  registerOpen(program);

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
    .command("import")
    .description("Turn a Pedro Visualizer .pp project or a path.json into an auto, or a trajectory.json into a partner projection (or, with --as-auto, an auto).")
    .argument("<file>", "a .pp project, or an interchange path.json or trajectory.json")
    .option("--out <file>", "write the auto (or the projection) here instead of printing it")
    .option("--name <name>", "the imported auto's name, for a .pp or path.json file (default: the file's name)")
    .option("--alliance <alliance>", "RED or BLUE: the alliance a .pp path was drawn for (default: the field's canonical one)")
    .option("--pedro-centre <inches>", "the Pedro Visualizer's field centre in its own inches, for a .pp file (default 70.75; some teams use 72)")
    .option("--as-auto", "for a trajectory.json: write an auto that can be edited and shared, instead of a projection")
    .option("--force", "overwrite --out if it exists")
    .option("--json", "print the result, the warnings and the findings as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      (
        file: string,
        options: {
          out?: string;
          name?: string;
          alliance?: string;
          pedroCentre?: string;
          asAuto?: boolean;
          force?: boolean;
          json?: boolean;
          project?: string;
        },
      ) => {
        process.exitCode = runImport(file, options);
      },
    );

  program
    .command("import-commands")
    .description("Read the robot's NamedCommands registrations from its Java or Kotlin and add what robot.json is missing; exit 1 if robot.json still disagrees.")
    .argument("[dirs...]", "directories or files of the robot's Java or Kotlin (default: zenith.json's javaDir, or else the whole project; build output and test sources are skipped)")
    .option("--check", "write nothing; exit 1 when robot.json is missing something or disagrees with the Java")
    .option("--diff", "also print the robot.json lines that change")
    .option("--json", "print the scan, the changes and the findings as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action((dirs: string[], options: { check?: boolean; diff?: boolean; json?: boolean; project?: string }) => {
      process.exitCode = runImportCommands(dirs, options);
    });

  program
    .command("setup")
    .description("Get a robot repo clone ready for agents: init if needed, add the MCP server to .mcp.json, check GitHub and validate the autos.")
    .option("--json", "print the result as JSON")
    .option("--project <dir>", "the project directory (default: where zenith.json is, else the top of the git repository)")
    .action(async (options: { json?: boolean; project?: string }) => {
      process.exitCode = await runSetup(options);
    });

  const github = program.command("github").description("The GitHub side: where this clone's origin is and who is signed in.");

  github
    .command("status")
    .description("Print origin's owner/repo, its default branch, the signed-in login, the current branch and its open pull request.")
    .option("--json", "print the status as JSON")
    .option("--project <dir>", "a directory inside the robot repository clone")
    .action(async (options: { json?: boolean; project?: string }) => {
      process.exitCode = await runGitHubStatus(options);
    });

  program
    .command("propose")
    .description("Validate an auto, commit it with its render to a work branch, push and open or update its pull request.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--dry-run", "only validate, render and print the pull request body; no git, no GitHub")
    .option("--base <branch>", "the branch the pull request goes into (default: the repository's default branch)")
    .option("--branch <name>", "the work branch (default: auto/<auto>/<login>)")
    .option("--summary <text>", 'the commit summary after "auto(<auto>): " (default: edit)')
    .option(
      "--reviewer <login>",
      "ask this GitHub user to review (repeat for more)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--json", "print the result as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      async (
        auto: string,
        options: {
          dryRun?: boolean;
          base?: string;
          branch?: string;
          summary?: string;
          reviewer?: string[];
          json?: boolean;
          project?: string;
        },
      ) => {
        const { reviewer, ...rest } = options;
        process.exitCode = await runPropose(auto, { ...rest, reviewers: reviewer });
      },
    );

  program
    .command("projection")
    .description("Write the projection a share of an auto would send, as a file, without the cloud; exit 1 if the auto has an error.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .option("--level <level>", "view or propose: how much the other team sees", "view")
    .option("--title <title>", "the title the other team sees (default: none; the auto's own title is never sent)")
    .option("--coarsen", "round the timed layer to 2 in, 5 degrees and 0.25 s")
    .option("--include-commands", "add each command's name and arguments (default: off; commands stay opaque tokens)")
    .option("--out <file>", "write the projection here instead of printing it")
    .option("--force", "overwrite --out if it exists")
    .option("--json", "print the projection and where it was written as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      (
        auto: string,
        options: {
          level?: string;
          title?: string;
          coarsen?: boolean;
          includeCommands?: boolean;
          out?: string;
          force?: boolean;
          json?: boolean;
          project?: string;
        },
      ) => {
        process.exitCode = runProjection(auto, options);
      },
    );

  program
    .command("alliance")
    .description("Compare an auto with alliance partners' shared projections; exit 1 on any predicted collision or start overlap.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .argument("<projections...>", "paths to partners' projection .json files")
    .option("--json", "print the findings as JSON")
    .option("--offset <seconds>", "delay your robot's start by this many seconds", (value: string) => Number(value))
    .option("--project <dir>", "the directory holding zenith.json")
    .action((auto: string, projections: string[], options: { json?: boolean; offset?: number; project?: string }) => {
      process.exitCode = runAlliance(auto, projections, options);
    });

  const proposal = program
    .command("proposal")
    .description("Check a proposed change to a shared auto, or review and apply one to your own auto.");

  proposal
    .command("validate")
    .description("Check a proposal against the projection it was made from; exit 1 when it would be refused.")
    .argument("<proposal>", "path to the proposal .json file")
    .argument("<projection>", "path to the projection .json file the share gave you")
    .option("--share <state>", "the share's state: live, revoked or expired", "live")
    .option("--json", "print the findings as JSON")
    .action((proposalPath: string, projection: string, options: { share?: string; json?: boolean }) => {
      process.exitCode = runProposalValidate(proposalPath, projection, options);
    });

  proposal
    .command("apply")
    .description("Review a proposal against your auto and print the diff; with --write, make the accepted changes.")
    .argument("<auto>", "path to a .auto.json file, or its bare name in autosDir")
    .argument("<proposal>", "path to the proposal .json file")
    .option("--base <auto>", "the auto as it was at the revision the share is pinned to (default: <auto>)")
    .option("--accept <changes>", "all, none, or change numbers from 1 such as 1,2,5 (default: all, for the dry run)")
    .option("--share <state>", "the share's state: live, revoked or expired", "live")
    .option("--write", "write the auto with the accepted changes in place; needs --accept")
    .option("--json", "print the review as JSON")
    .option("--project <dir>", "the directory holding zenith.json")
    .action(
      (
        auto: string,
        proposalPath: string,
        options: { base?: string; accept?: string; share?: string; write?: boolean; json?: boolean; project?: string },
      ) => {
        process.exitCode = runProposalApply(auto, proposalPath, options);
      },
    );

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
    // Commander has already printed its own message; --help and --version end here with 0.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    process.stderr.write(`zenith: ${error instanceof Error ? error.message : String(error)}\n`);
    // Every thrown error reaching here is a usage or IO problem: loadProject not finding a project,
    // a missing zenith.json section, a bad --alliance, and so on. A verb's own findings-related
    // failure returns 1 directly from its run* function instead of throwing.
    return 2;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv);
}
