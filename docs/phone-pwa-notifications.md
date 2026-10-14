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

Enroll once, on one verified Wolfpack origin per device/browser profile. That host sends quiet alerts for its own agents and for agents on online, ready trusted Tailnet machines. Keep that enrollment host online: it is the notification relay for this device.

1. Open Wolfpack from the verified origin (on iPhone/iPad, launch its Home Screen app).
2. Tap **Enable notifications** on the sessions view, or enable **Settings → Notifications**.
3. When the browser or OS asks, allow notifications for that exact verified Wolfpack origin.
4. In Settings, tap **Send test notification** to check delivery to this device only. A sent status means the push service accepted it; the OS may still delay or suppress display.
5. Leave the toggle enabled. Clicking an agent notification opens this home origin and routes to the session on its verified machine.

An ordinary iOS Safari tab shows an **Add to Home Screen** hint instead of an enable button. Install and launch the app first. If permission was denied, on iOS open **Settings app → Notifications → Wolfpack**; in Chromium open **site settings for this origin** and allow notifications. Reopen Wolfpack and enable the toggle again. Do not broadly enable notifications for unrelated sites.

## alert kinds

An agent's alert fires once per activity episode, after its screen stays quiet for the configured interval.

- **Quiet**: the screen went quiet.
- **Needs input**: the screen went quiet while the agent's own program status (OSC 7501) said it waits on you, for example `Needs input (permission)`. This alert is never withheld.
- **Waiting on a child**: a due quiet alert is withheld while any live descendant session (linked by `parentSession`, up to 8 generations) still works: its status is working, running, or printing, or its screen changed within the quiet interval. The episode stays open and alerts once the whole tree is quiet. `GET /api/sessions` reports the withheld state as `quietSuppressedBy: { reason: "waiting-on-child", sessionId, session }` on the parent; it never sends a notification. Only descendants on the same machine count.

Agents with no children and no program status keep the plain quiet behavior. There is no setting for these rules.

## one enrollment covers online machines

The browser subscription still belongs to one origin (scheme, hostname, port). The enrolled server reads trusted peers' session lists and relays only quiet-alert facts those peers report: each peer keeps its own quiet-alert policy. Older peers also work when their session lists expose these facts; peers that do not expose quiet-alert facts cannot supply automatic alerts. An enrolled server older than the needs-input kind drops a newer peer's needs-input alerts instead of relaying them; update the enrollment host to receive them. Unreachable or incompatible peers are skipped without blocking local alerts.

If you enrolled on several machine origins before, **turn notifications off on the other machines you enrolled before**. There is no cross-origin deduplication: leaving multiple enrollments on can produce duplicate alerts on this device.

An existing subscription does not migrate when a hostname, port, scheme, browser profile, or Wolfpack origin changes. Re-enroll once from the new verified origin and remove stale permissions for an origin you no longer use.

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

Confirm all three sources of truth: the browser or OS allows Notifications for the exact origin, **Settings → Notifications** is enabled on that origin, and the phone can currently reach the Wolfpack host over the Tailnet. Use **Send test notification** in Settings. For remote agents, also confirm their machines are online and their own quiet-alert policies are enabled. Re-enroll after any origin change. If delivery still fails, use [troubleshooting](./troubleshooting.md) without opening the service to a broader network.
