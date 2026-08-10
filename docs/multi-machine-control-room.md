# Multi-machine control room

Wolfpack's dashboard and desktop session sidebar are a control room for Wolfpack sessions, not a general Tailscale device browser.

## Which machines appear

The local machine is always represented by its local sessions. A remote machine appears in the dashboard and sidebar only while all of these checks succeed:

1. the local Tailscale status reports the candidate online;
2. the candidate answers its own `/api/machine` endpoint with a compatible Wolfpack handshake bound to the expected Tailnet node and canonical origin;
3. the verified peer remains currently routable; and
4. its authenticated `/api/sessions` request succeeds.

An offline device, a Tailnet device without Wolfpack, a malformed or incompatible handshake, a failed candidate enumeration, or a failed sessions request does not produce an offline machine card. A peer that loses current authority is removed from both control-room surfaces. Previously loaded peers may remain visible only while a superseding refresh is still in progress; a failed authoritative result removes them.

**Settings → Machines** is the diagnostic surface for Tailnet discovery. It may list candidates that are not eligible for the control room, together with a bounded readiness diagnostic. Discovery by itself never grants routing authority.

## Display and identity boundary

Visible peer headers use the handshake display name and Tailnet hostname. The dashboard and sidebar use the same projection.

Tailnet node IDs, Wolfpack installation IDs, stable machine identities, transient candidate identities, and canonical origins remain in application memory for verification and routing. They are not rendered as labels or DOM attributes. Hostnames are the only remote-machine keys allowed in rendered controls; an action resolves the hostname back to a currently ready stable identity before any mutation or terminal connection.

This separation is intentional: friendly names are presentation data, while verified stable identities are authority data. Never replace the readiness lookup with a URL or identity taken from browser storage or markup.

## When a peer is missing

A missing generic or offline Tailnet device is expected. For a Wolfpack peer that should be visible:

- confirm both machines report the peer online with `tailscale status`;
- confirm Wolfpack is current and reachable through its canonical Tailnet HTTPS hostname;
- check authentication and Tailnet ACLs;
- open **Settings → Machines**, run **Discover Tailnet**, and read the diagnostic; and
- run `wolfpack doctor` on the peer.

Do not work around a failed check by adding an arbitrary peer URL. The next successful discovery and handshake refresh will add the peer automatically.
