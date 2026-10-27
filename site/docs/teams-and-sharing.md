# Teams and sharing

!!! note "Accounts are new"
    Accounts, teams, the team library and sharing are in the published web app and the desktop app.
    Anyone can sign in and make or join a team, with no request and no approval from Horizon.
    Horizon can close new sign-ups for a while if abuse threatens the free plan's limits. [The alliance view, envelopes and proposals](alliance-partners.md) as files
    work with no account.

Zenith works fully without an account, and always will. An account adds two things: a **team
library** in the cloud that your whole team can open, and **sharing** with other teams. What Zenith
keeps, and why, is in the [privacy notice](privacy.md).

## Accounts are optional

- Planning, checking, timing and saving autos work with **no account and no network**, in the editor,
  the desktop app, the command line and the MCP server, and so does deploying to the robot. GitHub
  mode needs no Zenith account, but it needs a network to reach GitHub.
- The app never asks you to sign in at start-up. A **Sign in** button sits in the toolbar.
- You need an account only to use a team library, share outside your team, or open a share made to
  your team. An **anyone with the link** share opens with no account.

### Signing in

Sign in with **GitHub**, **Microsoft** or **Google**. Zenith has no passwords, and the published app
offers no sign-in by email link.

To have an account you must be 13 or older, or sign in with a school account your school approved
for Zenith. Zenith does not ask your age. Everything that needs no account works for anyone.

**School Google accounts often do not work for students.** Many schools block apps they have not
approved for students under 18. Use GitHub or Microsoft instead, or give your school's
admin the [school admin guide](school-admin-guide.md).

**In the desktop app**, an anyone-with-the-link share opens just as it does in the browser, and
signing in happens in your own web browser. **Google** and **Microsoft** open their sign-in page there;
when it says "You can close this tab and go back to Zenith", do that, and Zenith is signed in.
**GitHub** shows a short code in Zenith and opens GitHub's device page, where you type it. Cancel stops
waiting at any time. A provider the desktop app was built without is not offered there, with a line
saying why; sign in with another one, or use the web app. Everything that needs no account works in the desktop app as before, with or
without a network.

## Working offline

FTC events often have bad Wi-Fi, so the cloud features are built to work offline.

- **Signed in and offline**, the team library and any share you have opened before still open, play
  and run in the alliance view.
- **Keep for offline** on your library, or on a share in the Partners panel,
  downloads it ahead of an event. A share link you opened is listed under **Links opened here** in
  the Partners panel, even signed out, so you can open it again; tick **Keep for offline** on it too.
  This computer remembers only which shares you kept and who they are from; the share itself stays
  in the browser's offline copy.
- **The outbox.** Publishing, sharing, extending, revoking and proposing all work offline. They wait
  in the outbox and are sent in order when you are back online. A share still in the outbox is not
  visible to the other team yet, and the share dialog says so, with an **Open the Outbox** button. So
  does a request for more time, or an answer to one, made offline.
- **Signing out** clears the offline copy from that browser, and the list of kept shares with it,
  unless the browser refuses (below), when Zenith says so.
  Changes still waiting in the outbox live in that copy, so signing out drops them and they may never
  reach the server. When any are waiting, Settings asks first: **Stay signed in** until the outbox has
  sent them, or **Sign out anyway**. The Outbox lists dropped changes as **Dropped**. Your saved auto files are not affected: Publish only ever sends a saved file, so what a sign-out drops is the upload, and you can publish again after signing back in. If
  another Zenith tab or window still has the offline copy open, the browser may refuse to clear it:
  you are signed out anyway, Zenith says the copy stayed, and the waiting changes stay in the Outbox.
  That tab stops using the copy, so someone else signing in there cannot read it, and keeps no
  offline copy until it is reloaded. The copy stays on this computer until Zenith is closed in every
  tab and window; then open Zenith, sign in and sign out again to clear it.
