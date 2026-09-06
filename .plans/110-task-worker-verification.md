# #301 verification

reviewed base: `3276836bde5663927452735276736f8135a98c36`.

## final verdict

no remaining actionable findings. independent full-diff review: `review-301-pass3.md`; integration-correction review: `review-301-final-gate.md`. honest authenticated-tailnet trust model; no adversarial inter-session or sandbox guarantees.

## execution evidence

| check | observed result |
| --- | --- |
| `bun test` (one repository-wide gate) | 2000 pass, 23 skip, 3 fail; all three failures investigated and corrected below |
| same failing files at detached base | 27 pass, 0 fail: failures were introduced, not baseline debt |
| final parent focused run: `bun test tests/unit/session-control-fast-path.test.ts tests/unit/taxonomy-ownership.test.ts tests/unit/task-worker-readiness.test.ts tests/unit/session-open-contract.test.ts` | 40 pass, 0 fail; all gate failures covered, including the entire readiness suite |
| `TMPDIR=/tmp WOLFPACK_BROKER_BIN=/Users/home/.wolfpack/bin/wolfpack-broker bun test tests/integration/broker-backend.test.ts` | 7 pass, 0 fail; real ordinary-launch/argv/PTY/kill behavior |
| affected feature unit/integration set before final taxonomy/expectation correction | 324 pass, 0 fail |
| real installed Pi/Pi Tasks readiness e2e, desktop project | 1 pass; exact identity/root/endpoint, successful exact-id kill and absence verified |
| real broker fake-Pi register-then-exit e2e, desktop project | 1 pass |
| `bun run typecheck` after final correction | exit 0 (all three TypeScript projects) |
| `bun build src/cli/index.ts --target=bun --outfile .plans/evidence/110-wolfpack-cli.js` after final correction | exit 0; 99 modules |
| generated artifact compared byte-for-byte with `generateControlApiSchemaText()` | exact match |
| `git diff --check` | clean |

full-suite findings: exact usage expectation omitted the new flags; two new comparisons bypassed the existing agent-kind authority; exact schema error expectation omitted the typed recovery envelope. fixes preserve strict assertions and use `AGENT_KIND.PI.id`. the full suite was NOT restarted after these corrections; only affected suites were rerun. overlapping counts above are not additive.

## regression and acceptance proof

- final-liveness deadline regression demonstrably fails restored old semantics (expected rejection, received resolution; exit 1), then passes current semantics. the first attempted red test was mis-specified and passed; it is explicitly excluded from red evidence.
- real temp-file preflight covers valid executable symlink, dangling executable, missing extension with a valid executable, and effective executable access.
- readiness covers exact identity/root, missing registration timeout, real gateway/store expired and foreign registration, final-liveness deadline, hanging inspection, exact cleanup on wrong root/name reuse, and ambiguous/unavailable cleanup.
- worker-specific post-create parent disappearance/replacement covers exact-id cleanup and recovery metadata.
- public create/open success and post-create failure bodies are checked against the generated schema; CLI recovery projection is separately covered.
- installed-Pi smoke and early-exit smoke use disposable broker/server fixtures, not production service restarts or user Pi configuration changes.

## limits

- 23 skip records in the repository-wide invocation were platform/broker-availability conditional. the affected real-broker integration file was then explicitly enabled and passed; unrelated broker restart/reflow and Linux-only installer checks were not expanded into scope.
- no repository-wide all-green rerun is claimed. the initial broad run plus final affected verification is the integration evidence.
- unrelated full browser and Rust suites were not rerun; no browser or Rust production code changed.
- endpoint readiness does not establish provider/model availability, task execution, or filesystem isolation.
- origin/main advanced to `70f8689` during work; no merge/rebase was performed. verification remains against the recorded feature base.

raw execution logs and intermediate reports remain local under `.plans/evidence/` and `.plans/`; this summary and final review reports are the retained PR evidence.
