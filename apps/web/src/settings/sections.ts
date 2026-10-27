/**
 * The Settings window's sections (issue #97), as pure logic: which exist, which a person sees, and
 * which one opens. The window (`SettingsWindow.tsx`) draws them; nothing here touches the DOM, the
 * stores or storage, so every rule is tested in `sections.test.ts`.
 */

export type SettingsSection =
  | "account"
  | "presets"
  | "teams"
  | "general"
  | "robot"
  | "commands"
  | "editor"
  | "keyboard"
  | "data"
  | "admin"
  | "developer";

export interface SectionInfo {
  id: SettingsSection;
  /** The name in the list and the pane's title. The title says what is in it, so there is no summary line. */
  label: string;
}

/** Every section, in the order the list shows them. */
export const SECTIONS: readonly SectionInfo[] = [
  { id: "account", label: "Account" },
  { id: "presets", label: "Presets" },
  { id: "general", label: "General" },
  { id: "robot", label: "Robot" },
  { id: "commands", label: "Commands" },
  { id: "editor", label: "Editor" },
  { id: "keyboard", label: "Keyboard" },
  { id: "teams", label: "Teams" },
  { id: "data", label: "Privacy and data" },
  { id: "admin", label: "Admin" },
  { id: "developer", label: "Developer" },
];

export const sectionInfo = (id: SettingsSection): SectionInfo =>
  SECTIONS.find((section) => section.id === id) ?? (SECTIONS[0] as SectionInfo);

/** What decides which sections a person sees. */
export interface SectionContext {
  /** Whether this build has the cloud at all. Off, there is no account and nothing that needs one. */
  cloud: boolean;
  /** Signed in with a profile. */
  signedIn: boolean;
  /** A signed-in Horizon admin. */
  admin: boolean;
  /** The fake cloud (`?cloud=fake`), which has test users to switch between. */
  fake: boolean;
  /** A development build, which shows the cloud reads readout. */
  dev: boolean;
  /** The Commands switch in General (`state/features.ts`). Off, the Commands section is hidden too. */
  commands: boolean;
}

/**
 * The sections this person sees, in list order. Presets, General, Robot, Editor and Keyboard are always there, and
 * Commands while the Commands switch is on. Account shows
 * whenever the cloud is on, so a signed-out person can sign in from it; Teams and Privacy and data
 * need an account; Admin is for Horizon admins; Developer appears only where its controls did before,
 * in the fake cloud or a development build, for someone signed in.
 */
export function visibleSections(context: SectionContext): SettingsSection[] {
  const shown = (id: SettingsSection): boolean => {
    switch (id) {
      case "account":
        return context.cloud;
      case "teams":
      case "data":
        return context.cloud && context.signedIn;
      case "admin":
        return context.cloud && context.signedIn && context.admin;
      case "developer":
        return context.cloud && context.signedIn && (context.fake || context.dev);
      case "commands":
        return context.commands;
      case "presets":
      case "general":
      case "robot":
      case "editor":
      case "keyboard":
        return true;
    }
  };
  return SECTIONS.map((section) => section.id).filter(shown);
}

const IDS: ReadonlySet<string> = new Set(SECTIONS.map((section) => section.id));

/**
 * A remembered section, or null when the stored value is not one. `code`, the section General
 * replaced (issue #101), opens General.
 */
export const parseSection = (value: unknown): SettingsSection | null =>
  value === "code" ? "general" : typeof value === "string" && IDS.has(value) ? (value as SettingsSection) : null;

/**
 * The section to show: the one asked for when the person can see it, else the first one they can.
 * Asking for a hidden section (Teams after signing out, Admin for someone who is not one) lands on
 * the first section rather than an empty pane.
 */
export function resolveSection(wanted: SettingsSection | null, visible: readonly SettingsSection[]): SettingsSection {
  if (wanted !== null && visible.includes(wanted)) return wanted;
  return visible[0] ?? "general";
}

/** The sign-in methods an account carries, as the sign-in panel names them. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "github.com": "GitHub",
  "google.com": "Google",
  "microsoft.com": "Microsoft",
  emailLink: "Email link",
  password: "Email link",
};

/** What the Account section says the person signs in with, from `CloudUser.providerIds`. */
export function signInMethodOf(providerIds: readonly string[]): string {
  const names = [...new Set(providerIds.map((id) => PROVIDER_NAMES[id] ?? id))];
  return names.length === 0 ? "Unknown" : names.join(", ");
}

/**
 * The close button's hint. Every section saves each change as it is made, except Robot, which keeps
 * a draft until Save robot.json (issue #313). While that draft holds a change, the hint says so rather
 * than claiming everything is saved, and closing asks what to do with it (issue #414).
 */
export function closeHint(unsavedRobotFile: string | null): string {
  if (unsavedRobotFile === null) return "Close Settings. Everything here is already saved.";
  return `Close Settings. Robot has unsaved changes to ${unsavedRobotFile}, so closing asks whether to save them.`;
}
