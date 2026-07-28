# pr 234 ci, merge, and deploy

status: in progress
branch: `fix/terminal-rendering`

## goal

Repair #234's failing CI, merge its source branch into this terminal-rendering branch, then locally install and deploy the combined result without replacing a live broker unless deployment verification requires it.

## execution

- [x] inspect failed CI and identify the stale control-api schema snapshot.
- [x] reproduce and update only the generated snapshot on `fix/issues-231-232`.
- [ ] push the CI repair and verify GitHub checks.
- [ ] commit terminal-rendering remediation and merge #234 into this branch.
- [ ] run combined verification.
- [ ] install and deploy after deploy-lock and active-deploy preflight.

## safety

- preserve the broker: use server-only deployment unless the resulting artifact changes require a broker rollout and no deploy is active.
- do not remove a deploy lock without confirming no active deploy.
