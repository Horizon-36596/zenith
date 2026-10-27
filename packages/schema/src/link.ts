import { z } from "zod";
import { formatVersionFor, schemaIdField } from "./ids.js";

/**
 * True for a path that names something inside the repository: relative, with `/` or `\`, and no
 * `..` part. The desktop app confines every such path to the root again before it uses one; this
 * check only says early, in `zenith validate`, that a path points outside.
 */
export const isInsideRootPath = (path: string): boolean => {
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]+/).some((part) => part === "..");
};

const projectPath = z.string().min(1).refine(isInsideRootPath, { message: "a path inside the repository, relative to zenith.json, with no .. part" });

/**
 * `zenith.json`: the link file at the robot repository root. It says where everything else lives
 * and how to run the simulator (site/docs/file-format.md).
 *
 * Key declaration order below is the canonical file order; canonicalize() follows it.
 */
export const linkSchema = z.object({
  $schema: schemaIdField("link"),
  formatVersion: formatVersionFor("link"),
  autosDir: z.string().min(1),
  robot: z.string().min(1),
  field: z.string().min(1),
  waypoints: z.string().min(1).optional(),
  deploy: z
    .object({
      kind: z.enum(["androidAssets", "directory"]),
      dir: z.string().min(1),
      /**
       * The command library the robot runtime builds on: `"solverslib"` (the
       * `org.horizon36596.zenith.solverslib` classes) or `"ivy"` (the `org.horizon36596.zenith.ivy` classes).
       * Neither is a default. It is optional here so that a file without it still loads in the editor
       * and validates, and so that a project that writes no Java needs none. Every command that writes
       * Java refuses until it is set: `zenith codegen`, and `zenith deploy` and the desktop app's Deploy
       * when there is a `codegen` section, because only then do they write OpMode stubs
       * (site/docs/command-libraries.md). It decides what the stubs and generated classes import;
       * nothing in an `*.auto.json` names a library.
       */
      commandLibrary: z.enum(["solverslib", "ivy"]).optional(),
      /**
       * The team's `ZenithRobot` implementation, fully qualified, with a public
       * no-argument constructor. Every OpMode stub `zenith deploy` writes constructs one, so it is
       * required once `codegen` is set. A dotted Java name and nothing else, because it is written into
       * Java source.
       */
      robotClass: z
        .string()
        .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/, "a fully qualified Java class name")
        .optional(),
      /** The TeleOp the Driver Station preselects after each generated auto. Omitted when unset. */
      preselectTeleOp: z.string().min(1).optional(),
      /**
       * The class every OpMode stub `zenith deploy` writes extends, fully qualified, in place of the
       * runtime's own `AutoFromFile` (issue #533): an abstract subclass of the chosen library's
       * `AutoFromFile`, where a team keeps its own logging, telemetry or start-up. The stub still names
       * the file and constructs `robotClass`. Unset means the runtime's `AutoFromFile`. A dotted Java
       * name and nothing else, because it is written into Java source. An optional addition, so
       * `zenith.json` stays at `formatVersion` 1.
       */
      opModeBase: z
        .string()
        .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/, "a fully qualified Java class name")
        .optional(),
    })
    .optional(),
  sim: z
    .object({
      command: z.string().min(1),
      trace: z.string().min(1),
      /**
       * A warm sim server that runs autos without a Gradle build per run (the protocol is in
       * site/docs/full-sim-simloop.md, "Full sim speed"). Optional, so `zenith.json` stays at
       * `formatVersion` 1: a project without it only has the Basic speed, which runs `command`.
       */
      server: z
        .object({
          /** Builds what the server needs and writes the `args` file; the same launcher rules as `command`. */
          prepare: z.string().min(1),
          /** The Java argument file the server is started with (`java @<args>`). */
          args: projectPath,
          /** The server's working directory; the project root when it is not set. */
          cwd: projectPath.optional(),
          /** Files and folders whose change means the server must be prepared and started again. */
          watch: z.array(projectPath).optional(),
        })
        .optional(),
    })
    .optional(),
  codegen: z
    .object({
      package: z.string().min(1),
      dir: z.string().min(1),
    })
    .optional(),
  /**
   * Where the robot's Java or Kotlin is, one directory or a list, relative to this file. When it
   * is set, `zenith validate` checks `robot.json`'s commands and conditions against the
   * `NamedCommands` registrations there, as `--java` does (Zenith's ADR 0014), and the editor's
   * Import commands from Java scans it by default. It may point outside the project, since the
   * robot code can live in another checkout; it is only ever read. An optional addition, so
   * `zenith.json` stays at `formatVersion` 1.
   */
  javaDir: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
});

/** `zenith.json`'s `javaDir` as a list: empty when it is not set. */
export const javaDirsOf = (link: { javaDir?: string | readonly string[] | undefined }): string[] =>
  link.javaDir === undefined ? [] : typeof link.javaDir === "string" ? [link.javaDir] : [...link.javaDir];

export type Link = z.infer<typeof linkSchema>;
