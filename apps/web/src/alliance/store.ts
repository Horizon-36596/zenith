/**
 * The alliance view's own state: the partners loaded this session and the start offsets. It is a
 * separate store from the editor's on purpose. Nothing that saves, deploys or proposes an auto
 * reads it, so a predicted alliance finding can never block one (spec 13
 * section 9, "Alliance findings never block anything"); `alliance.gates.test.ts` holds that line.
 *
 * Partners live in memory only. A received projection is another team's data and never lands in
 * the project folder or in browser storage (section 13).
 */
import { useSyncExternalStore } from "react";
import { getState as getEditorState, setStatus, subscribeEditor } from "../state/store";
import { nextColour, partnerLabel, snapOffset, type PartnerEntry } from "./model";
import type { PartnerLoad, PartnerSource } from "./source";

export interface AllianceState {
  partners: PartnerEntry[];
  /**
   * Seconds the user's own robot waits at its start pose, on the 0.1 s grid. It is the offset of
   * the auto that is open: each auto of a project keeps its own (issue #193).
   */
  ownOffsetS: number;
  /** Whether the Partners panel is open, or folded to its header. */
  open: boolean;
}

let state: AllianceState = { partners: [], ownOffsetS: 0, open: false };
let nextId = 1;
const listeners = new Set<() => void>();

const set = (patch: Partial<AllianceState>): void => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getAllianceState = (): AllianceState => state;

export const useAllianceState = (): AllianceState => useSyncExternalStore(subscribe, getAllianceState, getAllianceState);

/**
 * The partner already in the view that `load` would add again: the same share, or for a file the
 * same file name with the same projection. Picking the same file twice would draw one robot twice
 * and double every finding, so it replaces its entry instead.
 */
function alreadyLoaded(partners: readonly PartnerEntry[], load: Extract<PartnerLoad, { ok: true }>): PartnerEntry | undefined {
  if (load.share !== undefined) return partners.find((partner) => partner.share?.shareId === load.share?.shareId);
  const text = JSON.stringify(load.projection);
  return partners.find(
    (partner) => partner.share === undefined && partner.fileName === load.fileName && JSON.stringify(partner.projection) === text,
  );
}

/**
 * Adds every projection that loaded, and returns what did not, for the status line. A file or share that
 * is already loaded (`alreadyLoaded`) replaces its entry instead of loading
 * twice, keeping the entry's colour, offset and whether it is shown; it is returned in `replaced`.
 */
export function addPartnerLoads(loads: readonly PartnerLoad[]): {
  added: PartnerEntry[];
  replaced: PartnerEntry[];
  failed: PartnerLoad[];
} {
  const added: PartnerEntry[] = [];
  const replaced: PartnerEntry[] = [];
  const failed: PartnerLoad[] = [];
  let partners = state.partners;
  for (const load of loads) {
    if (!load.ok) {
      failed.push(load);
      continue;
    }
    const same = alreadyLoaded(partners, load);
    if (same !== undefined) {
      const next: PartnerEntry = {
        id: same.id,
        fileName: load.fileName,
        projection: load.projection,
        label: partnerLabel(load.projection, load.fileName),
        colour: same.colour,
        visible: same.visible,
        offsetS: same.offsetS,
        ...(load.share === undefined ? {} : { share: load.share }),
      };
      partners = partners.map((partner) => (partner.id === same.id ? next : partner));
      // A file picked twice in one go is one partner, said once.
      const addedAt = added.findIndex((entry) => entry.id === same.id);
      if (addedAt >= 0) added[addedAt] = next;
      else if (!replaced.some((entry) => entry.id === same.id)) replaced.push(next);
      continue;
    }
    const entry: PartnerEntry = {
      id: `partner${String(nextId)}`,
      fileName: load.fileName,
      projection: load.projection,
      label: partnerLabel(load.projection, load.fileName),
      colour: nextColour(partners),
      visible: true,
      offsetS: 0,
      ...(load.share === undefined ? {} : { share: load.share }),
    };
    nextId += 1;
    partners = [...partners, entry];
    added.push(entry);
  }
  if (added.length > 0 || replaced.length > 0) set({ partners, open: true });
  return { added, replaced, failed };
}

