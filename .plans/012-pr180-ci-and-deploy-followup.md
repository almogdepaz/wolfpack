# pr #180 fast path, ci stabilization, and deployment safety

status: implementation and local verification complete; remote PR CI is the final gate
branch: feat/session-control-fast-path
push target: feat/session-open (PR #180)

## goal

Extend PR #180 with the verified session-control fast path, remove its nondeterministic CI failure, and prevent broker-replacing deployment from partially mutating an installation when invoked from a broker-owned Wolfpack PTY.

## evidence

- PR #180 CI run 29556087537 failed only at `slow_consumer_receives_subscription_dropped_event`.
- the failing test relies on Linux kernel socket-buffer saturation and a fixed three-second producer window.
- PR #183 passed the same test and requires no code changes.
- deployed QA proved `scripts/deploy-local.sh --broker=yes` restarts the broker, kills its invoking PTY, and exits before server restart/verification.

## steps

- [completed] replace the kernel-timing slow-consumer integration test with a deterministic test of the real `forward_output` backpressure/lag path.
- [completed] add a failing deployment regression for broker replacement inside structured Wolfpack session context.
- [completed] fail closed before build/install/restart for that unsupported invocation context.
- [completed] verify Bun (1,785), Rust (174), Playwright (86 passed/109 intentionally skipped), strict TypeScript, dependency audit, deterministic generation, four-target build, shell syntax/shellcheck, compiled CLI help, and diff hygiene.
- [completed] prepare a verified descendant for `feat/session-open` without changing PR #183.

## remote gate

- push this branch to `feat/session-open`.
- require fresh PR #180 CI to pass before merge.
- confirm PR #183 remains green and unchanged.

## boundaries

- no merge or release.
- no changes to PR #183 unless its own current CI exposes a branch-specific defect.
- broker alternate-screen isolation remains a separate clean branch/PR from `main`.
