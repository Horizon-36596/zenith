import { z } from "zod";
import { formatVersionFor, schemaIdField } from "./ids.js";

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
    })
    .optional(),
  sim: z
    .object({
      command: z.string().min(1),
      trace: z.string().min(1),
    })
    .optional(),
  codegen: z
    .object({
      package: z.string().min(1),
      dir: z.string().min(1),
    })
    .optional(),
});

export type Link = z.infer<typeof linkSchema>;
