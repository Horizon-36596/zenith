# Zenith cloud: Firebase setup and data model

Zenith's teams, team library and sharing (for users, the docs site's
[Teams and sharing](https://libraries.horizon36596.org/zenith/teams-and-sharing/) page) run on Firebase
Authentication and Cloud Firestore on the no-cost **Spark** plan. There is no server code: everything is
enforced by the security rules in this folder, and everything a team makes is encrypted on its devices
by `packages/cloud` before it reaches the database.

| file | what it is |
|---|---|
| `firestore.rules` | the security rules: who may read and write every document |
| `firestore.indexes.json` | the collection-group index for "my teams", and index exemptions for the large fields and every ciphertext and key field |
| `firebase.json` | tells the Firebase CLI where the two files above are, and configures the local emulators |
| `web-config.json` | the production project's Firebase web config and App Check site key, which every public build is made with (see "Public builds" below) |

The client is `packages/cloud` (`@horizon36596/zenith-cloud`): the `CloudBackend` interface, with
`FirebaseBackend` for the real service and `MemoryBackend` for tests.

## Setting up the Firebase project (the owner's steps)

Agents never touch the Firebase console; these steps are for the owner, once. They were written
without access to the console, so a button may have a slightly different name. Nothing here needs a payment card, and nothing should ever
ask for one: if the console offers the Blaze plan, decline it.

Commands are for **Windows PowerShell 5.1**. PowerShell 5.1 has no `&&`, so every command is on its
own line; run them one at a time from the repository's folder.

### 1. Create the project

1. Open <https://console.firebase.google.com> signed in with the Horizon Google account that will own
   the project. Turn on two-step verification for that account first.
2. **Create a project**. Name it `zenith` and note the **project id** the console shows under the name
   (for example `zenith-3f2a1`); later steps call it `<project-id>`.
3. When asked about **Google Analytics**, turn it **off**. Zenith collects no analytics (spec 13 section
   12.1).
4. The project starts on the **Spark** plan. Leave it there.

### 2. Create the Firestore database

1. **Build**, then **Firestore Database**, then **Create database**.
2. Pick the **location**. It cannot be changed later. A multi-region in the United States (`nam5`) or in
   Europe (`eur3`) are the usual choices; Zenith's users are in both, so this is the owner's call.
3. Start in **production mode** (everything locked). Step 5 replaces those rules with Zenith's.

### 3. Register the web app

1. **Project settings** (the gear), **General**, **Your apps**, then the web icon (`</>`).
2. Nickname: `Zenith web`. Do **not** tick Firebase Hosting; the app stays on GitHub Pages.
3. The console shows a `firebaseConfig` object (`apiKey`, `authDomain`, `projectId`, `appId`, and a few
   more). Copy it into a pull request or a message for the agent that wires the web app: it is not a
   secret, and it is what `FirebaseBackendOptions.config` takes.

### 4. Turn on sign-in

**Build**, **Authentication**, **Get started**, then the **Sign-in method** tab.

- **Email link**: leave it off. The no-cost Spark plan sends at most 5 sign-in emails a day for the
  whole project, so the app does not offer it unless the build sets `VITE_ZENITH_EMAIL_LINK=on`. If
  the project ever moves to Blaze, enable the **Email/Password** provider and, inside it, **Email link
  (passwordless sign-in)**, and set that variable. Zenith never offers passwords; the client has no
  password code.
- **Google**: enable it and choose the project support email.
- **GitHub**: enable it. The console shows a callback URL like
  `https://<project-id>.firebaseapp.com/__/auth/handler`. In a second tab, open the Horizon-36596
  organization on GitHub, **Settings**, **Developer settings**, **OAuth Apps**, **New OAuth App**:
  application name `Zenith`, homepage `https://libraries.horizon36596.org/zenith/`, authorization
  callback URL the one Firebase showed. Copy the new app's **Client ID** and a new **Client secret**
  back into Firebase.
- **Microsoft**: enable it. In the Azure portal (<https://portal.azure.com>), **Microsoft Entra ID**,
  **App registrations**, **New registration**: name `Zenith`; supported account types **Accounts in any
  organizational directory and personal Microsoft accounts**; redirect URI of type **Web**, the same
  Firebase callback URL. Then **Certificates & secrets**, **New client secret**. Copy the
  **Application (client) ID** and the secret's **Value** into Firebase. Note the secret's expiry date
  where the team keeps its security reminders: sign-in with Microsoft stops when it expires.
- **Settings** tab, **Authorized domains**: add `zenith.horizon36596.org`, the public web app's
  host, and `libraries.horizon36596.org`, which serves a copy of it under the docs. `localhost` is there already, for development. The desktop app needs no entry: it signs in
  through the system browser (step 4a), not the popup.

### Public builds

Every public build talks to the production project. Its Firebase web config and App Check site key
are in `cloud/web-config.json`, which is committed because neither is a secret (every page the web app
serves carries both). `scripts/release-cloud.mjs` reads it: the Pages build (`scripts/build-pages.mjs`)
and the desktop installers (`apps/desktop/scripts/dist.mjs`, and `.github/workflows/release.yml`) are
built with it, and `node scripts/release-cloud.mjs check` fails a release build that lacks the config
or every desktop sign-in client. The App Check site key is optional: without one, the check warns
and App Check stays off (step 7). To move releases to another project, change
the file in a pull request. The desktop sign-in clients (step 4a) are not in the file: the release
workflow takes them from the repository's Actions variables `ZENITH_GITHUB_CLIENT_ID`,
`ZENITH_GOOGLE_DESKTOP_CLIENT_ID` and `ZENITH_MICROSOFT_CLIENT_ID` and the Actions secret
`ZENITH_GOOGLE_DESKTOP_CLIENT_SECRET`, because Google revokes a client secret it finds in a public
repository. `pnpm build` and the dev server never read the file, so a build from source has the cloud
off unless it is given `VITE_ZENITH_FIREBASE_CONFIG` itself.

### 4a. Sign-in clients for the desktop app

The installed desktop app cannot use Firebase's sign-in popup: the popup only works for a page on a web
address, and the app's page is `zenith://app`. So the desktop app signs in through the system browser
and hands the result to Firebase (`apps/desktop/src/main/nativeSignIn.ts`). That needs one OAuth client per provider that an installed app may use. Nothing here costs
anything, and none of the values is a secret: an installed app cannot keep one. A provider you skip is
simply hidden in the desktop app, with a line saying why; the web app is not affected.

- **GitHub**: reuse the OAuth app from step 4. On its settings page, tick **Enable Device Flow** and
  save. The desktop app uses GitHub's device flow, which needs only the **Client ID** (the client secret
  stays in Firebase and never goes into the app). Nothing else changes.
- **Google**: in the Google Cloud console (<https://console.cloud.google.com>), pick the Firebase
  project itself (Firebase projects are Google Cloud projects), then **APIs & Services**,
  **Credentials**, **Create credentials**, **OAuth client ID**, application type **Desktop app**, name
  `Zenith desktop`. Note its **Client ID** and **Client secret**. Google asks for that secret during
  sign-in even though it says a desktop client's secret "is obviously not treated as a secret", so it
  goes into the build like the id. Desktop clients need no redirect URI registered. If the client ends up
  in a different project from Firebase, add its client ID in Firebase, **Authentication**, **Sign-in
  method**, **Google**, **Safelist client IDs from external projects**.
- **Microsoft**: reuse the app registration from step 4, so the ID token's audience is the client ID
  Firebase already knows. In the Azure portal, open it, **Manifest**, and add `http://127.0.0.1` to
  `publicClient.redirectUris` (in the older manifest format: an entry in `replyUrlsWithType` with
  `"url": "http://127.0.0.1"` and `"type": "InstalledClient"`). The portal's text box refuses an `http`
  loopback address, which is why this goes through the manifest; Microsoft ignores the port of a
  loopback redirect, so the app may use any. No new secret: a desktop app signs in as a public client.
- **Firebase API key**: leave it unrestricted by HTTP referrer (restricting it by API is fine). The
  desktop app's requests come from `zenith://app`, which a referrer restriction would refuse.

Send the agent that builds the desktop app these values; they are build-time variables, like the
Firebase config, set in `apps/web/.env.production.local` or the environment of the build:

```
VITE_ZENITH_GITHUB_CLIENT_ID=<the GitHub OAuth app's Client ID>
VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_ID=<the Desktop app client's ID>
VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_SECRET=<the Desktop app client's secret>
VITE_ZENITH_MICROSOFT_CLIENT_ID=<the app registration's Application (client) ID>
```

The desktop build bakes them into its main process only; the page never sees the Google secret. Then,
once, sign in with each provider from an installed build, to confirm what only a real sign-in can
(above all, that Firebase takes a Microsoft ID token this way).

### 5. Deploy the rules and indexes

The rules tests must pass before any deploy (spec 13 section 12.4). They need Java 21 or newer; if
`java -version` does not print 21 or higher, install a JDK 21 first, for example Eclipse Temurin 21 from
<https://adoptium.net>.

```powershell
java -version
pnpm install
pnpm test:rules
```

`pnpm test:rules` must end with `Script exited successfully (code 0)`. Then sign the CLI in (a browser
opens) and deploy:

```powershell
pnpm --filter @horizon36596/zenith-cloud exec firebase login
pnpm --filter @horizon36596/zenith-cloud exec firebase deploy --only "firestore:rules,firestore:indexes" --project <project-id> --config ..\..\cloud\firebase.json
```

Replace `<project-id>` with the id from step 1. The CLI runs from `packages\cloud`, which is why the
config path starts with `..\..`. Afterwards the console's **Firestore Database**, **Rules** tab shows the
same text as `cloud\firestore.rules`.

Repeat only this step whenever a merged pull request changes `firestore.rules` or
`firestore.indexes.json`.

### 6. Name the Horizon admins

Horizon admins review team numbers and disputes (spec 13 section 4.4; owner ruling 2026-09-27: review by
a Horizon admin is the only verification for now). Each admin needs two-step verification on the account
they sign in to Zenith with.

The console is needed only for the very first admin. After that, any Horizon admin adds and removes
admins on the review page, **Beta access** view (owner ruling 2026-10-02).

For the first admin:

1. The admin signs in to Zenith once, so they have an account.
2. **Authentication**, **Users**: copy their **User UID**.
3. **Firestore Database**, **Data**, **Start collection** (or open `admins` if it exists): collection id
   `admins`, document id the **User UID**, one field `name` (string) with the admin's name.

For every admin after that, an admin opens `#/admin`, **Beta access**, and either pastes the person's
user code and name under **Add by user code** and chooses **Add admin**, or chooses **Make admin** on
their request or tester row. **Remove admin** takes an admin off. Both ask once more first. Nobody can
remove themselves, so no admin locks themselves out; the rules refuse it too. The last admin can
therefore only be removed from the console, by deleting their document.

Admins decide from the review page in the app, at `#/admin`: requests for verification, disputes and
appeals, each with a one-sentence reason the teams read. The same page's **Bug reports** view lists the private reports
people send from **Help**, **Report a bug**, newest first, to read and mark triaged or closed. The rules accept a change to a claim only in
the same write as the decision record that explains it, so do not edit `claims/<number>` or its
`history` by hand in the console: that bypasses the history both teams read. A deleted team's number
needs no console edit: deleting the team keeps a claim with history but detaches it (`teamId` null, a
`release` step), and another team can then claim the number afresh. If the deleted team still had a
verification request open, decline it from the review page so the number is free.

One admin is enough: nothing on the review page needs a second person (owner ruling 2026-10-01). Any
admin decides an appeal, the one who made the first decision included, and an admin who is a member
of a team, Horizon's own included, may decide about it. The decision is recorded with their name in the
claim's history both teams read and in `adminLog`, and the review page says so beside the decision. A
second admin is optional, for cover when the first is away.

Every read and decision an admin makes on the review page is recorded in `adminLog` (who, when, what
and the id it was about, never what was read), which only Horizon admins read. Read it from the
console for the security programme's reviews.

### 6a. Name the beta testers

Zenith's cloud is in a private beta: only people a Horizon admin names may create a profile, found a team,
join one by invite or send a bug report. Anyone can still create a sign-in account; the list gates the
Zenith profile and what needs it. Without the list, anyone holding the web app's Firebase config, which
is public, could make a profile, found a team or join one. The rules enforce it, so it holds whatever
app is used. A signed-in stranger can still create device records under their own account, which are
small and are deleted with the account by the daily clean-up (step 10).

The console is not needed. Horizon admins run the list on the review page, **Beta access** view (owner
rulings 2026-10-02 and 2026-10-03):

1. The tester opens Zenith and signs in once. Because they are not on the list yet, the app shows them a
   **private beta** screen with their user code, which is the **User UID**, and **Copy**. They send the
   code to a Horizon admin by any message. The app sends nothing: there is no way to ask for access, or
   for admin access, from it (issue #99).
2. An admin opens `#/admin`, **Beta access**, pastes the code under **Add by user code** with the
   person's name, and chooses **Add tester**. That adds `betaTesters/<user code>` with the name.
3. The tester chooses **Check again** and can now save a profile, found a team or redeem an invite.

Adding a document to `betaTesters` in the console, with document id the user code and one field `name`
(string), still works too.

Horizon admins (step 6) have access without being listed. The rules let only Horizon admins add and
remove testers, each with exactly a `name` of 1 to 80 characters, and nobody changes an entry. A tester
can read their own entry, and Horizon admins can read and list them all. The app writes an `adminLog`
entry in the same write as every add and remove; the rules do not enforce it.

Until 2026-10-03 the private-beta screen had **Ask for access**, which wrote `betaRequests/<user code>`.
The rules now refuse every create and change there. A request left from before stays readable and
deletable by its sender (for **Export my data** and **Delete my account**) and by Horizon admins, and
only admins list them. Adding that person by user code deletes theirs in the same write, and the daily
clean-up (step 10) deletes the rest 30 days after they were sent.

To remove a tester, choose **Remove** on their row, or delete their document. That stops them from creating a new profile, redeeming
another invite, founding a team (so claiming a team number) and sending a bug report. It does not
remove a profile they already have or a team they already joined: remove them from their teams, or
delete their account under **Security**, **Authentication**, **Users**, if that is what is wanted. They can
always delete their own account and data from the app. When an account is deleted, the daily
retention clean-up (step 10) deletes its `betaTesters` entry and any `betaRequests` entry with
everything else it left.

### Opening Zenith to everyone

When the private beta ends, open the cloud to everyone without a code change: **Databases & Storage**,
**Firestore**, **Data**, then in a collection `config` make the document `access` with one field
`betaOpen` (boolean) set to `true`. Anyone signed in can then create a profile, found a team, redeem
invites and send bug reports.
Setting it back to `false`, or deleting the document, closes the beta again; a missing document means
closed, so a new project starts closed. The rules refuse every write to `config` from the app. The
`betaTesters` list can stay; it no longer matters while the beta is open.

### 7. App Check, once the app sends tokens

App Check makes Firebase answer only the real Zenith app, which protects the free quota (spec 13
section 13). The web app uses the **reCAPTCHA Enterprise** provider: Firebase recommends it over
reCAPTCHA v3 for new apps, it gives 10,000 assessments a month at no cost, and it works on the Spark
plan, where App Check offers four of its score levels (0.1, 0.3, 0.7 and 0.9) rather than all eleven.
Those figures come from Firebase's App Check pages as search results quoted them on 2026-09-27; the
pages themselves could not be opened from here (ADR 0009 section 7), so check them on the App Check
page before relying on them. `FirebaseBackendOptions.appCheck` also takes reCAPTCHA v3, but the web
build's variable sets Enterprise only.

1. **Build**, **App Check**, **Apps**: register the web app with **reCAPTCHA Enterprise** and add
   `zenith.horizon36596.org`, `libraries.horizon36596.org` (and `localhost`, for development) as
   domains. Leave the risk threshold
   at the default unless the usage page later shows real users refused.
2. Copy the **site key**. It is not a secret. Put it in `cloud/web-config.json` as
   `appCheckSiteKey`, in a pull request: every public build then has it ("Public builds" above). It is
   optional: a release without it only warns, and App Check stays off. It is recommended once the
   console supports it (reCAPTCHA Enterprise may need a billing account on the Spark plan). Any other build reads it from `VITE_ZENITH_APPCHECK_SITE_KEY`,
   next to `VITE_ZENITH_FIREBASE_CONFIG`. In PowerShell 5.1, for a local build:

   ```powershell
   $env:VITE_ZENITH_APPCHECK_SITE_KEY = "<site-key>"
   pnpm --filter @horizon36596/zenith-web build
   ```

   With the variable unset or empty, App Check stays off and nothing else changes. The desktop build
   reads the same variable, and with it lets reCAPTCHA Enterprise and App Check through its
   Content-Security-Policy (`apps/desktop/src/main/cloud.ts` lists the hosts), but see the warning in
   step 4: that does not give the desktop app a token.
3. The privacy notice (`site/docs/privacy.md`, "Firebase App Check") already says that Google
   reCAPTCHA runs on every page that talks to the cloud, including a share opened without an account,
   and lists reCAPTCHA among the services that help run Zenith. Keep it true if this changes.
4. **Do not enforce yet.** Once a release that sends App Check tokens is live, the App Check page shows
   the share of verified requests. When it is close to all of them, **Enforce** for **Cloud Firestore**
   and **Authentication**. Enforcing earlier stops every cloud feature for every user.

   > **Warning: enforcing App Check will stop the desktop app reaching the database and signing in,
   > unless the desktop app first gets an attestation of its own.** Enforcement is per service for the
   > whole project, not per app, so there is no switch that exempts the desktop app. The built desktop
   > app's page is `zenith://app`. A reCAPTCHA Enterprise web key is for website domains ("a valid
   > domain requires a host", in the reCAPTCHA Enterprise API's `WebKeySettings`), so on that page the
   > widget is expected to fail its domain check, as it does for other Electron apps on a custom
   > scheme (electron/electron issue 17182), and the page gets no App Check token. The key setting
   > that skips the domain check, **allow all domains**, leaves checking each token's host name to the
   > site's own server, which Zenith does not have on Spark, so the key would then attest any page
   > anywhere and App Check would protect nothing. App Check's **debug provider** is not an answer
   > either: Firebase says a debug token "allows access to your backend services without a valid
   > device" and must never ship in a production build. What would work, each a decision for the
   > owner: a **custom provider** backed by an attestation Zenith runs itself (server code, so not on
   > Spark); serving the desktop page from an `https` origin inside the app (the route ADR 0011 turned
   > down for sign-in); or leaving App Check unenforced while the desktop app talks to the cloud.
   > Until one of those is chosen, keep enforcement off; tokens from the web app are still measured.

Whether App Check stays free at Zenith's scale could not be checked from here; check the App Check
page's usage before enforcing, and turn App Check off (remove the key and rebuild) rather than link a
billing account if the free assessments run out.

### 8. Accept the data-processing terms

In **Project settings**, find the **data processing** terms (the section is called something like "Data
processing and security terms") and accept them for Horizon (FTC 36596) as operator (spec 13 section
12.3). Note what was accepted and when in the security programme.

### 9. Check the quotas

**Usage and billing** (or each product's **Usage** tab) shows the daily reads, writes and sign-in
emails. Confirm that the Spark limits are what spec 13 section 7.1 says, and how many sign-in emails a day
Spark sends (spec 13 section 15, question 3). ADR 0009 section 7 lists what could not be confirmed from
here.

### 10. Turn on the daily retention clean-up

The retention policy (`site/docs/retention.md`) promises that shares and invites are deleted 30 days
after they end, with the proposals and requests for more time under those shares, that what a
deleted account leaves behind is purged within 30 days, and that a bug report is deleted 30 days
after it is closed or 90 days after it was sent, whichever is first, and with its reporter's
account. Spark has no scheduled server code, so `.github/workflows/cleanup.yml` does it once a day,
at 04:17 UTC, in the public repository `Horizon-36596/zenith`, where Actions minutes are free. The
job checks the repository's name, so it never runs anywhere else. The code is
`packages/cloud/src/cleanup/`, and ADR 0012 records every fact it relies on.

Setup, once:

1. In the Google Cloud console, the Firebase project, **IAM & Admin**, **Service accounts**, make
   `zenith-retention-cleanup` with exactly two roles: **Cloud Datastore User** and **Firebase
   Authentication Viewer**. Not the `firebase-adminsdk` account, which holds far more.
2. Make it one JSON key and store the key as the Actions secret `ZENITH_FIREBASE_SERVICE_ACCOUNT` on
   the public repository, without saving it to a file:
   `gh secret set ZENITH_FIREBASE_SERVICE_ACCOUNT --repo Horizon-36596/zenith` reads it from standard
   input. The key can read and delete everything in the database and read every sign-in account:
   treat it like the project's owner password, and never paste it into an issue, a chat, a file in a
   repository or a log. One key, in one place: delete any older key on the account's **Keys** tab.
3. To see what a run would delete, start the workflow by hand from the repository's **Actions** tab:
   a run started by hand is a dry run unless its box is unticked. To run one locally instead, put the
   key's JSON in `ZENITH_FIREBASE_SERVICE_ACCOUNT` and run `pnpm cloud:cleanup --dry-run`.

A run that fails deletes what it managed and stops, with the reason in its log; the next day's run
finds everything still due. A run also names any `admins/{uid}` document whose account no longer
exists and leaves it alone: remove those on the review page, **Beta access**, as step 6 says. It also
deletes any beta request older than 30 days. When someone asks Horizon to delete their account and an
admin deletes it under **Authentication**, **Users**, the next run removes the profile, memberships,
device records, key grants, key requests, `betaTesters` entry and beta request it left, in every team
including any it had left before, and marks each team that lost a grant "rotation pending" before it
deletes anything, so the team's next owner or admin to open it makes a new team key. The grants and
requests are found by uid with collection-group queries, which the `uid` indexes on `keyGrants` and
`keyRequests` in `firestore.indexes.json` serve. If that account owned a team, make another member an
owner first, or the team is left with no owner.

To try it against the emulators instead, with no key, start them in one PowerShell window:

```powershell
pnpm --filter @horizon36596/zenith-cloud exec firebase emulators:start --only "firestore,auth" --project demo-zenith --config ..\..\cloud\firebase.json
```

and run the clean-up in a second one, one line at a time:

```powershell
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
pnpm cloud:cleanup --dry-run --project demo-zenith
```

## Before accounts launch

These are Horizon's, not an agent's, and each must be done before the release that turns accounts on
(the launch gate is spec 13 section 12.4):

- [ ] **Create the privacy address.** `privacy@horizon36596.org` is a forwarding alias, not a new
  mailbox: in the admin console of the `horizon36596.org` domain, add it as an alias (or a forwarding
  address) that delivers to an inbox Horizon already reads. Send it a test message from an outside
  address and check it arrives. The privacy notice and the school-admin guide already publish
  it.
- [ ] **Turn on the daily retention clean-up** (step 10), with one dry run checked.

## Data model

Every document and who may use it. The TypeScript types are in `packages/cloud/src/types.ts`; the rules
in `firestore.rules` enforce every constraint in this table. "Active" means owner, admin, editor or
viewer; a **pending** member is not active and reads nothing but their own membership. A **removed**
member has no membership document at all. Times are Firestore timestamps set by the server
(`request.time`) unless noted.

Everything a team makes is end-to-end encrypted (spec 14, "As built" notes there): the server holds
titles, revisions, activity details for new autos, share projections and proposal diffs only as
**envelopes**, `{v: 1, alg: "A256GCM", kv, iv, ct}` with `iv` and `ct` as Firestore `Bytes`, sealed under
the key version `kv` names. A **wrap** is a key sealed to a P-256 public key, `{v, epk, iv, ct}`, plus
`ekv` (the team key version it was made for) on a share key's wrap. "Envelope" and "wrap" in the table
mean those shapes; the rules check their shape and sizes and the key version, never what they hold.

| path | fields | read | write |
|---|---|---|---|
| `users/{uid}` | `displayName`, `createdAt` (a profile made before the age screen was removed on 2026-10-02 may also hold `over13: true`, which nothing reads) | the user | created by the user with exactly these two fields, and only with beta access (named in `betaTesters`, a Horizon admin, or `config/access` open); the name changed and the profile deleted by the user, with or without beta access |
| `users/{uid}/devices/{deviceId}` | `v`, `encSpki` and `signSpki` (91-byte P-256 public keys, for wrapping to and for checking signatures), `fingerprint` (32 bytes, SHA-256 of both), `createdAt`; the id is the first 128 bits of the fingerprint, which every client checks | anyone signed in, by id; listed only by the user | added and deleted by the user; **never changed** (new keys make a new device) |
| `admins/{uid}` | `name` | that admin, other Horizon admins | the first from the console (step 6); after that created, with exactly `name` (1 to 80 characters), and deleted by Horizon admins, never their own; never changed; the app writes an `adminLog` entry in the same write, which the rules do not enforce |
| `betaTesters/{uid}` | `name` (the tester's name, as an admin typed it, or as a request approved before 2026-10-03 gave it) | that tester; Horizon admins, by id and listed | created, with exactly `name` (1 to 80 characters), and deleted by Horizon admins (step 6a), or from the console; the app writes an `adminLog` entry in the same write, which the rules do not enforce; never changed; deleted by the daily clean-up once the tester's account is gone |
| `betaRequests/{uid}` | requests for beta access sent before 2026-10-03: `name`, `createdAt`, optional `email` and `emailVerified` | the sender; Horizon admins, by id and listed | **never created or changed** since asking was removed on 2026-10-03 (issue #99); deleted by the sender, by Horizon admins (adding that person by user code deletes theirs), and by the daily clean-up 30 days after it was sent or once the account is gone |
| `config/access` | `betaOpen` (boolean; `true` opens the private beta to everyone, and a missing document, a missing field or any other value keeps it closed) | anyone signed in; never listed | the console only |
| `adminLog/{entryId}` | `by`, `at`, `action` (`queue.list`, `queue.open`, `shares.list`, `verification.decide`, `dispute.decide`, `appeal.decide`, `reports.list`, `report.status`, `beta.list`, `beta.approve` and `beta.decline` (no longer written since 2026-10-03), `beta.add`, `beta.remove`, `admin.add`, `admin.remove`), optional `target` (the id it was about) | Horizon admins | created by a Horizon admin as themselves at the server's time, for each read of the review page and in the same write as each decision; **never changed or deleted** |
| `bugReports/{reportId}` | `reporter` (the sender's uid), `createdAt`, `status` (`new`, `triaged`, `closed`), `whatHappened` (1 to 4,000 characters), optional `expected` (up to 2,000) and `steps` (up to 4,000), `setup` (exactly `appVersion`, `surface` (`web`, `desktop`), `hostMode`, `browser` and `os` (name and major version, up to 80 characters each), `windowWidthPx`, `windowHeightPx`, `theme` (`dark`, `light`), `cloudMode` (`off`, `fake`, `firebase`), `problems` (the open file's findings, up to 8,000 characters) and `recentActions` (action ids, up to 1,500)), optional `autoFile` (a snapshot of the open auto without `authors`, only when the reporter ticked "Include a snapshot of my auto file", up to 200,000 characters; the one exception, ruled by the owner on 2026-09-30, to Horizon admins never seeing a team's paths), and once an admin marks it `updatedBy` and `updatedAt` | Horizon admins, by id and listed; **nobody else, not even the reporter** | created by a signed-in user with a profile and beta access (step 6a), as themselves, at the server's time, with status `new`, with exactly these fields; the status changed by Horizon admins, who record who and when, with an `adminLog` entry in the same write; deleted by Horizon admins and by the daily clean-up |
| `deletedTeams/{teamId}` | `deletedBy`, `deletedAt` | the team's owner while the team stands; Horizon admins | created by the team's owner (or a Horizon admin) while the team exists, in the first write of deleting it; **never changed or deleted**, so a deleted team's id is never used again |
| `teams/{teamId}` | `number` (int or null), `name`, `status` (`unverified`, `verified`, `contested`), `createdBy`, `createdAt`, `encKey` (`v`; `spki` and `fingerprint`, the public half of the newest team key pair; `signSpki`, the public half of its signing pair; `sig`, the previous version's 64-byte signature over both, null at version 1), optional `rotationPending`, and on a team with no number that contests one, `disputeId` | any signed-in user, by id; never listed | created by a user with a profile and beta access (step 6a), together with their owner membership and the number's claim, never under an id with a tombstone in `deletedTeams`; renamed by owners and admins; `status` and a set `number` changed only by Horizon admins, a member of the team included, except that the write contesting an unverified claim also marks its holder `contested`, and a team with no number is marked `contested` by its own owners and admins only in the write that opens its review, with `disputeId` naming it (cleared by the decision); a team with no number is given one by its owners and admins together with the new claim; `encKey` set with key 1 when founded and moved up exactly one version by an owner or admin rotating the key, which clears `rotationPending`; `rotationPending: true` set by any active member; deleted by owners, only under the team's tombstone |
| `teams/{teamId}/teamKeys/{kv}` | `v`, `kv`, `prev` (team key kv-1 sealed under key kv, null for 1), `pairSpki` (the pair's public half, equal to `encKey.spki` of that version), `pairPrivate` (its private half sealed under key kv), `signSpki` and `sig` (equal to `encKey.signSpki` and `encKey.sig` of that version), `signPrivate` (the signing pair's private half sealed under key kv), `roster` (the device roster of version kv sealed under key kv, at most `MAX_ROSTER_BYTES` of ciphertext: each member's uid and role, whether members may approve each other's devices (`membersMayApprove`), each device holding key kv with its uid and two public keys, the device that made it, a fingerprint of the recovery key, the grants or recovery endorsement that give the maker its authority, and, in the roster of a version a recovery code was made with, `recoveryAnchor`, the recovery signing key's signature over that version's public keys, and from key 2 on `shares`, the team's live shares when the key was made, each with the SHA-256 digest of its manifest, at most 1,500; the plaintext is padded with spaces to 4,096, 8,192, and so on up to 524,288 bytes of ciphertext) and `rosterSig` (64 bytes, the maker's device signature over the roster and this version's public keys); nothing about who made it or when, since anyone signed in may get it | anyone signed in, by id (public keys and ciphertext, so a partner can walk the signatures from the version it pinned); listed by active members while the team exists | key 1 by the founder in the founding batch; key n+1 by an owner or admin in the batch that rotates `encKey`; **never changed**; deleted only with the team |
| `teams/{teamId}/recovery/current` | `v`, `kv` (always the newest), `spki` (the recovery public key), `privateKey` (sealed under a key derived from the printed recovery code), `teamKey` (a wrap of key kv to `spki`), `check` (SHA-256 of `spki` sealed under key kv), `signSpki` (the recovery signing public key, 91 bytes) and `signPrivate` (its private half sealed under the code's key, key version 1), `updatedBy`, `updatedAt` | active members while the team exists | written by the founder; moved to each new key by the owner or admin rotating it, keeping `spki`, `privateKey`, `signSpki` and `signPrivate`; replaced (a new code) only by an owner; deleted only with the team |
| `teams/{teamId}/keyGrants/{deviceId}` | `v`, `teamId`, `deviceId`, `uid`, `kv` (the newest), `wrap` (key kv wrapped to the device's `encSpki`), `proof` (the device's fingerprint sealed under key kv, bound to the member's uid), `approverDeviceId`, `approverUid` (what the server says; the client checks only the signature), `signature` (64 bytes, the approver device's), `createdAt`, `updatedAt`, and on a grant made by approving a request `approval` (`v`, `kv` equal to the grant's, `mac`: 32 bytes, made with the approval code the approver typed, which the new device checks; removed when a rotation moves the grant on), and on a device's grant to itself with the recovery code `recoverySig` (64 bytes, the recovery signing key's endorsement of the device; removed when a rotation moves the grant on) | its own member while active; owners and admins | the founder's own device when founding; an active member for a device of their own, from that device (after recovery) or from one of theirs that holds the newest key; an owner or admin, from a device that holds it, for any member active after the write; with `membersMayApproveDevices`, any active member holding the key for another active member; the approving device's grant must exist before the write, for the caller, at the newest version (after it only in the write that rotates the key), so grants made together never approve each other; never created at an id where a key request by another uid waits after the write, so an owner or admin may delete a request that squats a teammate's device id in the write that grants the real device; moved to the new key at each rotation; while `rotationPending` is set, no device grants itself unless the same write rotates the key; the recipient's device record must exist; deleted by its member, owners and admins, or with the team |
| `teams/{teamId}/keyRequests/{deviceId}` | `uid`, `deviceId`, `createdAt` | its member; owners and admins; active members when `membersMayApproveDevices` is on | a member, pending or active, for a device of their own whose record exists; deleted by its member, owners and admins, the active member whose grant to that device, for the request's own uid, is made in the same write, or with the team |
| `teams/{teamId}/members/{uid}` | `uid`, `teamId`, `role` (`owner`, `admin`, `editor`, `viewer`, `pending`), `displayName`, `joinedAt`, and for invited members `invite` and `requestedRole` | active members while the team exists; the member themselves; a user's own memberships by collection-group query; Horizon admins while the team has a tombstone | created by the founding owner, or by redeeming an invite of a team that exists and has no tombstone, which needs beta access; role changed by owners (any role) and admins (not an owner's, never to owner); nobody changes their own role; removed by owners, and by admins except owners; a member may leave unless they are an owner; every member removed by a Horizon admin deleting the team under its tombstone, before the team document, since a share made to the team is read by membership alone |
| `teams/{teamId}/settings/sharing` | `editorsMayProposeShare`, `editorsMayLinkShare`, `publishOnSave`, `membersMayApproveDevices` (all false when missing) | active members while the team exists | owners and admins |
| `teams/{teamId}/autos/{autoId}` | `title` (an envelope under the team's newest key), `titleGen` (1 when made, one more at each rename, and sealed into the title), `createdBy`, `createdAt`, `updatedAt` | active members while the team exists | created and renamed by editors and up; deleted only by the owner deleting the team |
| `teams/{teamId}/autos/{autoId}/revisions/{revisionId}` | `n`, `baseRevision` (a revision id or null), `author`, `createdAt`, `content` (the canonical auto JSON, compressed and sealed: an envelope under the team's newest key), optional `gitSha` (the commit id, sealed, because it can be looked up in a public repository), `robot`, `field`, `waypoints` (envelopes under the same key version as `content`), `diverged` | active members while the team exists | created by editors and up, with `n` one more than the base's; **never updated**, and deleted only by the owner deleting the team |
| `teams/{teamId}/inbox/{shareId}` | `shareId`, `ownerTeamId`, `createdBy`, `createdAt` | active members of the receiving team | created with a share to this team by the sharing team, and rewritten with the same checks when a team taken off the share is put back; deleted by the receiving team's owners and admins |
| `teams/{teamId}/activity/{entryId}` | `at`, `by`, `kind`, optional `target`, `detail` (text, or on `auto.create` always an envelope holding the auto's title, under the team's newest key) | owners and admins while the team exists | appended by active members as themselves, `target` at most 128 and `detail` at most 600 characters; a member who is not active writes only their own `member.join` in the write that adds them and their own `member.leave` in the write that removes them; never changed; deleted only by the owner deleting the team |
| `invites/{code}` | `teamId`, `role` (`admin`, `editor`, `viewer`), `expiresAt`, `maxUses`, `uses`, `autoApprove`, `createdBy`, `createdAt`, `revoked` | anyone signed in, by the code; **never listed** | made by owners and admins, and never `autoApprove` for the `admin` role; extended, changed or revoked by them until revoked, which is final; `uses` goes up by exactly one only in the same write as a new membership, and only while unrevoked, unexpired and `uses < maxUses`; deleted only by the owner deleting the team |
| `shares/{shareId}` | `ownerTeamId`, `autoId`, `audience` (`teams`, `link`), `teamIds` (1 to 8, or none for a link), `level` (`view`, `propose`), `mode` (`pinned`, `follow`), `revision`, `expiresAt`, `revokedAt`, `createdBy`, `createdAt`, `updatedAt`, `projection` (an envelope under the share key, at most 1,000,000 bytes of ciphertext); `manifest` on every share (`{ v: 5, body, sig, dsig, dkeys, tsig, tkeys }`: a body of at most 2,560 bytes naming the share, the owner team, the auto and the revision it shows, the audience, mode and level, whether it is revoked, when it ends, a sequence number one up at every change, the share key's version, the owner team key version the key or link secret is sealed under and the one that signs, the device that signed, a count of the signatures of the share's terms and the one to eight devices that signed its terms at that key version, a digest of `ownerChoice`, each team with the key version its wrap is to and a digest of that key (none for a link), and a commitment to the share key or to the key the link gives; the 64-byte ECDSA signature over it by the owner team's signing key; the 64-byte signature over it by that device's signing key; that device's two public keys, 182 bytes, from which its id comes; and the 64-byte signature of the last of the terms signers over a statement of the terms, with that device's two public keys, 182 bytes, both carried unchanged by a manifest that changes no term), optional `ownerChoice` (the sharer's choices for the projection, sealed under the owner team's key, at most 1,024 bytes of ciphertext); a share to teams also `keyWraps` (the share key wrapped to each named team's `encKey`, exactly one per team), `ownerWrap` (the share key sealed under the owner team's key) and optional `prevKeys` (each replaced share key sealed under its successor); a link share `linkWrap` (the link secret sealed under the owner team's key), and its id is derived from that secret | a link share: **anyone, even signed out, by id, while live and its team exists, never listed**; a share to teams: active members of those teams while live and its team exists; the sharing team always, and it may list its own; Horizon admins always, and they may list every share | editors share with teams at view level; propose level and link shares need an owner or admin unless the team settings allow editors; a link share is view only; changed by owners and admins, or by the editor who made it; on a following share any editor may move `revision` and `projection`, under the same key or, changing only `keyWraps`, `ownerWrap` and `prevKeys` besides, under a new key one version up for the same teams; an update changes only `teamIds`, `level`, `mode`, `revision`, `expiresAt`, `revokedAt`, `projection`, the key fields, `manifest` and `updatedAt`, and the rules check only the fields it changes; every update writes a new `manifest` in the same write, on a link share too, since the manifest names the revision and the end as well as the teams, level, mode, revocation and keys; `ownerChoice` is written only when the share is made, under the owner team's newest key, and never changes; the share key's version never goes down, and taking a team off a share needs a new key one version up with the old one added to `prevKeys`; `linkWrap` never changes; revoking is final; never deleted |
| `shares/{shareId}/timeRequests/{teamId}` | `shareId`, `teamId` (the asking team, also the id), `ownerTeamId`, `requestedBy`, `requestedAt`, `status` (`open`, `granted`, `declined`), `reason` (optional: `next-event`, `still-testing`, `still-planning`), `wantedUntil` (optional), `decidedBy`, `decidedAt`, `grantedUntil` | active members of the asking team and of the sharing team, each listing through the `timeRequests` collection group by `teamId` or `ownerTeamId` | asked by any active member of a team the share names, before or after it ends but not once revoked, one open request per team; decided by the sharing team's owners and admins or the editor who made the share; granting extends the share in the same write; never deleted |
| `proposals/{proposalId}` | `shareId`, `ownerTeamId`, `autoId`, `fromTeamId`, `baseRevision`, `diff` (an envelope under the proposal's own random key, key version 1, at most 1,000,000 bytes of ciphertext; never under the share key, which every team on the share holds), `ownerWrap` (that key wrapped to the owner team's `encKey`, `{ v, epk, iv, ct, ekv }` with 48 bytes of ciphertext, at the `encKey.v` the owner team shows), `fromWrap` (that key sealed under the proposing team's key, an envelope of 48 bytes of ciphertext, so it still reads what it sent), `sig` (64 bytes: the proposing team's signature over the proposal with its team signing key of version `fromWrap.kv`, which the owner team checks before it lists the proposal), `status` (`open`, `accepted`, `rejected`, `withdrawn`), `createdBy`, `createdAt`, `decidedBy`, `decidedAt` | active members of either team | sent, with a 128-bit random id, by editors of a team a live propose-level share names, while the sharing team exists, against the revision a pinned share shows or any revision of the auto for a following share; accepted or rejected by the owning team's editors; withdrawn by its author; never deleted |
| `claims/{teamNumber}` | `teamId` (null once the team that held it was deleted), `status` (`unverified`, `verified`, `contested`), `claimedAt`, `historyCount` (how many steps the history has), `disputeId` and `requestId` (the open dispute and request, or null) | anyone signed in, by number: which team holds it and its status, nothing else | created with its team, or when a team with no number claims a free one, together with history step 0; every change adds exactly the step numbered `historyCount` in the same write: the holder's owners and admins add a `request` with a verification request; another team's owners and admins add a `contest` with a dispute, which makes an unverified claim `contested` (and both teams) and leaves a verified one verified while it is reviewed; the losing team adds its `appeal`; Horizon admins change the holder or status only with a `verify`, `decline`, `decision` or `appeal-decision` step tied to the decision record written in the same batch; deleted by its team's owner only while the claim is its one step, together with that step; otherwise, when its team is deleted, the owner detaches it (`teamId` null, `unverified` unless a review is open) with a `release` step, and another team claims it afresh, `unverified`, with a `claim` step once no review or request is open |
| `claims/{teamNumber}/history/{index}` | `kind`, `teamId` (the team the step is about), `otherTeamId` (the second team it involves, or null), `by`, `at`, and as the step needs `disputeId`, `requestId`, `note` (a reviewer's reason or an appeal's) | active members of `teamId` and of `otherTeamId`; Horizon admins; nobody else. Lists filter on `teamId` or `otherTeamId` | added with the claim's change, as the caller, at the server's time; never changed; step 0 deleted only with its claim |
| `verifications/{requestId}` | `teamNumber`, `teamId`, `requestedBy`, `createdAt`, `status` (`open`, `decided`), `evidence` (1 to 6 entries: `kind` `photo`, `event` or `statement`, `summary`, `url` (https, required for a photo or event), `by`, `at`), `decision` (`verdict` `verified` or `declined`, `reason`, `by`, `at`) | active members of the team; Horizon admins | made by the holder's owners and admins while the claim is unverified with no other request open; decided once by a Horizon admin, a member of the team included, with a one-sentence reason; never deleted |
| `disputes/{disputeId}` | `teamNumber`, `holderTeamId`, `challengerTeamId`, `openedBy`, `createdAt`, `status` (`open`, `decided`, `appealed`, `final`), `evidence` (entries as above plus `team`, at most 20), `decision`, `appeal`, `appealDecision` (`winner`, `reason`, `by`, `at`) | active members of both teams; Horizon admins; nobody else | opened by the owners and admins of a team with no number, one open dispute per claim; evidence appended by either team's owners and admins until decided (and again while appealed); decided by a Horizon admin, a member of either team included, with a one-sentence reason; one appeal, by the team that lost, within 14 days of the decision; the appeal decided finally by a Horizon admin, the one who made the first decision included; never deleted |

Evidence photos are not uploaded: Cloud Storage is not among the Spark facts ADR 0009 verified as free,
so a team hosts its photo wherever it likes and pastes the https address with a summary.

Ids made by the client (teams, invite codes, shares, proposals, disputes, verification requests, admin log entries, bug reports) carry 128 random bits as 22 base64url
characters, and the rules refuse shorter ones. A revision id is `n` zero-padded to six digits, a hyphen
and 64 random bits (`000004-q8Yx3kd0aZ_`), so two members who publish revision 4 offline make two
documents and nothing is overwritten (spec 13 section 5.3).

## Keys and encryption: what the rules hold to

Spec 14 is the design; this is what `firestore.rules` checks, and what it leaves to the client
because a rule cannot open ciphertext or do elliptic-curve arithmetic.

- **Shapes and sizes.** Every envelope has `v == 1`, `alg == "A256GCM"`, a 12-byte `iv` and a `ct` of at
  least the 16-byte tag and at most its field's cap (`MAX_*` in `packages/cloud/src/types.ts`, the same
  numbers in the rules). Public keys are 91-byte SPKIs, fingerprints 32 bytes, signatures 64.
- **Newest key only.** A new title, revision, grant, share owner wrap or link wrap, and the recovery
  record, name the team's `encKey.v` as it is after the write, so a key the team rotated away from is
  not used again, not even in the write that rotates it.
  So is an `auto.create` activity detail, which is always sealed. A revision's `gitSha` names the
  same version as its `content`, and an auto's `titleGen` goes up by exactly one at each rename.
  Old revisions stay under the key they were made with; the newest key opens every older one through
  `teamKeys/{n}.prev`.
- **Founding and rotation are one write each.** A team is created with `encKey` version 1,
  `teamKeys/1`, `recovery/current` and the founder's own grant in the founding batch. Rotation (an
  owner or admin, when a member is removed, a device revoked, a pending mark completed, someone made
  or unmade an owner or admin, or `membersMayApproveDevices` changed) writes
  `encKey` n+1, `teamKeys/{n+1}` (whose public keys and signature must equal `encKey`'s), the
  recovery record moved to n+1 and every kept grant in one batch, removing each grant's `approval`,
  and deletes the grants of whoever is leaving. The rules check the roster's shape and size and
  that it names the record's version; which grants a rotation keeps is the client's decision, from
  the roster of the key it is leaving (spec 14 section 4.5). The grant rules read only documents every grant in the
  batch shares, so a batch stays within the 20 documents one write may read (ADR 0013): a 49-grant
  rotation passed on the emulator.
- **Who may grant.** See the `keyGrants` row. A grant must name the caller as approver, a device of
  the caller's that holds the newest key (or the device itself, for the founder and after recovery),
  and a recipient whose device record exists and who is active after the write. A device granting
  itself while a rotation is pending is refused unless the write rotates the key, because the device
  taken off may still hold the key it had. The approving device's grant is read before the write
  (`get`), except in the write that rotates the key (`getAfter`). The rules check the shape of
  `approval` and that its `kv` is the grant's.
- **Removed members get nothing.** Membership rules decide every read, so a removed member reads no
  grant, key record or recovery record; rotation makes sure nothing new is sealed under a key they held.
  A revoked device of a member who stays cannot be told apart by the rules until the rotation drops
  its grant.
- **Shares.** A share to teams has exactly one wrap per named team, an owner wrap and a manifest, which
  the rules check the shape of and which a write that changes the wraps or `prevKeys` replaces; taking a team off
  re-keys it one version up and keeps the old key in `prevKeys`, so the teams left read older
  proposals and the team taken off reads nothing new. A link share's id and key both come from its
  secret; `linkWrap` lets the owner team show the link again, and never changes.
- **Share writes fit the engine's limit.** Firestore evaluates at most 1,000 expressions for one
  document and refuses a write that needs more, whatever the rules would say. A new share is checked
  whole, but an update checks only the fields it changes, and the shape checks a re-key repeats for
  each team are written to cost as little as the engine allows, so every update the app makes fits for
  a share to 8 teams, the most one names (ADR 0013 section 5 has the measured costs). A change to the
  share rules is measured again on the emulator before it is merged.
- **Reviewers.** One Horizon admin may do everything alone (owner ruling 2026-10-01): decide a team's
  verification request, a dispute or appeal that involves it, an appeal of their own first decision,
  and set its `status`, a team they are a member of included. Nothing is refused for that; every
  decision records `by`, which both teams read in the claim's history, with an `adminLog` entry.
- **Left to the client**, because the rules cannot check them: that a device id is the start of its
  fingerprint, that a fingerprint is the SHA-256 of its keys (the rules check this for `encKey` only),
  a grant's signature and proof, a first grant's approval MAC against the code the device showed,
  each team key version's signature by the one below, each roster's signature and that its maker had the authority to rotate, which grants a rotation keeps, a recipient wrap against its team's `encKey`,
  that a team key is the one this device pinned before, that a partner's newer key is signed from
  the one pinned (otherwise the safety code is compared), that a share's manifest is signed by the
  owner team's key it names, reached from this device's pin, and by the device it names, says what
  the share's plain fields say, and commits to the share key it opens, that the owner team's newest
  roster holds the device that signed a share it lists (the rotation lists no other),
  and that a share key or a title is not older than one the device has read. The client refuses what fails any of these with a `tampered`,
  `no-key` or `key-changed` error. What the client cannot catch is listed in spec 14 section 4.11.

## Working on the rules

- `pnpm test` runs the permission and flow suites against `MemoryBackend`, which applies the TypeScript
  copy of the rules in `packages/cloud/src/memory/rules.ts`. The emulator files are skipped, with a
  message saying so.
- `pnpm test:rules` starts the Firestore and Auth emulators and runs the same suites against
  `firestore.rules` itself. A change to the rules and to `rules.ts` goes in one pull request, and both
  runs must be green.
- The emulator starts empty, which is a closed private beta (no `config/access`). The shared suites
  therefore write `config/access` with `betaOpen: true` in every reset, except the cases about the
  beta itself, which reset without it. The in-memory database seeds the same document when it is
  made, so the web app's fake cloud is open; `new MemoryDatabase({ betaGate: "closed" })` makes one
  that starts closed.
- A bug report (`bugReports/{reportId}`, from the app's Report a bug dialog) is private: the rules
  let only Horizon admins read, list, mark and delete one, and the reporter cannot read theirs back.
  The rules check every field's type and size (`MAX_BUG_*` in `packages/cloud/src/types.ts`) and
  that nothing else is in it, so the app cannot send a name, an email address or a key by mistake.
  The daily clean-up reads each report's `reporter`, `status`, `createdAt` and `updatedAt` only,
  never its text.
- `pnpm test:rules` also runs the retention clean-up against both emulators
  (`packages/cloud/test/emulator.cleanup.test.ts`): a real run over seeded data must delete exactly
  what is due and nothing else. A change to the data model that adds a collection says, in its pull
  request, whether the retention policy keeps it or the clean-up must delete it.
