# Multi-machine control room

Wolfpack's dashboard and desktop session sidebar are a control room for Wolfpack sessions, not a general Tailscale device browser.

## Which machines appear

The local machine is always represented, including an unavailable state when its session service cannot be read. A remote machine offers live session actions only while all of these checks succeed:

1. the local Tailscale status reports the candidate online;
2. the candidate answers its own `/api/machine` endpoint with a compatible Wolfpack handshake bound to the expected Tailnet node and canonical origin;
3. the verified peer remains currently routable; and
4. its authenticated `/api/sessions` request succeeds.

Previously verified peers can remain as disabled machine rows after a failure, with last-success/stale-since information and an explicit **Retry** or **Authenticate** action. This presentation cache is memory-only for the current page lifetime: at most 8 stale machines, expiring 7 days after the last successful verification or session summary. Reloading clears it. Retained rows contain machine metadata, not terminal bytes, session previews, or live session controls. Unknown/unverified candidates never become retained chooser rows. Recovery of the same verified identity preserves manual machine and session ordering. A replacement Wolfpack installation does not inherit the old installation's routes or session order.

**Settings → Machines** distinguishes handshake verification from session-service health. Authentication required, transport failure, incompatible installation, and broker unavailable are different states. Choosers and settings report discovery progress, last successful discovery, and the last error. Discovery by itself never grants routing authority; retained metadata never authorizes terminal or mutation traffic.

## Freshness and recovery

Visible pages discover candidates every 15 seconds, prioritizing previously verified peers in the existing bounded probe pool. Enumeration errors receive bounded 2/5/10-second recovery attempts before normal cadence resumes. Manual discovery uses the same publication/diagnostic path as automatic discovery.

Each machine independently refreshes session summaries every 5 seconds while a chooser is active, including an open mobile drawer above a terminal. Existing header-authenticated lifecycle events invalidate only the affected machine; reconnect obtains an authoritative snapshot because the event stream has no replay. Polling remains the repair path when streaming is unavailable. Terminal exit evidence also requests reconciliation. Stop acknowledgment is not proof of exit: the exact session UUID remains marked stopping until an authoritative summary removes it, without hiding a replacement using the same name.

Visibility resume, window focus, and persisted page restoration coalesce reconciliation. Hidden pages suspend discovery, session polling, and lifecycle streams. Background reads never open a token dialog; authentication is an explicit user action, and its dialog is cancelled when its machine owner is retired or the page is hidden. These are responsive-environment targets, not guarantees of physical mobile/PWA or Tailnet latency.

## Display and identity boundary

Visible peer headers use the handshake display name and Tailnet hostname. The dashboard and sidebar use the same projection.

Each machine owns its display name. By default it is the OS computer name (macOS `ComputerName`, Linux `hostnamectl --pretty`), falling back to the short hostname. To override it, run `wolfpack setup --non-interactive --display-name "Studio Mac"` on that machine; an empty value (`--display-name ""`) restores the automatic name. The name is stored as `displayName` in `~/.wolfpack/config.json`, is limited to 128 visible characters, and is read when the server starts: setup restarts a running server service, and a foreground server needs a manual restart. Its own dashboard and every peer handshake then carry the new name unchanged. Peers never rename a machine locally.

Tailnet node IDs, Wolfpack installation IDs, stable machine identities, transient candidate identities, and canonical origins remain in application memory for verification and routing. They are not rendered as labels or DOM attributes. Hostnames are the only remote-machine keys allowed in rendered controls; an action resolves the hostname back to a currently ready stable identity before any mutation or terminal connection.

This separation is intentional: friendly names are presentation data, while verified stable identities are authority data. Never replace the readiness lookup with a URL or identity taken from browser storage or markup.

## Local display preferences

The dashboard and desktop sidebar each remember whether a machine group is collapsed in this browser profile. Machine order is shared between those surfaces; it is local storage only, never a Tailnet setting or routing input. The visible chevron alone toggles the body. Drag the machine name to reorder it; click or tap the name for compact move-up/down options, or press Alt+Up/Down while the name is focused. A collapsed header shows only its name and expand control; expanding restores eligible machine actions. Missing peers retain their stored rank; a newly ready peer appends after saved entries. Preferences never create a peer, keep an ineligible peer visible, or authorize a machine action.

## When a peer is missing

A missing generic or offline Tailnet device is expected. For a Wolfpack peer that should be visible:

- confirm both machines report the peer online with `tailscale status`;
- confirm Wolfpack is current and reachable through its canonical Tailnet HTTPS hostname;
- check authentication and Tailnet ACLs;
- open **Settings → Machines**, run **Discover Tailnet**, and read the diagnostic; and
- run `wolfpack doctor` on the peer.

Do not work around a failed check by adding an arbitrary peer URL. The next successful discovery and handshake refresh will add the peer automatically.
