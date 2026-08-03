# Tailnet machine contract

Status: proposed contract for #203. It defines discovery facts only; it does not add an application authentication layer.

## Trust model

A Wolfpack host is reachable only through its verified Tailscale Serve URL. Tailscale ACL admission is the complete default authority boundary: a Tailnet principal permitted to reach a Wolfpack host has shell-equivalent authority over its visible sessions.

Wolfpack does not issue, store, forward, or require credentials for this contract. Optional JWT is separate deferred work (#259), not a fallback required by this protocol.

## Canonical peer address

A host obtains its own canonical address from `tailscale status --self --json` and advertises only:

```text
https://<machine>.<tailnet>.ts.net
```

The setup flow configures and structurally verifies `tailscale serve` before the host is advertised as remotely ready. Raw IP addresses, ports, user-entered URLs, MagicDNS short names, forwarded-host headers, and browser-provided peer addresses are not canonical addresses.

A discovering host gets candidate peers only from its local `tailscale status --json` output. It derives each candidate's HTTPS DNS name from that output and does not follow redirects.

## Versioned handshake

A ready host serves this JSON document at:

```text
GET /api/machine
accept: application/json
```

The endpoint is read-only, has no side effects, and carries no terminal output, prompt text, project path, session names, push subscription, token, or user identity.

```json
{
  "protocol": { "name": "wolfpack-machine", "major": 1, "minor": 0 },
  "machine": {
    "tailnetNodeId": "stable-tailscale-node-id",
    "installationId": "wolfpack-installation-uuid",
    "displayName": "work-mac",
    "url": "https://work-mac.example.ts.net"
  },
  "wolfpack": { "version": "1.0.0" },
  "capabilities": ["sessions", "terminal-websocket", "push-subscription"]
}
```

### Field rules

- `protocol.name` is exactly `wolfpack-machine`.
- `protocol.major` is the compatibility boundary. A client controls a peer only when it supports that exact major version.
- `protocol.minor` may add optional fields/capabilities. Unknown fields and unknown capabilities are ignored.
- `machine.tailnetNodeId` is the stable node identifier reported locally by Tailscale; it is not a hostname and must not be inferred from one.
- `machine.installationId` is a persistent UUID generated once per Wolfpack installation. Reinstallation produces a new value; a hostname rename does not.
- `machine.displayName` is presentation only and is never an authorization or routing input.
- `machine.url` must exactly equal the candidate's locally derived canonical HTTPS origin after normalized comparison. A mismatch is incompatible, not a redirect target.
- `wolfpack.version` is display/diagnostic data, not the protocol compatibility decision.
- `capabilities` is a deduplicated set of documented string constants. Version 1 defines `sessions`, `terminal-websocket`, and `push-subscription`.

The response uses `cache-control: no-store`.

## Discovery outcomes

Each probe has an independent bounded timeout. A failed candidate must not delay local sessions or any healthy peer.

| outcome | condition | dashboard behavior |
| --- | --- | --- |
| `ready` | canonical HTTPS response is valid, supported major matches, URL/node identity agrees with local Tailscale peer facts, and required capabilities exist | show the machine and permit its normal direct session APIs |
| `offline` | Tailscale reports it unavailable, or DNS/TLS/connect/timeout failure prevents a response | keep prior display metadata as stale diagnostics; do not show/control its sessions |
| `non-wolfpack` | successful canonical response is 404 or does not validate as a Wolfpack machine document | omit from normal machine list; expose in diagnostics only |
| `incompatible` | valid Wolfpack document has an unsupported major, missing required capability, canonical URL mismatch, or node identity mismatch | show upgrade-required; do not control the peer |

A malformed response is `non-wolfpack` unless it identifies itself as `wolfpack-machine`; a self-identified but invalid document is `incompatible`. HTTP authentication challenges are not a normal state in this contract and are reported as incompatible configuration.

## Browser and WebSocket rules

The dashboard talks directly to each ready peer; no Wolfpack host relays, proxies, aggregates, or becomes authoritative for another host's sessions.

- REST calls target only a ready peer's verified canonical origin.
- terminal sockets target that same origin via `wss:` and use the existing terminal protocol.
- no request places a bearer token, credential, or peer address in a URL, notification, diagnostic copy, or browser persistence.
- peer CORS/origin validation accepts only the configured Tailnet HTTPS suffix and approved local development origins. It does not grant access merely because a hostname ends in `.ts.net` when the request did not arrive through the verified Tailscale Serve path.
- the existing server-side Tailscale proxy-header rule remains constrained to traffic that Tailscale Serve injects; it is never generalized to arbitrary reverse proxies.

## Push routing

Push subscription registration occurs separately with every ready host the browser uses. A push payload identifies only that host's stable machine identity and the stable Wolfpack session id needed to route the user to the existing terminal view. It contains no terminal content, project path, prompt, credential, external-agent id, or arbitrary peer URL.

On notification open, the browser resolves the stored host/session route, verifies that host through normal readiness rules, and then uses the ordinary direct attach/input flow. This protocol adds no reply, resume, or task-control surface.

## Local-only mode and failure recovery

A host without installed/signed-in Tailscale remains a functional localhost Wolfpack instance. It is not advertised and does not attempt peer discovery. Setup offers an explicit Tailscale-enable/retry action; it must not manufacture a remote URL or degrade broker-owned sessions.

Restarting the Wolfpack server may refresh handshake/setup state. Restarting the broker remains destructive and is never a setup or discovery recovery action.

## Required tests before implementation is accepted

- contract serialization/validation, including unknown minor fields and capabilities;
- URL and node-id mismatch rejection;
- classification of offline, non-Wolfpack, malformed/self-identified-invalid, and incompatible peers;
- independently bounded probes proving a bad peer cannot delay healthy/local rendering;
- Tailnet Serve/origin negatives for REST and WebSocket;
- local-only setup regression;
- direct per-host push route validation without sensitive payload fields.
