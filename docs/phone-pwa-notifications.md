# phone, PWA, and notifications

Use this guide after [setup](./installation.md) has printed and verified a Tailnet HTTPS route. Wolfpack access is shell-equivalent access to the host. Continue only from a trusted Tailnet device, and review [security and trust](./installation.md#security-and-trust) before changing who can reach the route.

## open the verified phone route

On the Wolfpack host, run setup again if you no longer have its current output:

```sh
wolfpack setup
```

On the trusted phone, open the verified Tailnet URL or scan setup's verified QR code. Do not substitute an unverified hostname, an old bookmark, or a route copied from another machine. Reopen the same broker-owned session you used on the host to confirm that the phone reached the intended Wolfpack host.

## install on iPhone and iPad

Browser terminal use does not require installation; Wolfpack remains usable in an ordinary Safari tab. iOS and iPadOS Web Push enrollment requires Add to Home Screen and launching the installed web app. An ordinary Safari tab cannot enroll for Web Push.

1. Open the verified Tailnet URL in Safari.
2. Open Safari's **Share** menu.
3. Choose **Add to Home Screen**, then confirm **Add**. Apple may vary the menu wording by OS release.
4. Launch Wolfpack from the new Home Screen icon and confirm the expected host and sessions appear.

## install on Android

1. Open the verified Tailnet URL in Chrome or another Chromium browser that supports PWA installation.
2. Open the browser menu and choose **Install app**. Some versions instead show **Add to Home screen**.
3. Confirm **Install** or **Add**.
4. Launch Wolfpack from the new Home Screen icon and confirm the expected host and sessions appear.

If the install action is absent, keep using Wolfpack in the browser and consult [troubleshooting](./troubleshooting.md). Installation is optional; do not weaken browser or Tailnet security settings to make the prompt appear.

## enable notifications

Notification permission and enrollment belong to the exact browser origin currently open.

1. Open Wolfpack from the verified origin.
2. Open **Settings → Notifications** and enable the toggle.
3. When the browser or OS asks, allow notifications for that exact verified Wolfpack origin.
4. Leave the toggle enabled and keep the installed app or browser origin available to the OS.

If permission was denied, use the browser or OS settings to find the exact verified Wolfpack origin, change its Notifications permission to **Allow**, reopen Wolfpack from that origin, and enable **Settings → Notifications** again. Do not broadly enable notifications for unrelated sites.

## enroll every origin separately

A notification subscription is per origin: its scheme, hostname, and port identify one enrollment. Each distinct verified Wolfpack machine origin needs a separate subscription on each phone/browser profile. Open each origin and repeat the notification steps.

An existing subscription does not migrate when a hostname, port, scheme, browser profile, or Wolfpack origin changes. Re-enroll from the new verified origin and remove stale permissions for an origin you no longer use.

## what this setup does not promise

- PWA installation does not grant Tailnet access to a device.
- It does not make Wolfpack public or bypass Tailnet policy.
- It does not make Wolfpack offline-capable or make an offline host reachable.
- It does not reduce Wolfpack's shell-equivalent access to the host.
- It does not guarantee background notification delivery; the browser and OS can delay or suppress delivery.
- It does not preserve a notification subscription when the origin changes.
- Cached shell UI or output is not live authority for host reachability or session state.

## recover safely

### stale route or Home Screen entry

Rerun `wolfpack setup` on the intended host and use only its current verified Tailnet URL or verified QR code. If an installed entry still opens a stale origin, remove that entry, open the current verified origin in the browser, and install it again. Follow [troubleshooting](./troubleshooting.md) if setup cannot verify the route.

### offline or reconnecting app

Bring the app to the foreground and reload it. Confirm that the phone is connected to the intended Tailnet and that the Wolfpack host is online, then verify the route with `wolfpack setup`. A cached screen or terminal output is not proof that the host is currently reachable.

### notification delivery fails

Confirm all three sources of truth: the browser or OS allows Notifications for the exact origin, **Settings → Notifications** is enabled on that origin, and the phone can currently reach the Wolfpack host over the Tailnet. Re-enroll after any origin change. If delivery still fails, use [troubleshooting](./troubleshooting.md) without opening the service to a broader network.
