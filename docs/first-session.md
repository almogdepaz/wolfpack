# your first Wolfpack session

This walkthrough gets you from a completed setup to a session you can leave and reopen. It takes about five minutes. If Wolfpack is not running yet, start it with the command shown by setup, then use the printed local URL.

## 1. open Wolfpack

Open the printed local URL in a browser on the Wolfpack host. Use the verified Tailnet URL only from a trusted Tailnet device.

## 2. start a new session

Select **New session**. In the expanded Sessions view, the same action is the machine's `+` button.

## 3. choose a project

Choose one of the listed projects, or select **Open a folder** to use an existing folder on the Wolfpack machine. Select **Create a project** when you want Wolfpack to create a new project folder.

![Wolfpack desktop Sessions view showing projects and persistent terminal sessions](assets/wolfpack-desktop-dashboard.png)

*Desktop checkpoint: the Sessions view groups work by machine and lets you reopen an existing terminal.*

## 4. choose a session name and agent

Retain or edit the proposed session name. Then choose an enabled installed agent. If no coding-agent CLI is available, choose **Shell**; setup enables it as the fallback.

## 5. run a harmless command or task

For **Shell**, run:

```sh
pwd
```

For an agent, ask it to report the current project directory without changing files. Wait for the terminal to show the result.

## 6. reopen the same session

Return to **Sessions**, find the session name you chose, and reopen the same session. The terminal is a broker-owned PTY, so it remains available across browser navigation, browser reconnection, and Wolfpack server upgrades and restarts while that PTY is still running.

This persistence is bounded: the session does not survive when you explicitly stop or kill it. Do not assume it survives a host reboot or another unsupported host lifecycle event.

## 7. optional: reopen from your phone

If setup verified remote access, open the verified Tailnet URL or scan setup's verified QR code on a trusted phone. Select the same session name to reopen its terminal.

![Wolfpack phone Sessions view showing persistent sessions available to reopen](assets/wolfpack-mobile-sessions.png)

*Phone checkpoint: the mobile Sessions view shows the same broker-owned sessions from the verified Tailnet route.*

To install Wolfpack on that phone or enable notifications, continue with the [phone, PWA, and notifications guide](./phone-pwa-notifications.md).

Wolfpack access is shell-equivalent. Before sharing access or changing the network boundary, read [security and trust](installation.md#security-and-trust). If a checkpoint fails, use [troubleshooting](troubleshooting.md).
