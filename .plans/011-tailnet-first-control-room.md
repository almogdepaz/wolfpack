# plan — tailnet-first wolfpack control room

## goal lock

make Wolfpack automatically discover and directly control Wolfpack hosts on one trusted Tailnet. Tailscale ACL admission is the complete default access-control boundary; Wolfpack adds no default JWT, pairing, credential store, account, relay, or central authority.

local-only installs remain supported. Optional operator-managed JWT is deferred to #259 and must not change this plan's default path.

## approved decisions

- `wolfpack setup` detects an installed/logged-in Tailscale client, configures and verifies `tailscale serve`, and otherwise leaves a usable local-only install with an explicit enable-Tailscale action.
- discovery probes reachable Tailnet peers, then shows ready Wolfpack peers by default; offline/non-Wolfpack state is available as diagnostics and never blocks ready/local rendering.
- durable identity is Tailscale stable node id plus a Wolfpack installation UUID. Hostname is display only.
- the canonical direct URL is verified `https://<machine>.<tailnet>.ts.net`, never a raw IP/port.
- each phone/browser subscribes to push from every Wolfpack host it uses; notifications deep-link to that host's exact terminal.
- incompatible hosts show upgrade-required and are not controllable.

## invariants

- Tailnet access equals shell-equivalent authority over visible sessions. State this in setup and docs; do not add a misleading Wolfpack permission layer.
- broker remains sole PTY/session/snapshot/output authority. Setup may restart the server only; never restart the broker.
- a browser aggregates direct peer APIs. No Wolfpack server federates peers or becomes a source of terminal state.
- discovery and handshake metadata contains no terminal output, prompts, project paths, tokens, or push payloads.
- Tailnet origin validation remains enforced. Never trust browser-supplied peer URLs or forwarded proxy headers as Tailnet authority.

## 1. Specify the direct Tailnet machine contract

define a versioned machine handshake with stable node/install identity, display facts, canonical Serve URL, protocol version, capabilities, and classified outcomes: offline, non-Wolfpack, incompatible, ready.

acceptance:
- one compatibility rule identifies controllable peers without hostname matching;
- unknown/old handshake versions fail closed to incompatible;
- no auth credential appears in the contract.

## 2. Implement verified Tailnet setup and advertising

extend setup to detect Tailscale readiness, configure `tailscale serve`, structurally verify the advertised HTTPS endpoint, persist install identity, and expose the approved handshake only after readiness is true.

acceptance:
- no copied secret, pairing, account, or JWT prompt in the normal path;
- setup failure keeps local Wolfpack usable and never advertises false remote readiness;
- server-only reload/restart preserves broker sessions.

## 3. Implement direct peer discovery and dashboard aggregation

use local Tailnet peer facts to probe the handshake endpoint directly. Bound probe time/failure independently, aggregate only structured machine/session projections in the browser, and retain stable peer identity separately from presentation preferences.

acceptance:
- ready peers appear automatically with their sessions;
- a failed/offline/non-Wolfpack/incompatible peer cannot delay local or healthy peers;
- every direct REST/WebSocket request uses the verified canonical host and existing Tailnet origin policy.

## 4. Route direct-host mobile supervision

register push subscriptions per host, include only a host/session route in a notification, and resolve it to the exact terminal through the existing attach/input flow.

acceptance:
- a notification from any paired-in-browser host opens that host's exact terminal;
- subscription/payload contains no terminal output, prompt, project path, credential, or opaque external-agent identifier;
- no second reply/resume/task-control UI is introduced.

## 5. Prove and communicate the supported loop

run a two-to-five-node macOS/Linux Tailnet matrix with iOS Safari/PWA and Android Chrome/PWA where supported. Cover local-only fallback, ready/offline/non-Wolfpack/incompatible peers, server-only restart, reload/reconnect, notification routing, and Ghostty resize/output disposition.

acceptance:
- docs claim only the tested direct Tailnet workflow;
- docs state Tailnet ACL authority and no Wolfpack-hosted relay/control plane;
- untested broker restart remains explicitly destructive.

## out of scope

- #259 optional JWT;
- device pairing, credential issuance/storage/revocation, cookies, bearer tokens, or shared-HS256 distribution;
- hosted analytics, relay, account, public-internet access, roles, per-session ACLs, task scheduler, terminal-text inference, IDE/review UI, or Git lifecycle management.
