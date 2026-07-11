# Live update handoff

Wolfpack has two independently managed processes:

- `wolfpack` server: HTTP, WebSocket, static UI, and broker client.
- `wolfpack-broker`: PTY owner, child-process owner, replay ring, terminal snapshots, and output stream sequence numbers.

## Current restart behavior

Server-only restart is intended to be non-destructive. The server drops browser WebSockets and its broker client connection, then a fresh server reconnects to the same broker socket. Broker sessions, child PTYs, replay rings, and terminal snapshots remain owned by the still-running broker. Browser clients must reconnect and rehydrate from broker snapshots plus replay.

Broker restart is destructive today. The broker owns the PTY file descriptors and child processes, and there is no implemented broker-to-broker fd/state transfer protocol. Stopping or restarting the broker terminates broker-owned sessions and invalidates active browser attachments. Any update flow that restarts the broker must report that blast radius before it proceeds.

## Server-only update flow

When the CLI replaces the stable `wolfpack` server binary while the service is already running, it must restart only the server. It must not route the update through full service install, because service install stages and bootstraps the broker before starting the server.

The safe phase-1 flow is:

1. copy the current `wolfpack` binary to `~/.wolfpack/bin/wolfpack`.
2. read `/api/backend` when available to report active broker session count.
3. stop the server service only.
4. start the server service only, preserving the existing broker process and socket.
5. let browser sessions reconnect and rehydrate from broker-owned state.

If `/api/backend` is unavailable because the server is down, unreachable, or auth-protected, the CLI reports that the active broker session count is unavailable. The blast radius remains server-only: browser attachments disconnect briefly, but broker-owned PTYs should persist.

## Broker handoff design gate

Broker binary replacement remains design-first. Do not implement live broker handoff until tests prove that the platform can transfer every required ownership boundary without output gaps or duplication.

A viable protocol needs:

- versioned broker-to-broker handshake with explicit compatibility failure.
- PTY fd and child-process ownership transfer, or a documented platform-specific equivalent.
- terminal snapshot sequence at freeze time.
- replay ring lower/upper sequence bounds.
- subscriber set and reconnect policy.
- resize/write handling while transfer is in flight.
- rollback behavior when the new broker fails before it becomes authoritative.

Initial non-goal: replacing the broker binary without PTY fd/state transfer. A stop/start broker update is still a destructive restart and must be labeled that way.

## Failure modes to verify

Required coverage for the current phase:

- Rust broker tests continue to prove snapshot/replay sequencing and subscription behavior.
- TS service lifecycle tests prove server binary updates choose server-only restart instead of full broker install.
- Integration/e2e broker restart tests prove server restart preserves sessions and broker death does not leave stale session truth.

Future broker handoff coverage must add output-during-transfer, subscriber reconnect, resize-in-flight, handshake downgrade, and rollback-failure cases before enabling broker handoff by default.
