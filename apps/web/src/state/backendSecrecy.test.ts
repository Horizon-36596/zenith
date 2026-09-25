/**
 * Finding 36: `state.backend` reaches a `GitHubBackend` -> `GitHubClient` -> `HttpClient` ->
 * `PatAuth`, whose token is an ordinary field. Nothing in the app serialises the store today, so the
 * leak is latent, but `set` rebuilds `state` by spreading on every patch, and a plain field would be
 * one `JSON.stringify(getState())` away from writing the token out. `set` instead attaches `backend`
 * as a non-enumerable property, so it is invisible to `JSON.stringify`, `Object.keys` and a shallow
 * spread while `state.backend` (and `getState().backend`) keep working normally by dot access.
 *
 * This fixture stands in for a `GitHubBackend` without depending on `packages/github`'s `PatAuth`
 * directly (which finding 36 also names as a fix, in `packages/github/src/auth.ts`, owned
 * elsewhere): any object with a secret-shaped own field demonstrates the same leak.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import type { ProjectBackend, SaveResult } from "../project/backend";
import { closeProject, getState, openAuto, openProject, setStatus } from "./store";
import type { Project } from "../project/types";

const SECRET = "github_pat_11AAAAAAA0secretsecretsecretsecretsecretsecretsecretsecret";

/** A backend shaped like `GitHubBackend`: the secret sits as a plain field, several hops deep. */
function backendCarrying(secret: string): ProjectBackend {
  const httpClient = { auth: { pat: secret } };
  const githubClient = { http: httpClient };
  return {
    kind: "github",
    canPropose: true,
    // The token, unreachable from any public method, exactly as `state.auth` is documented to be,
    // but still an ordinary enumerable field an inner object graph away.
    client: githubClient,
    open: () => {
      throw new Error("not used");
    },
    listAutos: () => Promise.resolve([]),
    readAuto: () => {
      throw new Error("not used");
    },
    save: (): Promise<SaveResult> => {
      throw new Error("not used");
    },
    readText: () => Promise.reject(new Error("not used")),
  } as unknown as ProjectBackend;
}

const fixtureProject: Project = {
  source: { kind: "example" },
  name: "fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: {} as Project["robot"],
  field: {} as Project["field"],
  autoFiles: [],
  autoTexts: {},
};

const fixtureAuto = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "secrecy-fixture",
    title: "Secrecy fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [{ id: "wait", kind: "wait", seconds: 1 }],
  });

describe("the store keeps a backend out of any serialisation of state", () => {
  beforeEach(() => {
    closeProject();
  });

  it("does not enumerate backend, so JSON.stringify(getState()) never contains the token", () => {
    const backend = backendCarrying(SECRET);
    openProject(fixtureProject, backend);

    expect(getState().backend).toBe(backend);
    expect(JSON.stringify(getState())).not.toContain(SECRET);
    expect(Object.keys(getState())).not.toContain("backend");
    expect({ ...getState() }).not.toHaveProperty("backend");
  });

  it("keeps backend non-enumerable across every later patch, not only the one that set it", () => {
    const backend = backendCarrying(SECRET);
    openProject(fixtureProject, backend);
    const auto = fixtureAuto();
    openAuto("secrecy-fixture.auto.json", auto, "irrelevant");
    setStatus("info", "unrelated status update");

    expect(getState().backend).toBe(backend);
    expect(JSON.stringify(getState())).not.toContain(SECRET);
    expect(Object.keys(getState())).not.toContain("backend");
  });

  it("clears the backend on closeProject like every other field", () => {
    openProject(fixtureProject, backendCarrying(SECRET));
    closeProject();
    expect(getState().backend).toBeNull();
  });
});
