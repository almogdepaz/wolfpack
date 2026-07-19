# deploy-local explicit broker control

status: completed — explicit broker modes and integrated verification implemented; uncommitted and not deployed

## goal

make local deployment a single verified command with explicit broker deployment policy.

## success criteria

- `scripts/deploy-local.sh --broker=no` builds and atomically deploys only the Wolfpack server/CLI binary.
- `--broker=no` restarts the server, leaves the broker PID unchanged, and verifies all pre-existing session name/ID pairs survive.
- `scripts/deploy-local.sh --broker=yes` atomically deploys both binaries and intentionally restarts broker before server.
- missing, invalid, or conflicting broker arguments fail before build or filesystem/service mutation.
- both modes verify signed staged/installed binary hashes, server PID transition, served bundle hash, `/api/info`, and installed CLI help.
- output includes a machine-readable JSON summary.
- shell behavior tests cover both modes and verification failures.

## steps

- [completed] add failing behavior tests for mandatory broker mode and `--broker=no` preservation.
- [completed] implement strict argument parsing, atomic installs, and integrated verification.
- [completed] adapt `--broker=yes` regressions and add verification-failure coverage.
- [completed] run focused tests, typecheck, full Bun tests, shellcheck, syntax checks, and diff checks.

## constraints

- do not infer broker intent from artifact existence or git state.
- do not restart the live broker while developing or testing this script.
- do not commit, push, or deploy this follow-up without separate authorization.
