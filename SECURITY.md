# Security policy

## Supported versions

Zenith is in beta. Only the latest 0.1.x release gets security fixes.

| version | supported |
|---|---|
| 0.1.x | yes |
| earlier | no |

## Reporting a vulnerability

Report it privately through GitHub Security Advisories. Do not open a public issue.

1. Open the repository on GitHub: <https://github.com/Horizon-36596/zenith>.
2. Go to the **Security** tab.
3. Choose **Report a vulnerability**.
4. Describe the problem, how to reproduce it, and what it affects.

We will reply on the advisory, work on a fix there, and publish the advisory with the fixed
release. Please give us a reasonable chance to fix it before you disclose it anywhere else.

## How Zenith handles your GitHub token

GitHub mode uses a personal access token (PAT) that you paste into the app.

- It is kept in memory. If you choose to remember it for the tab, it is also mirrored to
  `sessionStorage`, which ends with the browser session.
- It is never written to `localStorage`, a URL or a log.
- It is only ever sent to `api.github.com`.

The app never writes to your base branch, never force-pushes, and writes only under the directories
your `zenith.json` declares. A token that is sent anywhere else, stored anywhere else, or used to write
outside those rules is a vulnerability; please report it.

Use a fine-grained token limited to the robot repository, with only the Contents and Pull requests
permissions.
