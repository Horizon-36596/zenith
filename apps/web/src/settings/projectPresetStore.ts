/**
 * The open project's presets in this page: read from its
 * presets folder through the project's backend each time Settings, Presets is shown, so a file a
 * teammate committed and this person pulled is there without opening the project again; and Add to
 * project, which writes one of the person's presets there. The rules are in `projectPresets.ts`.
 */
import { useSyncExternalStore } from "react";
import { keyContext } from "../app/keymap";
import { ensureWritable } from "../project/local";
import { projectPresetPath } from "../project/presetPaths";
import { projectKey } from "../project/types";
import { getState } from "../state/store";
import type { WriteOutcome } from "./actions";
import { presetFileName, presetFileText } from "./presetFile";
import { linkPresetToProject } from "./presetStore";
import type { UserPreset } from "./presets";
import { NO_PROJECT_PRESETS, projectPresetsReadOnlyReason, readProjectPresets, type ProjectPresetList } from "./projectPresets";

export interface ProjectPresetsView {
  /** The key of the project the list was read from, or null while no project is open. */
  project: string | null;
  list: ProjectPresetList;
  /** Why the folder could not be listed, or null. */
  error: string | null;
}

let view: ProjectPresetsView = { project: null, list: NO_PROJECT_PRESETS, error: null };
let reading = 0;
const listeners = new Set<() => void>();

const getView = (): ProjectPresetsView => view;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function set(next: ProjectPresetsView): void {
  view = next;
  for (const listener of listeners) listener();
}

export const useProjectPresets = (): ProjectPresetsView => useSyncExternalStore(subscribe, getView, getView);

/**
 * Reads the open project's presets again. A read that a newer one, or another project, overtook is
 * dropped, so the list is always the latest read of the project that is open.
 */
export async function refreshProjectPresets(): Promise<void> {
  const { project, backend } = getState();
  const ticket = (reading += 1);
  if (project === null || backend === null) {
    set({ project: null, list: NO_PROJECT_PRESETS, error: null });
    return;
  }
  const key = projectKey(project);
  const list = backend.listPresetFiles?.bind(backend);
  if (list === undefined) {
    set({ project: key, list: NO_PROJECT_PRESETS, error: null });
    return;
  }
  let next: ProjectPresetsView;
  try {
    const files = await list();
    const read = await readProjectPresets(files, (file) => backend.readText(projectPresetPath(project.link, file)), keyContext());
    next = { project: key, list: read, error: null };
  } catch (error) {
    next = {
      project: key,
      list: NO_PROJECT_PRESETS,
      error: `The project's presets could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (ticket === reading) set(next);
}

/** Why Add to project cannot write into the open project now, or null when it can. */
export function addToProjectReason(): string | null {
  const { project, backend } = getState();
  if (project === null || backend === null) return "Open a project first.";
  return projectPresetsReadOnlyReason(project.source, backend.writePresetFile !== undefined);
}

/**
 * Writes `preset` into the open project's presets folder with Export's text, links the preset to
 * that file and reads the folder again. `file` is the file to write, `<name>.zenith-preset.json`
 * unless the preset is already linked to one there; `nameInFile` keeps the name the team knows a
 * preset by when a renamed copy updates it. Settings asks first when the write replaces a file that
 * holds a different preset.
 */
export async function addPresetToProject(preset: UserPreset, file = presetFileName(preset.name), nameInFile?: string): Promise<WriteOutcome> {
  const { project, backend } = getState();
  if (project === null || backend === null) return { ok: false, message: "Open a project first." };
  const write = backend.writePresetFile?.bind(backend);
  const why = projectPresetsReadOnlyReason(project.source, write !== undefined);
  if (why !== null || write === undefined) return { ok: false, message: why ?? "This project cannot hold presets." };
  const path = projectPresetPath(project.link, file);
  const replacing = view.project === projectKey(project) && view.list.presets.some((one) => one.file === file);
  try {
    if (project.source.kind === "directory" && !(await ensureWritable(project.source.handle))) {
      return { ok: false, message: `The browser did not allow writing to this folder, so ${preset.name} was not added.` };
    }
    await write(file, presetFileText({ ...preset, name: nameInFile ?? preset.name }));
  } catch (error) {
    return { ok: false, message: `${preset.name} was not added to the project: ${error instanceof Error ? error.message : String(error)}` };
  }
  linkPresetToProject(preset.id, { project: projectKey(project), file });
  await refreshProjectPresets();
  return {
    ok: true,
    message: `${replacing ? "Updated" : "Added"} ${preset.name} in the project, at ${path}. Commit it so your teammates get it.`,
  };
}
