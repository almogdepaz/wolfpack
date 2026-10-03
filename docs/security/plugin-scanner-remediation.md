# Plugin Scanner remediation

Wolfpack is scanned with `plugin-scanner` 3.0.123 using the default profile.
This document records the remediation for the source findings reported during the
community-plugin submission scan.

## HARDCODED_SECRET

No scanner suppression or baseline is used. Test credentials are generated at
runtime rather than committed as literals:

- `tests/integration/auth-middleware.test.ts`
- `tests/integration/cli-machine-routing.test.ts`
- `tests/integration/task-relay-packaged-worker.test.ts`
- `tests/integration/task-relay-trusted-peer-http.test.ts`
- `tests/integration/task-relay-volatile-http.test.ts`
- `tests/unit/service-auth.test.ts`

The short-secret test cases construct their deliberately invalid input at
runtime in `tests/unit/auth-startup.test.ts`, `tests/unit/service-auth.test.ts`,
and `tests/unit/session-control.test.ts`. `scripts/gen-assets.ts` uses an
asset-version marker (not a token-named variable), and the terminal reconnect
fixture uses a screen marker rather than a token-named variable.

## SHELL_INJECTION_PATTERN

`scripts/publish.ts`, `src/cli/setup.ts`, and `src/cli/service.ts` invoke
external commands through `execFileSync` with argument arrays. The package
installer and service manager therefore do not interpolate paths, package
names, service identifiers, or flags into a shell command. The Linux Tailscale
setup downloads the user-requested installer to a temporary file before the
privileged command executes it; it no longer pipes a network response into a
shell.

## DEPENDABOT_MISSING

`.github/dependabot.yml` schedules weekly updates for both npm dependencies and
GitHub Actions.

## Reproduction

From the repository root:

```sh
python3 -m pip install 'plugin-scanner==3.0.123'
plugin-scanner scan . --format json --min-score 80 --fail-on-severity high
```
