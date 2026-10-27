/**
 * Keeps the desktop app's native menu in step with the page: the resolved key of each menu item and the
 * items the feature switches hide go to the main process as `zenith:menu-keys` after load and after
 * every change, and the menu is rebuilt from them.
 *
 * Loaded on demand by `startDesktop`, since it reads the keymap and the actions, which import the
 * desktop module. A desktop app without `setMenuKeys` is left alone: its menu keeps the default keys.
 */
import { currentKeymap } from "../app/keymap";
import { actionShown, getFeatures } from "../state/features";
import { getState, subscribeEditor } from "../state/store";
import type { DesktopMenuKeys, ZenithDesktopBridge } from "./desktopBridge";
import { MENU_ITEMS, menuKeysMessage } from "./menuKeys";

/** The message for the person's keys and switches as they are now. */
export function currentMenuKeys(): DesktopMenuKeys {
  const keymap = currentKeymap();
  const features = getFeatures();
  return menuKeysMessage(
    (id) => {
      const binding = keymap.bindings.get(id);
      // An action this build does not list as a binding keeps the menu's default.
      return binding === undefined ? MENU_ITEMS.find((item) => item.id === id)?.key : binding.keys;
    },
    (id) => actionShown(id, features),
  );
}

/**
 * Sends the menu its keys now and again whenever the person's keys or switches change. Returns the
 * unsubscribe. A message the main process refuses is sent again after the next change.
 */
export function startMenuKeys(bridge: ZenithDesktopBridge): () => void {
  if (typeof bridge.setMenuKeys !== "function") return () => undefined;
  let sentFor: { keys: unknown; features: unknown } | null = null;
  let lastMessage = "";
  const send = (): void => {
    const { keys, features } = getState().prefs;
    if (sentFor !== null && sentFor.keys === keys && sentFor.features === features) return;
    sentFor = { keys, features };
    const message = currentMenuKeys();
    const text = JSON.stringify(message);
    if (text === lastMessage) return;
    lastMessage = text;
    bridge.setMenuKeys?.(message).catch(() => {
      lastMessage = "";
    });
  };
  send();
  return subscribeEditor(send);
}
