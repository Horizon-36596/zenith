/**
 * The native menu command the desktop app sends for F10, kept apart from desktopActions.ts so the
 * main process can import it without the editor (main/index.ts sends it; the page opens the menu
 * under its title-bar button, where a click opens it).
 */
export const MENU_KEY_COMMAND = "desktop.menuKey";
