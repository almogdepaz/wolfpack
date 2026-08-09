# Tailnet physical-device release matrix

This operator ledger supplies the physical-device release proof required by the [direct Tailnet control-room plan](../.plans/002-tailnet-control-room.md#4c-physical-device-matrix-and-release-gate). It is not automated-test evidence and does not change Wolfpack's trust boundary or control contract.

## release gate

- **release decision:** **BLOCKED**
- **physical-device evidence:** **UNVERIFIED**
- **operator:**
- **UTC completion date:**
- **release/build identifier:**
- **evidence record location:**

Do not change the decision to `GO` until every applicable required check below has a redacted evidence record and every failure has either passed recovery or an approved release exception. Automated tests do not satisfy this gate.

## evidence safety

Record only redacted identifiers such as `mac-a`, `linux-b`, `ios-1`, and opaque issue/evidence IDs. Do **not** record terminal output, project names or paths, credentials/tokens, Tailscale device names, or private Tailnet URLs. Record an outcome and a brief sanitized symptom instead of copied logs or screenshots containing sensitive content.

Each evidence record must contain:

| Field | Required value |
| --- | --- |
| Evidence ID | Opaque identifier, for example `tn-2026-08-09-01` |
| Operator and UTC time | Responsible person and completion time |
| Release/build identifier | Tested release or commit/build label |
| Client and target | Redacted client/device and host IDs only |
| Check ID | A check from this document |
| Result | `pass`, `fail`, `blocked`, or `n/a` with reason |
| Sanitized observation | User-visible outcome only; no sensitive content |
| Recovery/issue ID | Recovery result or opaque issue reference |

Use [multi-machine trial feedback](multi-machine-trial-feedback.md) for the accompanying qualitative report; it has the same redaction rule.

## prerequisites

Before recording matrix results:

1. select two to five controlled macOS/Linux Tailnet hosts; assign redacted IDs `host-a` through `host-e`. `host-a` and `host-b` are required; mark unselected `host-c` through `host-e` as `n/a — outside selected host count`.
2. install the same candidate release on every selected host using [installation](installation.md), and record only its release/build identifier.
3. confirm each host is signed into the intended private Tailnet and that its local `wolfpack doctor` result is successful. Do not copy command output into evidence.
4. confirm each host has a verified `tailscale serve` endpoint through setup/doctor. Use [troubleshooting](troubleshooting.md#tailscale-https--tailscale-serve-is-not-working) for a failed endpoint.
5. review [installation security and trust](installation.md#security-and-trust): a device permitted by the Tailnet boundary has shell-equivalent access to visible sessions. Do not test on an untrusted Tailnet.
6. identify one disposable, non-sensitive test session per target host. Do not include its name, project, command, or output in this ledger.
7. verify the candidate's API compatibility against [the control API contract](control-api-schema.md#tailnet-discovery-compatibility). This ledger does not substitute for contract tests.

## repeatable checks

Perform each check with a normal browser/PWA client. Record one evidence row for every required host/device cell in the matrices below.

| Check ID | Operator action | Passing result |
| --- | --- | --- |
| `H1` | On each selected host, open its local Wolfpack page and inspect the host's own sessions. | Local access works; the host remains usable even if remote peers are unavailable. |
| `H2` | From one selected host, open each other selected host through the Tailnet control room. | The peer becomes ready only through its verified direct route; no manually entered or stale URL is used. |
| `H3` | On each remote target, attach to the disposable session, observe a non-sensitive state change, send one harmless input, then detach. | Remote read/input/detach work and the target remains controllable after detach. |
| `H4` | Reload the client, then repeat one remote attach on each target. | The current verified peer identity routes correctly after reload; no stale peer is used. |
| `H5` | On each host, restart the Wolfpack **server only** using the recovery guidance, then repeat `H1` and one `H2`/`H3` path. | Local and direct-peer access recover; broker-owned test sessions remain present. |

## selected host matrix (2–5 macOS/Linux hosts)

`host-a` and `host-b` are required. There is one row for every directed source-to-target combination below; do not remove or merge rows. For an unselected optional host (`host-c` through `host-e`), enter **`n/a — host not selected`** in every cell involving that host, including OS/architecture and evidence. For an optional host selected for this release, replace each conditional cell with its required result; no selected-host cell may remain blank.

Diagonal rows require `H1` and `H5`; `H2`–`H4` are `n/a — same host`. Off-diagonal rows require `H2`–`H4`; `H1` and `H5` are `n/a — remote pair`.

| Source/client | Target host | OS/architecture | H1 | H2 | H3 | H4 | H5 | Evidence IDs / sanitized result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| host-a | host-a | required | required | n/a — same host | n/a — same host | n/a — same host | required | required |
| host-a | host-b | required | n/a — remote pair | required | required | required | n/a — remote pair | required |
| host-a | host-c | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| host-a | host-d | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| host-a | host-e | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |
| host-b | host-a | required | n/a — remote pair | required | required | required | n/a — remote pair | required |
| host-b | host-b | required | required | n/a — same host | n/a — same host | n/a — same host | required | required |
| host-b | host-c | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| host-b | host-d | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| host-b | host-e | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |
| host-c | host-a | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| host-c | host-b | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| host-c | host-c | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| host-c | host-d | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected |
| host-c | host-e | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected |
| host-d | host-a | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| host-d | host-b | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| host-d | host-c | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected |
| host-d | host-d | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| host-d | host-e | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected |
| host-e | host-a | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |
| host-e | host-b | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |
| host-e | host-c | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected |
| host-e | host-d | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected | n/a — remote pair; otherwise n/a — host not selected | required if both selected; otherwise n/a — host not selected |
| host-e | host-e | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | n/a — same host; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |

## iOS and Android PWA matrix

Install/open the supported browser PWA on at least one controlled iOS device and one controlled Android device. For each selected target host, complete `M1`–`M4`. If a platform is not supported for the release, record `n/a` with the release-approved reason; do not silently omit it.

| Check ID | Operator action | Passing result |
| --- | --- | --- |
| `M1` | Open the installed PWA from its home-screen entry while connected to the Tailnet. | It opens the intended control room without requiring a private URL to be recorded. |
| `M2` | Open each selected host and attach to its disposable session. | Peer selection and terminal attach complete through a current verified route. |
| `M3` | Send one harmless input and confirm a non-sensitive state change; detach and reopen once. | Input, output, detach, and reattach remain usable. |
| `M4` | Background the PWA, return it to foreground, reload once, then repeat one target attach. | Recovery does not route to a stale/offline peer. |

For every unselected optional target (`host-c` through `host-e`), enter **`n/a — host not selected`** in every cell for that target. For a selected optional target, replace every conditional cell with its required result; no selected target cell may remain blank.

| Client platform | Device ID | Target host | M1 | M2 | M3 | M4 | Evidence IDs / sanitized result |
| --- | --- | --- | --- | --- | --- | --- |
| iOS PWA | ios-1 | host-a | required | required | required | required | required |
| iOS PWA | ios-1 | host-b | required | required | required | required | required |
| iOS PWA | ios-1 | host-c | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| iOS PWA | ios-1 | host-d | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| iOS PWA | ios-1 | host-e | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |
| Android PWA | android-1 | host-a | required | required | required | required | required |
| Android PWA | android-1 | host-b | required | required | required | required | required |
| Android PWA | android-1 | host-c | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected | required if host-c selected; otherwise n/a — host not selected |
| Android PWA | android-1 | host-d | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected | required if host-d selected; otherwise n/a — host not selected |
| Android PWA | android-1 | host-e | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected | required if host-e selected; otherwise n/a — host not selected |

## failure and recovery checks

Run these on a controlled target after its normal matrix checks. Restore the target before proceeding. Follow [troubleshooting](troubleshooting.md) rather than improvising broker restarts.

| Check ID | Induced condition and recovery | Passing result | Evidence fields to record |
| --- | --- | --- | --- |
| `R1` | Make one target unavailable to the Tailnet, refresh another client's control room, then restore it. | The unavailable peer is not controllable; local and healthy peers remain usable; restored peer requires current verification before use. | client/target IDs, unavailable/restore outcome, recovery ID |
| `R2` | Disable or invalidate the target's Serve availability, confirm the failure, then rerun setup/doctor and restore verified Serve. | Local-only access remains usable; remote access resumes only after verified recovery. | target ID, sanitized failure class, doctor/setup outcome |
| `R3` | Restart the target's Wolfpack server only, not its broker; repeat a remote `H3` attach. | Remote access recovers and the disposable session remains available. | target ID, server-only recovery result, session-preservation result |
| `R4` | On iOS and Android, interrupt network access briefly, restore it, foreground/reload the PWA, and repeat `M2`. | The PWA does not use a stale route; a healthy current peer can be opened after recovery. | platform/device ID, target ID, recovery outcome |

If a recovery requires a broker restart, stop and record `blocked`; broker restarts terminate broker-owned sessions. See [the broker restart warning](troubleshooting.md#sessions-disappeared-after-broker-restart).

## final operator decision

| Requirement | Status | Evidence IDs / release exception |
| --- | --- | --- |
| Selected host count is 2–5 and every required directed pair passed `H1`–`H5` | BLOCKED |  |
| iOS PWA checks passed for every selected target | BLOCKED |  |
| Android PWA checks passed for every selected target | BLOCKED |  |
| Failure/recovery checks `R1`–`R4` passed | BLOCKED |  |
| No sensitive evidence appears in this ledger or linked evidence | BLOCKED |  |
| **Release decision** | **BLOCKED** | Set to `GO` only after all rows above are `pass` or have an approved exception. |
