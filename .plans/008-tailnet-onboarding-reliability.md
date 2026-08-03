# tailnet onboarding reliability

## goal

Make existing Tailscale onboarding truthful and recoverable: Wolfpack should clearly present Tailnet phone access as its primary workflow, keep the user in one setup run while they sign in, and only save/advertise a Tailnet QR code after structured verification confirms `tailscale serve` is configured for Wolfpack’s port.

## 1. lock the remote-setup contract with focused failing tests

Add focused unit coverage around an importable Tailscale setup helper before changing production behavior. Cover these externally visible states:

- no Tailscale binary: setup explains that phone/remote control needs Tailscale and can install it or terminate cleanly;
- unsigned-in Tailscale: setup launches/points to the platform sign-in flow and lets the user retry in the same run rather than requiring a blind rerun;
- `tailscale serve` failure or an unexpected structured serve status: existing remote config remains unchanged, new config contains no hostname, and no remote QR is emitted;
- verified success: the canonical hostname from `tailscale status --self --json` is persisted, the configured port appears in parsed `tailscale serve status --json`, and the QR source is exactly `https://<hostname>/`;
- a no-Tailscale/local-only setup never calls its localhost URL a phone QR.

Use an injected subprocess boundary for tests; production must execute fixed Tailscale arguments, never compose a shell command from hostname or user input.

## 2. extract and harden Tailscale configuration

Extract hostname discovery, sign-in retry, `tailscale serve`, and structured serve-status verification from `src/cli/setup.ts` into a focused importable CLI module.

The helper must parse the documented JSON outputs as structured data, validate the hostname and configured backend port, and return a discriminated success/failure result. It must not infer success from terminal prose or a command’s exit code alone.

On success, return only the verified canonical Tailnet hostname. On failure, return actionable platform-specific guidance without mutating config or printing a remote URL. Preserve the existing Linux privilege behavior and the macOS app-launch path.

## 3. make the interactive wizard resumable and truthful

Update `wolfpack setup` to use the extracted helper after local project/port configuration:

- replace “optional — needed for remote access” with copy that says Wolfpack’s phone/remote workflow requires Tailscale;
- when unsigned in, repeatedly offer retry or explicit cancellation after launching/showing the sign-in instruction; do not make the user rerun the whole wizard;
- persist `tailscaleHostname` only after the helper reports verified success;
- preserve a previous verified hostname if a later setup attempt fails;
- after service setup, print the Tailnet URL and QR only when a verified remote URL exists; otherwise print the local URL as desktop-only and never label it as usable from a phone.

The service remains optional, but its prompt must state that it keeps Wolfpack reachable after login/reboot. No browser route or server-side HTTP handler may run Tailscale commands.

## 4. align public guidance with the real product path

Update the README quickstart and first-five-minutes guidance to lead with: install, configure/sign in to Tailscale, scan the verified Tailnet QR from a phone, then start and control agents. Keep local browser access documented as a same-machine fallback, not the primary phone-access promise.

Document the failure recovery path: stay in the setup retry prompt after Tailscale sign-in; if serve verification fails, show the exact local diagnostic/retry action and withhold the QR.

## 5. verify behavior and review the trust boundary

Run each new focused test red before production changes, then green after the minimal implementation. Run `bun run typecheck`, `bun test`, and the relevant CLI/integration coverage. Manually verify on a signed-in Tailnet host that scanning the produced HTTPS QR from a phone opens the existing Wolfpack app/session; this is required release evidence and cannot be faked from the local test process.

Perform a differential EDC security review before PR creation. Confirm that the change preserves loopback binding, current origin/JWT rules, no browser-triggered subprocess execution, no user-controlled shell arguments, and no secrets/credentials in logs or QR URLs.

## non-goals

- no new local-only onboarding mode;
- no cloud relay, account system, LAN binding, JWT redesign, or broker protocol change;
- no claim that a local `localhost` QR can open a phone;
- no automatic remote reachability claim without a real Tailnet-device check.

## acceptance criteria

- a failed sign-in or failed/unverified `tailscale serve` cannot overwrite a good Tailnet hostname or emit a broken phone QR;
- a newly signed-in user can retry and finish from the same setup run;
- every advertised phone QR encodes a verified `https://<tailscale-hostname>/` URL;
- a local-only URL is clearly desktop-only;
- existing sessions remain broker-owned and unaffected by setup changes.
