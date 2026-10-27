/**
 * The account's palette actions (spec 13 sections 4 to 6), added to the one
 * action table only when the cloud is on, the way the desktop app's are added only in the desktop
 * app: with the cloud off, the palette is exactly what it is without accounts.
 */
import { CloudUpload, Inbox, LibraryBig, LogIn, UsersRound } from "lucide-react";
import type { ActionDef } from "../app/actions";
import { publishOpenAuto, whyCannotPublishOpenAuto } from "../library/actions";
import { cloudEnabled } from "./config";
import { whyCannotOpenLibrary, whyCannotPublish } from "./permissions";
import { openSettings } from "../settings/store";
import { account, openAccountPanel } from "./store";

const signedIn = (): boolean => account.getState().user !== null && account.getState().profile !== null;
const NOT_SIGNED_IN = (): string => "Sign in first.";
const libraryWhy = (): string | null => (signedIn() ? whyCannotOpenLibrary(account.role()) : NOT_SIGNED_IN());
const publishWhy = (): string | null =>
  signedIn() ? (whyCannotPublish(account.role()) ?? whyCannotPublishOpenAuto()) : NOT_SIGNED_IN();

export const ACCOUNT_ACTIONS: ActionDef[] = cloudEnabled()
  ? [
      {
        id: "account.open",
        label: "Sign in or open your account",
        keywords: ["sign in", "log in", "account", "profile", "sign out", "export", "delete"],
        does: "Sign in for the team library and sharing, or open your account in Settings once you are signed in.",
        group: "project",
        icon: LogIn,
        run: () => {
          if (signedIn()) openSettings("account");
          else openAccountPanel("signIn");
        },
      },
      {
        id: "account.teams",
        label: "Teams",
        keywords: ["team", "members", "invite", "roles", "approve", "join", "activity"],
        does: "Create a team, invite members, approve them and change their roles.",
        group: "project",
        icon: UsersRound,
        run: () => {
          openAccountPanel("teams");
        },
        enabled: signedIn,
        whyDisabled: NOT_SIGNED_IN,
      },
      {
        id: "account.library",
        label: "Team library",
        keywords: ["library", "revisions", "history", "publish", "download", "offline"],
        does: "Open your team's autos and every revision of them.",
        group: "project",
        icon: LibraryBig,
        run: () => {
          openAccountPanel("library");
        },
        enabled: () => libraryWhy() === null,
        whyDisabled: () => libraryWhy() ?? "",
      },
      {
        id: "account.publish",
        label: "Publish to the team library",
        keywords: ["publish", "library", "revision", "upload", "team"],
        does: "Add the saved auto to your team's library as a new revision. Nothing is overwritten.",
        group: "project",
        icon: CloudUpload,
        run: () => publishOpenAuto(),
        enabled: () => publishWhy() === null,
        whyDisabled: () => publishWhy() ?? "",
      },
      {
        id: "account.outbox",
        label: "Outbox",
        keywords: ["outbox", "offline", "queue", "sync", "pending", "sent"],
        does: "See the changes made on this computer and whether the server has them yet.",
        group: "project",
        icon: Inbox,
        run: () => {
          openAccountPanel("outbox");
        },
        enabled: signedIn,
        whyDisabled: NOT_SIGNED_IN,
      },
    ]
  : [];
