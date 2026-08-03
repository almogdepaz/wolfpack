# status — tailnet-first wolfpack control room

- immutable plan: `.plans/011-tailnet-first-control-room.md`
- sha256: `51f69ab73c0185025660028b0138af624f9874ed420da20bf27a49e39735bde4`
- overall state: `in_progress`
- current phase: task 5 physical-device proof and documentation

## goal lock

- direct contribution: automatic direct Tailnet discovery/control with Tailnet ACL as default authority
- source of truth: immutable plan, broker/session invariants, and #203
- preserved boundaries: broker PTY authority, direct browser aggregation, Tailnet origin policy, and local-only operation
- non-goal check: no JWT/pairing/default credentials, relay, account, or hosted control plane

## task states

| task | state | evidence / next action |
| --- | --- | --- |
| 1. specify direct Tailnet machine contract | `completed` | approved contract: `docs/tailnet-machine-contract.md` |
| 2. implement verified Tailnet setup and advertising | `completed` | stable Tailscale `ID`/install identity, verified Serve-only advertising, and `/api/machine`; live status disproved the prior `StableID` assumption and regression tests now cover `ID`; `bun test` 1476 pass/22 skipped; typecheck passed |
| 3. implement direct peer discovery and dashboard aggregation | `completed` | bounded `/api/machine` probes, ready/offline/non-Wolfpack/incompatible projection, and stable peer identity registry; `bun test` 1476 pass/22 skipped; typecheck passed |
| 4. route direct-host mobile supervision | `completed` | existing origin-relative subscription/service-worker route satisfies the contract; focused unit tests 40 pass and notification e2e 4 projects pass |
| 5. prove and communicate supported loop | `blocked` | local macOS host: server-only deploy preserved 7 broker sessions; canonical `/api/machine` and discovery diagnostics verified. second macOS host is reachable but runs 1.6.7 without `/api/machine` and does not accept SSH. Android has not completed the browser/PWA matrix. do not claim remote support until both hosts run this build and device evidence exists |

## supersession

- plan 009's pairing-default strategy conflicts with the approved Tailnet-first trust model. it is superseded by this plan and must not be implemented.

## next action

run the physical Tailnet release matrix and update docs only with supported evidence.
