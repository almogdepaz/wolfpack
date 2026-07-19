# session-open pr-readiness review

**status:** completed — findings 1–7 resolved and independently verified; PR-ready, not committed/pushed/deployed
**baseline:** `3304f5165decd254c1d88c3cddda41f1b741776b`
**scope:** all uncommitted plan 006/007 production, docs, schema, generated artifacts, and tests in `/private/tmp/wolfpack-dev07`
**goal:** review delivery, architecture, security, correctness, quality, and verification; send each confirmed issue to `wolfpack-sub-agent`, reach agreement, verify each fix, and repeat until PR-ready.

## review axes

1. delivery against `.plans/006-session-open-tailnet-trust.md` and `.plans/007-cli-help-and-repo-skill-install.md`
2. architecture against EDC server, CLI, and test invariants
3. security across auth, request validation, project containment, subprocess argv, and session identity boundaries
4. correctness and quality across naming, collision retries, parent replacement, CLI parsing/help, docs commands, schema consistency, and tests
5. fresh focused/full verification after review fixes

## findings log

### finding 1 — standalone copy documentation omitted required variables

- **status:** fixed and independently verified
- **evidence:** the copy code fence used `SOURCE` and `DEST_ROOT` without defining them, so execution in a fresh shell could target `/wolfpack-tailnet-control` and fail.
- **resolution:** worker defined `REPO`, `SOURCE`, `DEST_ROOT`, and `DEST` before the guard and added a regression.
- **review verification:** `bun test tests/unit/agent-skills.test.ts` — 7 passed; `git diff --check` clean.
- **follow-up under review:** the standalone copy block also needs to create its destination root when absent.

### finding 2 — fragmented session-open protocol constants

- **status:** fixed and independently verified
- **evidence:** harness catalog duplicated in server, CLI, and schema; stable error codes split across server, route, CLI, and schema strings.
- **resolution:** `src/session-open-contract.ts` now owns the harness catalog/type/guard and complete error-code union; server, route, CLI, and schema consume it.
- **review verification:** 180 focused tests passed with fixture signing disabled; root/public typechecks and diff-check passed.

### finding 3 — error status drift and test parsing of schema prose

- **status:** fixed and independently reviewed
- **evidence:** code-to-HTTP-status mapping was duplicated across allocator, routes, and schema; the initial consistency test recovered codes from human-readable schema strings with regex.
- **resolution:** shared structured status map drives allocator, route responses, and deterministic schema formatting. The mirrored test formatter introduced during the first fix was then removed; the test calls the single production formatter and asserts concrete output.
- **worker verification:** 180 focused tests passed, both typechecks passed, schema generation was deterministic, and diff-check was clean.

### finding 4 — install snippets are not behavior-tested and can create a dangling symlink

- **status:** fixed and independently verified
- **evidence:** symlink snippet did not reject a missing source; prior tests inspected strings/order instead of executing the advertised shell workflow.
- **resolution:** both snippets reject missing source before mutating destination roots. A real `/bin/bash` test proves fresh install, repeat refusal/non-overwrite, missing-source failure, symlink target, and copied content.
- **review verification:** 7 agent-skill tests passed with 81 assertions; diff-check clean.

### finding 5 — test-only schema formatter export

- **status:** fixed and independently verified
- **evidence:** `sessionOpenErrorLines` was exported solely for a redundant implementation-coupled test assertion.
- **resolution:** formatter is private; tests pin observable `controlApiSource` output and structured status-map completeness.
- **review verification:** 11 contract/schema tests, both typechecks, and diff-check passed.

### finding 6 — uncoded invalid bodies; first fix weakened body-size termination

- **status:** fixed, security correction independently verified
- **evidence:** malformed/non-object bodies bypassed coded `INVALID_REQUEST`. The first fix kept oversized request sockets alive after 64 KiB, allowing unbounded chunk streaming.
- **resolution:** malformed in-limit/non-object bodies receive the coded endpoint envelope; oversized bodies retain immediate `req.destroy()` and reset-or-generic-400 transport semantics.
- **review verification:** real chunked keep-alive regression terminates at the limit; 182 focused HTTP/API/session/schema/auth tests, both typechecks, and diff-check passed.

### finding 7 — prefill-timeout Playwright race

- **status:** fixed and independently verified
- **evidence:** full Playwright failed twice with no close event; target-only stress failed 1/30. The test advanced fake time after observing UI loading, which occurs before the WebSocket attach installs the protocol deadline.
- **resolution:** test waits for the exact outbound full-mode attach before advancing fake time, then polls for the exact close code/reason. No sleeps or production changes.
- **verification:** worker ordered stress passed 40/40 and full Playwright passed; independent post-fix full Playwright passed 86 with 109 applicability skips.

## final review result

- delivery verdict: delivered
- architecture fit: fits
- security verdict: approve; no surviving security findings
- quality/antipattern verdict: no surviving findings
- reports: `/tmp/wolfpack-session-open-delivery-review-final.md`, `/tmp/wolfpack-session-open-security-review-final.md`

## completed gates

- [x] read all changed production/tests/docs and relevant history
- [x] resolve and verify findings 1–7 with the worker
- [x] delivery/architecture report
- [x] security report
- [x] quality/antipattern review
- [x] focused tests for every fix
- [x] full Bun: 1753 passed
- [x] serial Rust: 174 passed
- [x] full Playwright: 86 passed, 109 applicability skips
- [x] root/public typechecks
- [x] deterministic schema/browser/embedded generation
- [x] four-target production build and compiled CLI smoke
- [x] final diff/status review; no commit/push/deploy performed