- **On a shared computer**, choose **This is a shared computer** on the sign-in screen, where it asks
  whose device this is. Zenith then keeps no offline copy of your team's autos or of shares there, so
  the next person cannot find them, and the library needs a connection while you use it. The team key
  is kept only until you close the app, so the computer needs approval again each time (see
  [Keys and your team](#keys-and-your-team)). **Closing the app does not sign you out**: the next
  person to open Zenith there could still act as you, for example on your team's settings, so sign out
  when you finish. See [Using a shared computer](privacy.md#using-a-shared-computer).

## Teams

Any signed-in user with a profile can make a team, with a name and, if it has one, its FTC team
number. The number is
optional. A number two teams claim is marked contested until a Horizon admin decides who holds it (see
[Verifying team numbers](#verifying-team-numbers)).
You can be in more than one team. A student can make and own a team; no adult is needed, though we
suggest a coach or mentor holds the admin role.

### Roles

| role | can |
|---|---|
| **Owner** | everything an admin can, plus delete the team and make other owners. Every team keeps at least one owner. |
| **Admin** | invite and remove members, approve new members, change roles (not an owner's), change the team's sharing settings, make and revoke any share, read the activity log. |
| **Editor** | publish autos to the team library, share with specific teams at view level, use the alliance view, send proposals, and accept or reject proposals made to the team. |
| **Viewer** | open the team library and shares made to the team, and use the alliance view. Cannot publish or share. |

Nobody can change their own role. Making someone an owner or admin, or taking that role away,
also changes the team key when the device making the change can make one (see
[Keys and your team](#keys-and-your-team)), so the new role counts for who may approve devices from
then on. Two team settings, both off by default, let editors also share at
the **propose** level, and make **anyone with the link** shares. The database's rules enforce who may
read and write what in this table, not only the app's buttons. Who your devices trust to approve a
new device follows the team's signed list of devices instead, which changes only when the key does;
a role change made from a device that cannot make the new key counts for the database at once, and
for approvals once an owner or admin makes the new key.

### Invites

An owner or admin invites people with an invite link.

- An invite gives one role: admin, editor or viewer.
- It **expires at a calendar time**: 1 day, 7 days (the default), 30 days, or a date and time you pick.
  You can extend it before it ends.
- It is **single-use** by default. You can allow more uses.
- A new member **waits for approval** by default. While waiting they can see nothing. You can choose
  to let everyone who uses the invite join straight away; their device still needs the team key, which
  an owner or admin gives by typing the 18-character approval code it shows (see
  [Keys and your team](#keys-and-your-team)). An **admin** invite always waits for approval, so a
  leaked admin link alone never lets anyone in.
- You can **Withdraw** an invite at any time. That is final.
- Every join goes in the team's **activity log**, which owners and admins can read.

## The team library

The library holds your team's autos as a series of **versions**. A version is never changed or
overwritten. Each one records who published it, when, the version it was built on and, in a git
project, the commit it came from. Your team's `robot.json`, field and waypoints can be kept with it,
so a teammate without GitHub can open any auto. Only your team's members can read any of it.

- **Publish** a saved auto to add a new version, with one button, or on every save if your team turns
  that setting on.
- **Open in project** brings a version back into your local folder, where you save and commit it as
  usual.
- **Download project** gets the whole project, for a team that keeps everything in the library.
- Each version in the list says which version it was built **from**, and each auto shows how it is
  shared, with the same chip as the toolbar: **Team only**, **Shared with 2 teams** or **Anyone with
  the link**. Hover it to see who and until when; click it to open the Sharing page on that auto's
  shares, where **Show all** lists the rest.
- If two teammates publish from the same version, both versions are kept, and the second is marked
  **diverged**. **Review** (or **Compare** on the diverged version) opens both in the review view: one
  drawn over the other, which is ghosted, with the steps that differ and what each change does to the
  time. Then choose. **Keep mine** or **Keep theirs** publishes that one as the next version, built on
  the other, so the team has one newest version again. **Open in project** brings either one into your
  folder. Nothing is overwritten or deleted, and nothing changes until you choose. Tick any two
  versions to compare them the same way.

Your robot repository stays the source of truth for the robot. `zenith deploy` never reads from the
library; what goes on the robot is always a file on disk.

## Keys and your team

Your team library, your autos' names, your shares and your proposals are **encrypted on your
devices** before they reach the cloud. Your library and names are readable on devices that hold
your **team key**, or by whoever uses your recovery code. A share is also readable by the teams it
names, or by anyone who has its link, and a proposal by the team it is sent to. Horizon holds no team
key, and neither does anyone with access to the database. The exception is a first share
or proposal between two teams that have not compared their **safety code** (below): until they do,
someone who controls the database could show a key of its own. The
[privacy notice](privacy.md#end-to-end-encryption) says what the cloud still sees, and the limits.

- **A device gets the key from a person.** A new member's device, or a member's new laptop,
  shows **Waiting for a teammate to unlock the team library on this device** and its **approval
  code**: 18 letters and numbers in three groups of six, such as `7K2QXD-M9A1RT-4ZC8PW`. Read the
  code out, in person or on a call. The person approving types all 18 characters on their own
  device; capitals, spaces and dashes do not matter. Zenith gives the key only when the typed code is
  that device's, so nobody in between can swap in a device or a key of their own. That is the
  usual way in; the others are the device that founded the team, which gives itself the first key, a
  member's own device that already has the key, which can give it to another of their devices, and
  the recovery code (below). A typing mistake
  anywhere in the code is refused when the approver presses **Approve**, so check it and type it
  again. If the new device says its request is no longer waiting (it was declined, or the team key
  changed before the device took it), choose **Ask again** there and read the code out once more.
  If it says **This browser can't save keys; approval will be needed each time**, the browser's
  storage is full or turned off: the code lasts until the page closes. Meanwhile you can still plan
  and save autos on that computer and open links other teams share.
- **Who approves.** An owner or admin approves a new member, with **Approve** next to their name.
  A member's new device is approved by one of their own devices that already has the key, or by an
  owner or admin, under **Devices waiting for the key** on the team page. The team setting **Any
  member may approve a teammate's new device**, off by default, lets any member do it.
- **Your own device, or a shared one.** At sign-in, Zenith asks whose device this is. On your own
  device the key stays, so it needs approval only once. On a shared computer the key is kept only
  until you close the app, so it needs approval each time.
- **The recovery code.** When you make a team, Zenith shows its **recovery code** once, as
  `ZNTH-` followed by five groups of letters and numbers, and waits until you print it or tick that
  you saved it. The printed page has only your team, the code, the date and one line of
  instructions. Keep it in the team binder or with your coach. If every device on the team is lost,
  for example after a new season wipes the school laptops, **Use recovery code** on a waiting device
  unlocks the library. A device let in with the code keeps the key only until the key next changes:
  after that, it needs a teammate's approval, or the code again. The exception is an owner's or
  admin's device, which makes a new key itself when it uses the code. **Without the code, and with no device left that has the key, the team
  library cannot be opened again**, by you or by Horizon; there is no reset. Keep a copy of what
  matters in your robot repository, or with **Download project**.
- **A new recovery code.** An owner can make one under **Recovery code** on the team page, at the
  start of each season and when someone who held the old one leaves. After an owner removes a
  member, Zenith suggests it, with a button: with the old code, a device that has never opened the
  team could be shown the team as it was when that code was made, with a key the removed member
  still has. The old code stops working at once, so print the new one straight away. If a code may
  have leaked, also check the devices on the team page and revoke any you do not know.
- **Removing someone changes the key.** When you remove a member, or **Revoke** a device that is lost
  or no longer used, Zenith asks first and says that the team key will change. An owner or admin then
  sees **Make a new key**, and the devices still on the team get the new key. Once it is made, the
  person removed cannot open anything published after that; until then, what the team publishes is
  still under the old key, so make it straight away. Versions they could already open stay as they
  were.
- **Who keeps the key when it changes.** Each time the key changes, Zenith writes a signed list of
  the team's devices that hold it. The next change gives the new key to the devices on that list,
  and to devices approved since by someone allowed to: the member themselves, an owner or admin, or
  any member while **Any member may approve a teammate's new device** is on. That setting covers
  devices of teammates who are not owners or admins; an owner's or admin's new device is approved by
  another of their devices, or by another owner or admin. A device approved by
  someone who has since been removed is left out, and needs approval again. So a device that someone
  slipped in under a teammate's name does not keep the key once the key next changes.
- **A device that cannot make the new key.** Only a device an owner or admin had on the last list,
  or one such a device approved, can make a new key. On any other device, **Make a new key** says so
  and changes nothing; make it from another owner's or admin's device, or use the recovery code on
  this one. Such a device also cannot remove an owner or admin, give one a lower role, revoke an
  owner's or admin's device, or turn off **Any member may approve a teammate's new device**: each of
  those changes the key in the same step. An owner or admin cannot revoke the device they are on,
  since no device can make a key that leaves itself out; revoke it from another device.
- **The team safety code.** The team page shows your team's **safety code**, 20 digits in five
  groups of four. Before you share an auto that matters with another team, compare safety codes with
  them, in person or on a call. It changes when your team makes a new key.
- **The first time you share with a team.** The share dialog shows that team's safety code before
  anything is sent. Compare it with that team, by phone or in person, before you share anything that
  matters, then choose **Share**. Zenith remembers the team, and asks again only if its key changes,
  or if its number now leads to a different team, when it shows both teams' codes.
- **When a partner's key changed.** Zenith remembers each partner team's key the first time you share
  with them. If it is different the next time, and is not a new key their own team's devices signed,
  the share dialog stops and shows **their key changed**, with their safety code. Ask them to read
  theirs out. Choose **Continue** only if the codes match; **Don't send** sends nothing. A new key
  their team signed is taken as an ordinary change, so after a partner makes a new key, compare codes
  again before a share that matters.
- **Plain messages.** If this device does not have the key yet, if what the cloud sent did not pass
  its check, or if a partner's key changed, Zenith says so in a sentence, sends nothing new for that
  step, and tells you what to do next.

## Sharing outside the team

Every auto starts as **team only**. There are three ways to share, all in one share dialog:

| sharing | who can open it | what they can do | ends |
|---|---|---|---|
| **Team only** | your team's members | everything their role allows | never |
| **Specific teams** (up to 8) | signed-in members of each team you pick | **view** (the default) or **propose** changes | 7 days by default |
| **Anyone with the link** | anyone who has the link, no sign-in needed | view only | 7 days by default |

Every share ends at a calendar time: 1 day, 7 days, 30 days, or a date and time you pick. You can
extend it, by 1, 7 or 30 more days or to a later date and time, and you can revoke it at any time.
Revoking is final.

### What the other team gets

Sharing outside your team **never sends your auto file**. The other team gets a summary made on your
own computer:

- **At view level:** your start pose, the robot's outer box, where the robot is over time, time
  windows labelled drive, score, collect, wait, park or other, the field elements it takes or scores,
  any envelopes, the total time, and the auto's title if you keep it.
- **At propose level:** all of that, plus the shape of the auto (its steps, paths, headings, speeds,
  waits and markers) with every command replaced by a blank label such as `cmd3`.
- **Never:** Java, `robot.json`, your robot's measured constants, condition names, notes, authors,
  file paths or your repository's name. Command names are never sent either, unless you choose to
  include them (below).

### Include command names

If your team does not mind a partner knowing what your commands are called, tick **Include command
names** in the share dialog. It is **off by default**. With it on, the summary also carries each
command's name and the settings the auto gives it, such as `score (count 4)`, at either level. Your
partner sees them in the preview, in the read-only view and on your robot's lane in their alliance
view, where they would otherwise see a stand-in such as `cmd3`. They still never see your code, your
`robot.json`, what your conditions are called, or your notes.

The one-sentence summary says so ("They will see command names and their settings, but not your
code, notes or any robot settings."), and the Sharing page marks the share **Commands included**.
Changing the share's level, a new version reaching a share that follows the latest, and **Update
share** all keep the choice you made.

### Include the auto's name

Your partner normally sees your auto under your team's name, such as "Team 36596". Tick **Include the
auto's name**, under Command names in the share dialog, to let them see what you call it instead. It
is **off by default**. The summary sentence says "They will see this auto's name", the preview shows
the name, and the Sharing page marks the share **Name included**. The choice is kept the same way as
the command names; when a newer version has a different title, the share shows the new one.

The summary still shows how fast your robot drives and in what order it scores. That is what a partner
needs, and what anyone watching a match can see. A **coarsen** option rounds it more.

The Horizon admins who run Zenith can see a list of every share's settings, link shares included, to
keep the service safe and to answer reports: which team made it, which teams it involves, its level,
version, end time and status. Zenith's review page never shows them what a share shows, its summary,
command names or auto's name, and has no way to change a share. The people who run the Firebase
project can edit the database's records directly, but what a share shows stays encrypted there. What a share shows is encrypted, and Horizon holds no key to it or to your team
library; compare safety codes before a first share that matters (see
[Keys and your team](#keys-and-your-team)).

### The one-sentence summary, and See it as they will

The share dialog starts with one sentence that says exactly who can see what, until when. It changes
as you change the settings. For example:

> Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives
> and when. They will not see command names, notes or any robot settings. They cannot propose changes.

**See it as they will** shows the summary exactly as the other team will get it, before you send
anything.

Every auto shows a **sharing chip**, such as `Team only`, `Shared with 2 teams` or `Anyone with the
link`, or `Not in the team library` for an auto nobody else has yet; hover over it to see who and
until when. The **Sharing page** lists every share and invite your
team has made, with the time left, and **Extend**, **Change level**, **Follow latest** and **Revoke** on
each one. It marks any that end within two days, and any that include command names or the auto's
name. Owners and admins can change any share; an editor can change the shares they made, within what
the team's settings let editors share. A button you cannot use stays visible and its tooltip says why.

**Expiry warnings.** When you open Zenith signed in, or switch to your team, a notice at the bottom
right lists your team's shares and invites that end within 48 hours, with **Extend**, which opens the
Sharing page. Dismiss a line to hide it on this computer; if the share is extended and later nears its
new end, it is listed again. A share your team received that ends within two days says so in the
Partners panel. Zenith sends no email, so the warning is only in the app.

### Request more time

A team you shared with can ask you for more time, before the share ends or after. In their Partners
panel, **Request more time** sits on each share made to their team, and on each one listed under
**Ended shares**. They pick how much more time (1, 7 or 30 more days, a date and time, or leave it to
you) and, if they like, a reason from a short list, such as "We need it through our next event." There
is no message box: Zenith has no private messages between users, as FIRST's Youth Protection Program
asks.

The request shows under the share on your Sharing page, with **Grant** and **Decline**. Grant offers
the end they asked for, 1, 7 or 30 more days, or a date and time, and extends the share at once.
Decline keeps the end as it is. Your team's owners and admins, and whoever made the share, can answer.
The other team sees your answer in their Partners panel, and may ask again. A share that was revoked
cannot be given more time, and an anyone-with-the-link share has no team to ask.

### Pinned, or following the latest version

- A share is **pinned** by default: the other team sees the exact version you shared, as the preview
  showed it. When you publish a newer version, the Sharing page says "A newer version is not shared"
  on that share, and **Update share** sends the newest version with the same level, rounding and
  command-name choice.
- Turn on **Follow the latest version** to keep a partner in sync for longer. Each time you publish that
  auto, the share moves to the new version. The other team can see which mode a share is in and when it
  last changed.

### Anyone with the link

- The link is an address, not the data, for example `zenith.horizon36596.org/#/s/k3f9x2`. The real link is long
  and random, so nobody can guess one. It also carries the key that opens the share, after the `#`,
  which the browser never sends to a server; Zenith takes it out of the address bar as soon as the
  link opens. **Anyone who has the link can open the share**, so treat it like the share itself.
- There is **no gallery and no search**. No visitor can list these links; a link is found only by being
  given it. The Horizon admins' list of share settings includes link shares, but never their links. Post it where you choose: a regional Discord, a scouting sheet, your team's website.
- Before you make one, Zenith asks you to confirm: "Anyone who gets this link will be able to see it,
  without signing in", and shows the preview again.
- Opening a link needs no account, and Zenith makes no account or profile for the person opening it.
  Their browser still reaches Firebase and the web host, which keep routine request logs, and App
  Check's reCAPTCHA runs on the page (see the [privacy notice](privacy.md#who-helps-us-run-zenith)).
- **Revoking works at once** for anyone who has not already opened it. Someone who opened it earlier
  keeps their offline copy until their app next syncs.
- By default, only owners and admins can make one.

## The alliance view

The alliance view works today, with no account: load a partner's file in the **Partners** panel.
[Alliance partners](alliance-partners.md#the-alliance-view) describes it. Signed in, a share made to
your team loads there too.

## Envelopes

Envelopes are part of the auto file and work today; see
[Alliance partners](alliance-partners.md#envelopes). A share carries them the way a share file does.

## Proposals

Proposals work as files with no account; see [Alliance partners](alliance-partners.md#proposals).
Signed in, a proposal can also travel through a propose-level share, as below.

### Proposing through the cloud

When you are signed in and a team has shared an auto with your team at the propose level:

1. In the **Partners** panel, find it under **Shared with your team** and press **Load**. The partner
   shows when the share last changed ("updated 3 hours ago"). If the other team publishes a newer
   version of a share that follows their latest version, the partner says so, and **Reload** loads it
   in place, keeping its start offset.
2. Press **Suggest changes…** under the partner, and make your changes. Your own auto is not touched.
3. Press **Send to the share**. The proposal goes to the team that shared the auto, against the
   version you loaded. If your computer is offline, it waits in the **Outbox** and is sent when the
   connection comes back.
4. Under the partner, each proposal you sent shows its status: **Open**, **Accepted**, **Rejected** or
   **Withdrawn**. While one is open, **Withdraw** takes it back after you confirm, and the team that
   shared the auto then sees it as withdrawn and can no longer accept it. Only the member who sent a
   proposal can withdraw it. Offline, the withdrawal waits in the **Outbox** like any other change.

**Suggest changes** does not appear for a view-only share. You need to be an editor of your team to
send a proposal.

The team that shared the auto:

1. Opens the auto that was shared, then the **Sharing** page. Under each share that allows proposals,
   it lists the proposals received for it: status, which team sent it, when, and the version it was
   made against.
2. Presses **Review**. The proposal opens in the review view against that version, fetched from the
   team library, so each change reads in your own step and command names.
3. Accepts the changes it wants and presses **Apply**. They go into the open auto as one edit, which
   Undo takes out, and the proposal is marked **Accepted** for the team that sent it. **Reject
   proposal** marks it **Rejected** instead, and changes nothing. Save the auto as usual afterwards.

A partner loaded from a file has no share to send to. Use **Save proposal…** instead and send the file;
the other team opens it with **Open proposal…**.

## Verifying team numbers

A new team's number is marked **unverified** until a Horizon admin checks it. Unverified teams can use
every feature. Wherever sharing names a team, the status follows the name: "Team 12345 (unverified)",
"(verified)" or "(number contested)", on received shares, the Sharing page, partners in the alliance
view and proposals. If two teams claim the same unverified number, both are marked **contested** while a
Horizon admin reviews the claims. The [terms of use](terms.md#team-numbers) explain the review, the
decision and the one appeal.

An owner or admin asks for verification in the app: **Request verification**, on the team's page
under **Teams** in your account, with a photo or an event result as evidence. The request goes to the
Horizon admins' review queue.

## Leaving, deleting and your data

- Any member except an owner can leave a team at any time.
- An owner can delete the team. Deleting a team deletes its members, invites, settings, activity and
  library. Its shares are revoked, so no other team can open them afterwards, and kept as records. A
  claim on its team number that has review history is kept, no longer tied to the deleted team. A
  deleted team's id is never reused. See the
  [retention policy](retention.md#when-you-delete-a-team).
- **Export my data** in **Settings**, under **Privacy and data**, downloads your data, and **Delete my account** deletes
  your account. If you own a team, make
  another member an owner, or delete the team, first.