/** Loads from a source and adds what it hands over. */
export async function loadPartners(
  source: PartnerSource,
): Promise<{ added: PartnerEntry[]; replaced: PartnerEntry[]; failed: PartnerLoad[] }> {
  return addPartnerLoads(await source.load());
}

/**
 * Puts a newer version of a partner in place of the one loaded, keeping its colour, its offset and
 * whether it is shown: what Reload does when a followed share has moved on. False when the partner
 * is gone or the load failed.
 */
export function replacePartner(id: string, load: PartnerLoad): boolean {
  if (!load.ok || !state.partners.some((partner) => partner.id === id)) return false;
  set({
    partners: state.partners.map((partner) => {
      if (partner.id !== id) return partner;
      const next: PartnerEntry = {
        id: partner.id,
        fileName: load.fileName,
        projection: load.projection,
        label: partnerLabel(load.projection, load.fileName),
        colour: partner.colour,
        visible: partner.visible,
        offsetS: partner.offsetS,
      };
      if (load.share !== undefined) next.share = load.share;
      return next;
    }),
  });
  return true;
}

export const removePartner = (id: string): void => {
  set({ partners: state.partners.filter((partner) => partner.id !== id) });
};

export const setPartnerVisible = (id: string, visible: boolean): void => {
  set({ partners: state.partners.map((partner) => (partner.id === id ? { ...partner, visible } : partner)) });
};

export const setPartnerOffset = (id: string, offsetS: number): void => {
  const snapped = snapOffset(offsetS);
  set({ partners: state.partners.map((partner) => (partner.id === id ? { ...partner, offsetS: snapped } : partner)) });
};

/**
 * The own start offsets of the open project, by auto file name. The offset belongs to one auto: it
 * is a view setting for that auto's alliance run, so it must not follow the user to the next one
 * and hide that auto's own predicted findings. `projectKey` is the open project's backend, one
 * object per open, so a new open of even the same folder starts with no offsets. `fileKey` is the
 * auto the state's `ownOffsetS` is showing; the empty string stands for no auto open.
 */
const ownOffsets = new Map<string, number>();
let projectKey: unknown = null;
let fileKey: string | null = null;

export const setOwnOffset = (offsetS: number): void => {
  const snapped = snapOffset(offsetS);
  ownOffsets.set(fileKey ?? "", snapped);
  set({ ownOffsetS: snapped });
};

const autoWords = (fileName: string): string => fileName.replace(/\.auto\.json$/, "");

/**
 * Follows the editor: a new or closed project clears the offsets (partners stay loaded), and
 * another auto shows its own offset. When the auto opened has none and the one left had one, the
 * status line says where that delay stayed.
 */
function followEditor(): void {
  const editor = getEditorState();
  if (editor.backend !== projectKey) {
    projectKey = editor.backend;
    fileKey = editor.fileName;
    ownOffsets.clear();
    if (state.ownOffsetS !== 0) set({ ownOffsetS: 0 });
    return;
  }
  if (editor.fileName === fileKey) return;
  const left = fileKey;
  const leftOffsetS = state.ownOffsetS;
  fileKey = editor.fileName;
  const offsetS = ownOffsets.get(fileKey ?? "") ?? 0;
  if (offsetS !== state.ownOffsetS) set({ ownOffsetS: offsetS });
  if (left !== null && fileKey !== null && leftOffsetS > 0 && offsetS === 0) {
    setStatus(
      "info",
      `Your start offset is 0 s for ${autoWords(fileKey)}. The ${leftOffsetS.toFixed(1)} s delay stays with ${autoWords(left)}.`,
    );
  }
}

subscribeEditor(followEditor);

export const setAlliancePanelOpen = (open: boolean): void => {
  set({ open });
};

/** Forgets every partner and offset: for tests. A closed or new project clears only the offsets. */
export const resetAlliance = (): void => {
  const editor = getEditorState();
  ownOffsets.clear();
  projectKey = editor.backend;
  fileKey = editor.fileName;
  set({ partners: [], ownOffsetS: 0, open: false });
};
