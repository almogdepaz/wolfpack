# install flow parity

## goal

make curl, bunx, and npx entry paths install and launch the same supported Wolfpack server/broker pair without obsolete prerequisites or silent package-resolution failures.

## success criteria

- curl installation does not check for, install, or mention tmux;
- curl still stages both matching release binaries atomically and preserves an existing installation on failure;
- cold-cache `bunx wolfpack-bridge --version` and `npx --yes wolfpack-bridge --version` resolve the matching server and broker package for each supported target contract;
- missing platform artifacts fail loudly with an actionable command rather than a silent exit;
- package and release paths agree on supported OS/architecture names and installed binary pairing;
- setup, service, path, and upgrade differences are documented only where they are intentional;
- install policy, unit, package-layout, and fresh-cache smoke coverage passes.

## non-goals

- changing runtime session or broker protocols;
- adding unsupported platforms;
- changing optional Tailscale setup;
- publishing packages or releases in this branch;
- mutating the oldsgt installation before the local root cause and fix are verified.

## 1. inventory and reproduce

map curl and package entry boundaries, inspect history, reproduce cold-cache bunx/npx behavior, and identify where the paths first diverge.

## 2. remove obsolete prerequisites

add regression coverage and remove the tmux prerequisite from the curl installer without altering Tailscale's optional status.

## 3. repair package binary resolution

add failing package-layout/cold-cache coverage, fix the source resolution contract, and emit actionable errors for missing server or broker artifacts.

## 4. align documentation and verify

state common behavior and intentional differences precisely, run full verification, and perform non-destructive fresh-cache smoke tests.
