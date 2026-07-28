# pr 234 ci, merge, and deploy

status: deployed
branch: `fix/terminal-rendering`

## goal

Repair #234's failing CI, merge its source branch into this terminal-rendering branch, then locally install and deploy the combined result without replacing a live broker unless deployment verification requires it.

## execution

- [x] inspect failed CI and identify the stale control-api schema snapshot.
- [x] reproduce and update only the generated snapshot on `fix/issues-231-232`.
- [x] push the CI repair and verify GitHub checks.
- [x] commit terminal-rendering remediation and merge #234 into this branch.
- [x] run combined verification.
- [x] install and deploy after deploy-lock and active-deploy preflight.

## verification

- #234 GitHub Actions run `30338802602`: `test` and `ghostty-vt-behavior` pass.
- combined branch typecheck, 19 desktop E2E tests, and targeted unit suites pass.
- combined `bun test`: 1,412 pass, with one pre-existing local taxonomy ownership scanner TOCTOU error while an ignored `.cache/ghostty-vt` directory is removed.
- external Terminal deployment with `scripts/deploy-local.sh --broker=yes` completed: broker `12848 → 53897`, server `79249 → 53904`, and the post-deploy health check plus session API succeeded.

## safety

- preserve the broker: use server-only deployment unless the resulting artifact changes require a broker rollout and no deploy is active.
- do not remove a deploy lock without confirming no active deploy.
