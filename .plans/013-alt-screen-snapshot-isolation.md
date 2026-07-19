# alternate-screen snapshot isolation

status: implementation and local verification complete; remote PR CI is the final gate
branch: fix/alt-screen-snapshot-isolation
base: main@ed009b3

## goal

Prevent broker snapshots taken while the alternate screen is active from exposing primary-screen scrollback.

## evidence

Deployed integration QA reproduced primary shell history in an alternate-screen reconnect snapshot on narrow viewports. `TerminalState::snapshot_with_reflow` selects the active visible buffer but always serializes `inner.scrollback`, which belongs to the primary screen.

## steps

- [completed] make the existing active-buffer snapshot test create primary scrollback and observe the leak.
- [completed] suppress primary scrollback while `inner.on_alt` is true.
- [completed] verify Rust (174), Bun (1,695 with local Git signing disabled to match CI), five consecutive iphone-se broker reconnect E2Es, release broker build, rustfmt, diff hygiene, and standalone security review approval.
- [completed] prepare the clean branch for a separate PR against `main`.

## remote gate

- push `fix/alt-screen-snapshot-isolation` and open a PR against `main`.
- require fresh CI to pass before merge.

## boundaries

- no session-open, session-control, mobile-scrolling, deployment, or integration-plan changes.
- no merge or release.
