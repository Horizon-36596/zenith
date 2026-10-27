# Privacy notice

**Effective: 25 October 2026**, from the first public release with accounts, teams and sharing.
Anyone can sign in with GitHub, Microsoft or Google and make or join a team, with no request and no
approval from Horizon. Horizon can close new sign-ups for a while if abuse threatens the free plan's limits.

This notice is for students, parents, coaches and mentors. It says what Zenith keeps about you, why,
who helps us run it, how long we keep it, and what you can ask us to do. We have tried to write it in
plain words. If anything here is unclear, ask us (see [Contact us](#contact-us)).

Zenith is run by **Horizon (FTC 36596)**, a nonprofit FTC robotics team, fiscally sponsored by The
Hack Foundation, a 501(c)(3) nonprofit.
In this notice, "we" and
"Horizon" mean the Horizon team, and "Zenith" means the Zenith app, desktop app and website.

## The short version

- **You do not need an account.** The editor, the desktop app, the command line and links other teams
  share all work with no account. Without an account, Zenith makes no account or profile for you.
  The web host and Firebase keep the routine request logs any website has, and on pages that talk to
  the cloud reCAPTCHA checks the request (see [Who helps us run Zenith](#who-helps-us-run-zenith)).
- **An account is only for your team's library and for sharing.** It holds a display name, how you
  signed in, your email address and which teams you are in.
- **Your team's autos are encrypted on your devices.** Your team library, your autos' names, your
  shares and your proposals reach the cloud already encrypted, and Horizon holds no key to them. The
  one exception is a first share between two teams that never compared their safety code; see
  [End-to-end encryption](#end-to-end-encryption).
- **No ads, no tracking, no analytics in the app, no selling.** We never sell or rent your data, never
  use it for advertising and never build a profile of you.
  This documentation site counts page views
  without cookies; see [This documentation site](#this-documentation-site).
- **An account is for people 13 or older**, or for a school account your school approved for Zenith.
  Anyone can use all of Zenith without one.
- **You can download your data and delete your account** from the app's settings.

## What we collect, and why

We collect only what an account needs to work, and a bug report only when you choose to send one.

| what | where it comes from | why we need it | who can see it |
|---|---|---|---|
| **Display name** | you type it | so teammates know who published an auto or joined the team | the members of teams you join |
| **Sign-in provider and account id** (GitHub, Microsoft or Google) | the sign-in service | so you can sign in | only you, and the few Horizon people who run Zenith's Firebase project |
| **Email address** | the sign-in service | so you can sign in, and so we can reach you about your account | only you, and the few Horizon people who run Zenith's Firebase project; **never shown to other teams** |
| **Team memberships and roles** (owner, admin, editor, viewer, or waiting for approval) | you join or make a team | so the right people can open your team's autos | your team's members |
| **Your team's autos**, their names, their versions, and the team's robot, field and waypoint files if you publish them | you publish them | this is the team library, the reason the account exists | your team's members, on devices that hold the team key; the database holds them only encrypted, and **Horizon holds no key to them** (see [End-to-end encryption](#end-to-end-encryption)) |
| **Shares, invites and proposals** your team makes or receives | your team makes them | to share an auto with other teams, invite teammates and suggest changes | your team; for a share, the teams it names or anyone with its link; what a share shows and what a proposal suggests are encrypted, and the Horizon admins see only a share's settings (see below). A share also names the devices that signed it and their public keys, which everyone who can open the share can read |
| **Device keys and approvals**: the public half of each of your devices' keys, the public record of each team key version, which devices hold the team key, and who approved each one | your devices make them, and a teammate approves them | so a teammate can give a new device the team key, and nobody else can | a device's public keys and a team key's public record: **anyone signed in** who knows their id, since other teams need them to check a share; which devices hold the team key and who approved them: your team's owners and admins, and each member for their own devices |
| **Team activity log** (who did what, and when) | the app writes it as you work | so team owners and admins can see who joined, shared or changed something | your team's owners and admins |
| **Team-number claims and disputes** | a team claims its number | so one team holds each FTC team number (see [Terms of use](terms.md#team-numbers)) | any signed-in user can see which team holds a number and whether it is verified; the claim's history, the reviewers' reasons, appeals and disputes are seen only by the teams involved and the Horizon admins |
| **Request for beta access**, only if you sent one before 3 October 2026: your account id, the name you typed and your sign-in email, if your account has one | you chose **Ask for access** on the private-beta screen, which no longer has it | so a Horizon admin could add you to the beta tester list | only you, and the Horizon admins |
| **Beta tester list**, during the private beta only: your account id and a name, typed by a Horizon admin or from a request sent before 3 October 2026 | a Horizon admin adds you by the user code you send them | so only testers can make a profile and found or join teams before Zenith opens to everyone | only you, and the Horizon admins |
| **Bug reports you send**: what you typed, the app's setup (see below) and, only if you tick it, a snapshot of your open auto file | you send one from **Help**, **Report a bug** | so we can find and fix the bug | only the Horizon admins; not other teams, not your team, and not you once it is sent |

Zenith does **not** ask your age or your birth date.

**What a bug report holds.** The Report a bug dialog shows everything a report holds before you
send it. Besides what you type, that is: the Zenith version, whether it is the web or desktop app
and whether another app opened it, your browser and system by name and main version number (such as
"Chrome 131" and "Windows 10 or 11"), the window size and theme, whether accounts are on, the
problems the app found in the open auto, and the names of the last actions you ran (such as
"run.validate"). A snapshot of your open auto file goes only if you tick **Include a snapshot of my
auto file**, and then without its list of authors. **If you tick it, the Horizon admins will see
that file's paths**, where your robot drives and when. That is an exception to the end-to-end
encryption: it applies only to a file you chose to attach to a bug report, and the report is
deleted on the schedule below. Zenith never adds your display name, email address, team, device keys
or the full description your browser gives of itself to a report, and it replaces the paths on your
computer that it recognises with `[path]`. What you type, and an auto file you attach, go as they are,
so do not put personal information in them. A report carries your account id, so
it can be deleted with your account. Nobody can reply to a report through Zenith; it is not a
message. Without an account, or while accounts are off, the dialog only copies the report for you
to send yourself, and nothing reaches us.

Some records other teams can read (a share, a proposal, a dispute) carry an account id. It is a random
string, not your name or email address.

**Horizon admins can see every share's settings, never what it shows.** The few Horizon people listed
as Zenith admins can see a list of every share any team has made, live, ended or revoked: which team
made it, which teams it names or that it is open to anyone with its link, whether it is view only or
lets them propose changes, which version it follows, when it was made and when it ends. They look at
this list to keep the service safe and to answer reports, for example when someone tells us a share
should not exist. The admin page never shows them what a share shows the other team: not where the
robot drives or when, not your auto's name and not your command names. They cannot change or revoke
a share.

**Horizon holds no key to your team library.** It is encrypted on your devices before it is sent, and
Horizon holds no key to it. [End-to-end encryption](#end-to-end-encryption) says what the database
still holds in the clear.

**What the sign-in service keeps.** When you sign in with GitHub, Microsoft or Google, the sign-in
service (Firebase Authentication, below) also stores what that provider sends it. That can include the
name and profile picture on that account, and when you first and last signed in. Zenith does not show
these to anyone.

**GitHub mode.** GitHub mode works without a Zenith account. When you use **Sign in with GitHub**
there, the web app gets GitHub's token through the same sign-in service (Firebase Authentication),
because a web page cannot finish a GitHub sign-in on its own. If you have no Zenith account, the
service makes a sign-in record for your GitHub account, and Zenith deletes it again straight away.
The token itself is never written to Zenith's database. It stays in your browser, or in the desktop
app, where you chose to keep it, and it is sent only to GitHub's API, to read and write the
repository you open. Signing out of GitHub mode deletes it from Zenith. To take back Zenith's access
on GitHub as well, revoke it under **Settings -> Applications** on GitHub.

**On your own computer.** When you are signed in, the app keeps a copy of your team's library and
received shares on your device, so it works offline, unless you told Zenith it is a shared computer.
It also keeps this device's own key there, which never leaves it. Signing out clears the copy of the
library; if the browser will not let it (another Zenith tab still has it open), Zenith says the copy
stayed and how to clear it. The browser deletes the copy but does not securely wipe it. A share link you open keeps the key that opens it (the part after the `#`) only for that
browser tab, unless you are signed in on your own device, when it is kept with the list of links you
opened. On a shared computer, read [Using a shared computer](#using-a-shared-computer).

## End-to-end encryption

Your team library, the names of your autos, the shares your team makes and the proposals sent through
them are **encrypted on your devices**. Your library and your autos' names use a team key that your
team's devices hold, and your printed recovery code opens. A share uses a key of its own, given to the
teams it names or carried in its link, and a proposal one the team it is sent to can open. The
database, and anyone who can look inside it, including Horizon, sees those parts only encrypted. Horizon holds
no copy of any team key and no key that opens them all, so it cannot hand one over, and it cannot get
your team back in if every device is lost: that is what your team's printed recovery code is for (see
[Keys and your team](teams-and-sharing.md#keys-and-your-team)). A new device gets the team key only
when a teammate approves it by typing the **approval code** the new device shows on its screen, with
three other ways in: the team's printed recovery code; the device that founded the team, which gives
itself the first key; and your own device that already holds the key, which can give it to another of
your devices. Part of the approval code is made on the new device and never sent anywhere, so nobody
who controls the database can approve a device of their own, or hand your device a team key that is
not your team's. An anyone-with-the-link share carries its key in the link, after the `#`, which the
browser never sends to a server.

**What the encryption cannot promise.** When your team first receives a share from another team, or
first sends that team a proposal, your device trusts the key the database shows it for that team. An
operator who changed what the database serves could show a key of its own there and read that share or
proposal. Comparing the **safety code** with the other team (in person, or on a call you trust) closes
that gap: once both teams have compared it, a swapped key shows. Until you compare it, treat a first
share as something Horizon could in principle read. A device that opens a team with only the recovery
code can also be shown an older, real state of the team, back to when the code was made.

What the database still holds in the clear is what it needs to keep each team's walls: team numbers,
names and number status; claims, disputes and verification evidence; members' account ids, display
names and roles; invites and the role each gives; each device's public keys and each team key
version's public record; which devices hold the team key and who approved them, and whether the team
key is due to be replaced; when each version was published and by whom, its number, the version it was
based on and whether it diverged; a share's audience, the teams it names, its level, version and end
time, and its signed manifest, which names the auto and version it shares, the devices that signed it
and a fingerprint of its key; a proposal's status; each activity-log entry's kind and some of its
details, such as a team's new name, the team's sharing settings, an invite's role and the teams a share
names; and the size of each encrypted item. None of that is a path.

**The app you run.** Zenith's web app loads its code from Horizon each time it opens, so a future
version could, in principle, be changed to send keys away. The source is public, so such a change
would have to be in its history. Releases are built from that source on a Horizon computer and
published by a person; nothing lets you check that the files served are exactly that source built.
The desktop app changes only when you install an update, so it is the strongest choice for a team
that wants to be most careful. The other limits are above: a first share before the safety code is
compared, and a device that opens a team with only the recovery code.

## What we never collect

- Your birth date, address, phone number, school or photo: Zenith never asks for them. Anything you
  type yourself, such as a team name, a bug report or verification evidence, is kept as you wrote it.
- Your location.
- Analytics, advertising identifiers or tracking cookies. The app uses no analytics, and the fonts
  are served from our own site, not from a font service. The documentation site counts page views
  without cookies; see the next section.
- An account or profile for you when you open a share link or use Zenith without an account. (The
  routine request logs and reCAPTCHA above still apply.)
- Passwords. Zenith has no passwords. You sign in through GitHub, Microsoft or Google. The published
  app offers no sign-in by email link.
- Private messages. Zenith has none. Everything that passes between teams is attached to a share or a
  team-number claim, and all the members of both teams can see it.

## This documentation site

The [Zenith documentation site](https://libraries.horizon36596.org/zenith/) counts page views with
[GoatCounter](https://www.goatcounter.com), so we can see which pages teams read.

- It sets no cookies and stores nothing in your browser.
- For each page view it records the page and its title, the site that linked you here, your
  browser, operating system and screen size, and your country.
- GoatCounter uses your IP address and browser to work out your country and to count a reload only
  once. It keeps them in memory for at most 8 hours and never stores them.
- No outside script runs on these pages. Our own page sends one request to GoatCounter; no
  GoatCounter code is loaded.
- It cannot tell who you are or follow you to other sites.
- The Zenith app, the desktop app and the command line send none of this.

## Who helps us run Zenith

We do not run our own servers. These companies process data for us:

| company | what it does | what it sees |
|---|---|---|
| **Google, through Firebase** (Firebase Authentication and Cloud Firestore) | signs you in, stores accounts, teams and autos | everything in the table above, with autos, their names, shares and proposals only in encrypted form |
| **GitHub, through GitHub Pages** | hosts the web app and this website | the routine request logs any website has, such as your IP address |
| **GitHub, through its API** | answers the desktop app's one check per launch for a newer version; in GitHub mode, reads and writes the repository you open | the routine request details, such as your IP address; the update check has no token and nothing about you or your autos. In GitHub mode, your GitHub token and the files Zenith reads and commits |
| **Google, through reCAPTCHA Enterprise** (Firebase App Check) | checks that requests to the cloud come from the real Zenith app | signals from your browser and device on pages that talk to the cloud (see below); nothing from your autos |
| **GoatCounter** | counts page views on the documentation site | the page and its title, the referring site, browser, operating system, screen size and country; your IP address in memory for at most 8 hours; no cookies |

When you choose to sign in with **GitHub**, **Microsoft** or **Google**, that company learns that you
signed in to Zenith. Their own privacy policies cover that.

**Firebase App Check.** The published web app uses Firebase App Check, with Google reCAPTCHA
Enterprise, to check that requests come from the real Zenith app, which makes it harder for automated
requests to use up our free allowance. Requests that fail the check still reach the cloud until
Horizon turns enforcement on in the Firebase console. reCAPTCHA, a Google service, runs on every page of the app that talks to Zenith's cloud,
including a share link opened without an account, and looks at signals from your browser and device
(such as how the page is used and details of the browser) to tell the real app from automated
requests. Google's own privacy policy and terms cover what Google does with those signals. The desktop
app lets the same service through but, as its page is not a website, gets no App Check answer from it.

We do not use Cloudflare or any other service for accounts today.

## Children under 13

Zenith does not ask your age. Our [terms](terms.md#who-can-have-an-account) say that to have an
account you must be 13 or older, or sign in with a school account your school approved for Zenith. The
sign-in services have their own age rules: a GitHub account is for people 13 or older, and a Google or
Microsoft account for a child under 13 is set up and controlled by a parent, or by the school for a
school account.

Anyone, of any age, can use every part of Zenith that needs no account, and open links other teams
share. Without an account, Zenith makes no account or profile for you. Your team's older members can share
autos with the team.

We do not knowingly keep an account for anyone under 13 who did not sign in with a school account
their school approved. If you think such a child has an account,
tell us (see [Contact us](#contact-us)) and we will delete it.

## Care for young people's data

Most people who use Zenith are students, many under 18. So Zenith is private by default:

- A new auto is seen by **your team only**.
- A share is **view only** and **ends after 7 days** unless you change it.
- There are **no public profiles**, no search for people, and no public gallery of autos.
- The app never nudges you to share more.
- Other teams never see your email address or your name. They see your team's number and name.

## How long we keep it

Our [retention policy](retention.md) has the details. In short:

- Your account, until you delete it. We remove what is left of a deleted account within 30 days.
- A team, until an owner deletes it. Deleting a team deletes its members, invites, settings, activity
  and library. Its shares are revoked and kept as records, and a claim on its number that has review
  history is kept, no longer tied to the team.
- Shares that have ended or been revoked: 30 days, then deleted.
- Closed team-number disputes: one FTC season.
- Request logs: as long as Google and GitHub keep them by default.
- Our admin access log: 1 year.
- Bug reports: 30 days after we close them, and never more than 90 days, and deleted with your
  account.
- A request for beta access sent before 3 October 2026: deleted when a Horizon admin adds you, 30
  days after you sent it, or with your account, whichever comes first.
- The beta tester list, during the private beta: your entry is deleted with your account.

An automatic clean-up runs every day, as a scheduled GitHub Action in Zenith's public repository, and deletes ended shares and invites, old bug reports, and what
deleted accounts leave behind, including their entry on the beta tester list, and requests for beta
access older than 30 days, once they are due. A few deletions are still done by hand by a Horizon admin; the
retention policy says which.

## Your choices and rights

- **Download your data.** In the app's **Settings**, under **Privacy and data**, **Export my data** downloads a file with your profile
  and team memberships, and what you wrote in the teams you are in: the revisions you published (with
  the autos themselves), the shares and proposals you made, the requests for verification, evidence and
  appeals you sent, the steps of team-number histories you took, and, in teams where you are an owner or
  admin, your entries in the team's activity log. The file lists anything it could not include: an
  editor or viewer cannot read a team's activity log, and what you wrote in a team you have left
  belongs to that team, so for those, ask us (see [Contact us](#contact-us)). Any member can download
  the team's autos with **Download project**. Your own app decrypts what it exports; an export we make
  for you from the database holds your team's autos only in encrypted form, because we hold no key to
  them.
- **Change your display name** at any time in the app's settings.
- **Delete your account.** Deleting your account in the app's settings removes your profile, your team
  memberships and your sign-in account straight away. You sign in once more first, with the same
  account, so we know it is you; if you do not finish that, nothing is deleted. If you own a team, first make another member an
  owner or delete the team. Autos you published stay in your team's library, because they belong to the
  team; they carry an account id that no longer leads to your name.
- **Leave a team** at any time, unless you are its owner.
- **Ask us** anything else, such as to see or correct what we hold, or to delete something. See
  [Contact us](#contact-us).

## Europe and the UK

If you live in the European Union or the United Kingdom, the GDPR (or the UK GDPR) gives you rights
over your data, and we follow it.

- **Why we may use your data (our lawful basis).** We use your account data because we need it to give
  you the service you asked for: your team library and sharing (GDPR Article 6(1)(b)). We do **not**
  rely on your consent, and there is nothing optional to consent to. The routine request logs are kept
  so that we can run the service and keep it safe, which is our legitimate interest (Article 6(1)(f)).
- **Your rights.** You can ask to see your data, correct it, delete it, get a copy to take elsewhere,
  limit how we use it, or object to how we use it. Most of these you can do yourself in the app; for the
  rest, contact us. You can also complain to your data protection authority (in the UK, the Information
  Commissioner's Office).
- **Children's data.** We follow the UK's Age Appropriate Design Code: high privacy by default, no
  profiling, no location, no nudges to share more, and a notice written for young people. See
  [Care for young people's data](#care-for-young-peoples-data).
- **Transfers.** Google and GitHub may process data outside your country, including in the United
  States. Google processes Zenith's data under the data-processing terms that are part of the
  Firebase and Google Cloud terms of service, which include the standard safeguards for transfers
  out of the EU and UK.

## Using a shared computer

On a shared computer, such as a school or event laptop, choose **This is a shared computer** when the
sign-in screen asks whose device this is. **Closing the app does not sign you out**: until you sign
out, the next person to open Zenith in that browser is still signed in as you and can do what your
role allows, even without the team key. Zenith then keeps no offline copy of your team's autos or of
shares on that computer, so the next person to use it cannot find them, and it forgets the list of
shares kept for offline there. This device's key and the team key are kept only until you close the
app, so a teammate approves the computer again each time you use it, and the key that opens a share
link is kept only for that browser tab. Your team library needs a connection while you use it.

Either way, sign out when you finish. Signing out removes the copy of your team's library from that
browser, or says so if the browser would not let it. The browser does not securely wipe it, so on a computer many people share, also use a browser
profile of your own or a private window.

## Security

No other team can read your team's library. The database itself enforces this, not only the app.

Horizon, as the operator of the database, holds no key to any team's library or to what any share
shows, because they are encrypted on your devices. The limit is a first share between two teams that
have not compared their safety code (see [End-to-end encryption](#end-to-end-encryption)). The
few Horizon people named as Zenith admins, each with two-step sign-in, see only what the database
holds in the clear, and use it only to review team numbers, to keep sharing safe and answer reports,
and to help when a team or a user asks. When an admin decides something or changes a team's data from
Zenith's review page, the app writes it in our admin access log: who, when, what and why. The database
cannot make a read write a log entry, so looking at the list of shares, or reading the database from
the Firebase console, is not logged. The app checks the signed parts of
what the cloud sends for a team before it opens it, and refuses them if they were changed. Some
settings are not signed, and an older state that was correctly signed can still be shown within the
limits above. To report a security problem, see
[our security policy](https://github.com/Horizon-36596/zenith/security/policy).

## Contact us

To ask a question, make a request about your data, or report a child under 13 with an account:

- **Privacy contact:** [privacy@horizon36596.org](mailto:privacy@horizon36596.org). It reaches the
  Horizon people who run Zenith.
- **On GitHub:** message a maintainer of the
  [Horizon-36596](https://github.com/Horizon-36596) organization. Please do not put personal
  information in a public issue.
- **Security problems:** report them privately through the repository's
  [Security tab](https://github.com/Horizon-36596/zenith/security).

## Changes to this notice

If we change this notice, we will post the new version on this page with a new effective date. If a
change affects what we collect or who sees it, we will say so in the app and in the
[changelog](changelog.md) before it takes effect.
