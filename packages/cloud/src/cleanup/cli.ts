/**
 * The retention clean-up's command line, which the scheduled workflow runs once a day:
 *
 *   pnpm cloud:cleanup [--dry-run]
 *
 * Against the real project it reads a service-account key, as JSON, from the environment variable
 * ZENITH_FIREBASE_SERVICE_ACCOUNT. The key stays in memory: it is never written to a file or printed,
 * and a key that does not parse is reported without quoting it. The project is the key's own
 * `project_id`.
 *
 * With FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST set, it runs against the emulators
 * instead and ignores any key: then `--project <id>` names the emulator project, and `--now <ISO time>`
 * may set the time of the run, for tests. `--now` is refused against the real project, where the time
 * is always the machine's clock.
 *
 * Exit status: 0 when the run did everything it planned, 1 when something failed (the log says what;
 * the next run picks up what is left), 2 when it is not configured or the arguments are wrong.
 */
import { pathToFileURL } from "node:url";
import { JWT } from "google-auth-library";
import { AdminRest, type RestTarget } from "./rest.js";
import { formatReport, runCleanup } from "./run.js";

export const SERVICE_ACCOUNT_VARIABLE = "ZENITH_FIREBASE_SERVICE_ACCOUNT";

/** The OAuth scope the key asks for; it covers Firestore and the Identity Toolkit API. */
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface CliArgs {
  dryRun: boolean;
  project: string | null;
  now: Date | null;
  help: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dryRun: false, project: null, now: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--project") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError("--project needs a project id.");
      args.project = value;
    } else if (arg === "--now") {
      const value = argv[++i];
      const date = value === undefined ? null : new Date(value);
      if (date === null || Number.isNaN(date.getTime())) throw new UsageError("--now needs a time such as 2026-09-28T04:17:00Z.");
      args.now = date;
    } else throw new UsageError(`Unknown argument ${String(arg)}. Run with --help to see the options.`);
  }
  return args;
}

const HELP = [
  "Deletes what the retention policy says is due: shares and invites that ended more than 30 days ago",
  "(with the requests for more time and proposals under those shares), and the profile and team",
  "memberships left by accounts that no longer exist in sign-in.",
  "",
  "  --dry-run          read and list what would be deleted, and delete nothing",
  "  --project <id>     the emulator project (emulators only; the real project is the key's)",
  "  --now <ISO time>   the time of the run (emulators only)",
  "",
  `The key is read from ${SERVICE_ACCOUNT_VARIABLE}; with FIRESTORE_EMULATOR_HOST and`,
  "FIREBASE_AUTH_EMULATOR_HOST set, the emulators are used instead.",
];

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** The key from the environment, or a UsageError that never quotes it. */
export function readServiceAccount(text: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${SERVICE_ACCOUNT_VARIABLE} is not valid JSON. Paste the whole key file into the secret.`);
  }
  const key = parsed as Partial<Record<keyof ServiceAccount, unknown>> | null;
  if (key === null || typeof key !== "object" || typeof key.project_id !== "string" || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new UsageError(`${SERVICE_ACCOUNT_VARIABLE} is not a service-account key: it needs project_id, client_email and private_key.`);
  }
  return { project_id: key.project_id, client_email: key.client_email, private_key: key.private_key };
}

/** Where the run goes, from the environment and the arguments. */
export function resolveTarget(env: Readonly<Record<string, string | undefined>>, args: CliArgs): { target: RestTarget; label: string } {
  const firestoreHost = env.FIRESTORE_EMULATOR_HOST;
  const authHost = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (firestoreHost !== undefined || authHost !== undefined) {
    if (firestoreHost === undefined || authHost === undefined) {
      throw new UsageError("Set both FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST to use the emulators, or neither.");
    }
    if (args.project === null) throw new UsageError("Name the emulator project with --project.");
    return {
      target: {
        projectId: args.project,
        firestoreOrigin: `http://${firestoreHost}`,
        identityOrigin: `http://${authHost}/identitytoolkit.googleapis.com`,
        token: () => Promise.resolve("owner"),
      },
      label: `the emulators, project ${args.project}`,
    };
  }
  if (args.now !== null) throw new UsageError("--now is for the emulators only; the real project always runs at the current time.");
  const text = env[SERVICE_ACCOUNT_VARIABLE];
  if (text === undefined || text.trim() === "") {
    throw new UsageError(`Clean-up is not configured: ${SERVICE_ACCOUNT_VARIABLE} is not set. Nothing was read or deleted.`);
  }
  const key = readServiceAccount(text);
  if (args.project !== null && args.project !== key.project_id) {
    throw new UsageError("--project names a different project from the key's. Leave it out; the key decides.");
  }
  const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });
  return {
    target: {
      projectId: key.project_id,
      firestoreOrigin: "https://firestore.googleapis.com",
      identityOrigin: "https://identitytoolkit.googleapis.com",
      token: async () => {
        let token: string | null | undefined;
        try {
          ({ token } = await jwt.getAccessToken());
        } catch (error) {
          // Only the OAuth error code (such as invalid_grant), never the request, which carries a
          // signed assertion.
          const code = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
          throw new Error(`the service account could not get an access token${typeof code === "string" ? ` (${code})` : ""}`);
        }
        if (typeof token !== "string" || token === "") throw new Error("the service account got no access token");
        return token;
      },
    },
    label: `project ${key.project_id}`,
  };
}

/** Runs the command and returns its exit status. `print` gets one line at a time. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void,
  clock: () => Date = () => new Date(),
): Promise<number> {
  let args: CliArgs;
  let resolved: { target: RestTarget; label: string };
  try {
    args = parseArgs(argv);
    if (args.help) {
      for (const line of HELP) print(line);
      return 0;
    }
    resolved = resolveTarget(env, args);
  } catch (error) {
    if (error instanceof UsageError) {
      print(error.message);
      return 2;
    }
    throw error;
  }
  print(`Zenith retention clean-up against ${resolved.label}.`);
  try {
    const report = await runCleanup(new AdminRest(resolved.target), { now: args.now ?? clock(), dryRun: args.dryRun });
    for (const line of formatReport(report)) print(line);
    return report.problems.length === 0 ? 0 : 1;
  } catch (error) {
    // A failed read: nothing was deleted. The message is an API status, never a document.
    print(`Problem: the clean-up stopped before deleting anything (${error instanceof Error ? error.message : String(error)}).`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env, (line) => console.log(line)).then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      console.log(`Problem: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
