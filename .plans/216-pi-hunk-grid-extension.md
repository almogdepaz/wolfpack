# issue 216 — token-free pi command for hunk in the wolfpack grid

status: parent-verified — automated and real Pi-loader checks green; live Hunk flow blocked because `hunk` is not installed
issue: https://github.com/almogdepaz/wolfpack/issues/216
base: main @ 4dbe7fc

**goal**

invoking `/hunk` in pi creates a wolfpack-managed child shell for the current project, adds it beside the active pi session through the existing grid notification, and runs `exec hunk diff --watch` without starting a model turn.

**assumptions**

- pi, wolfpack, and hunk run on the same host
- `/hunk` is available only inside structured wolfpack session context
- `WOLFPACK_PROJECT_DIR` identifies the project root and `WOLFPACK_SESSION_NAME` identifies the active parent
- the browser is attached to the parent in a state where the existing `sub_session_opened` handler permits a single-session-to-grid transition
- `/hunk` accepts no arguments initially and always shows the current working-tree diff with watch mode
- the optional hunk review skill remains separate and is not required to launch the viewer

**success criteria**

- [x] `/hunk` is intercepted by pi without a model request
- [x] wolfpack's canonical session-create CLI/API can explicitly create a shell
- [x] `--grid` associates the new shell with the current wolfpack parent using structured context
- [x] successful creation emits the existing `sub_session_opened` frame; failed creation emits none
- [x] the extension sends `exec hunk diff --watch` to the returned stable session ID
- [x] exiting hunk ends its wolfpack session
- [x] missing context, binaries, malformed JSON, create failures, and send failures produce concise pi notifications
- [x] a send failure reports the surviving session identity instead of silently killing it
- [x] agent-only sub-session/open semantics continue rejecting shell harnesses
- [x] existing browser grid limits and view guards remain unchanged
- [x] the published package contains and declares the pi extension without adding a pi runtime dependency to ordinary wolfpack execution

**design constraints**

- keep `OpenableHarness` agent-only; introduce a session-create-specific shell-capable type rather than weakening the sub-agent contract
- keep PTY creation and identity authoritative in the broker/server path
- use argv arrays and JSON responses; never scrape terminal prose or interpolate shell commands into a wrapper shell
- use the existing parent identity and `sub_session_opened` channel; do not add browser automation or a second grid-control protocol
- keep the launch deterministic: the extension calls wolfpack directly and never sends a user message to pi
- treat create-then-send as a partial-failure boundary; preserve and report a created shell when delivery fails
- touch no unrelated dirty files on `dev_new`

## 1. Extend structured session creation for shell and grid parenting

**deliverable:** `wolfpack session create <project> --harness shell --grid --json` creates a shell associated with the current wolfpack session and returns its stable identity.

- add failing parser tests in `tests/unit/session-control.test.ts` for explicit shell selection, `--grid`, missing parent context, and invalid option combinations
- add failing CLI request tests in `tests/unit/session-control-fast-path.test.ts` proving exact JSON request shape and structured failure output
- add a session-create-specific harness/type guard in `src/session-create-contract.ts` that includes `shell` without changing `OpenableHarness`
- extend `src/cli/session-control.ts` so `--grid` resolves only from `WOLFPACK_SESSION_NAME` and sends structured parent context to `/api/session-create`
- extend `src/server/routes.ts` and `src/server/session-create.ts` to validate the active parent identity, persist it on the child, and invoke the existing best-effort notification only after successful creation
- add integration coverage in `tests/integration/api.test.ts` for shell creation, parent identity, stable result fields, notification success, no notification on create failure, and missing parent rejection
- retain regression coverage in `tests/unit/session-open-contract.test.ts` and `tests/unit/session-open.test.ts` proving agent child spawning still rejects shell

**red evidence required:** parser/API tests fail because shell and `--grid` are unsupported or ignored.

**green gate:** focused session-control, session-create, session-open, and API tests pass.

## 2. Add the token-free pi `/hunk` extension

**deliverable:** a packaged extension registers `/hunk`, creates the grid child through the canonical CLI, and starts hunk without invoking the model.

- add a failing extension test under `tests/unit/` that captures the registered command and exercises its observable behavior through the pi execution/UI boundaries
- cover exact argv for create and send, JSON decoding, stable-ID targeting, missing wolfpack context, missing `wolfpack`, missing `hunk`, malformed output, create failure, send failure, and unexpected arguments
- add `extensions/hunk.ts` with a framework-required default export and otherwise named/pure helpers where they improve testability
- derive the project name from structured `WOLFPACK_PROJECT_DIR`, not chat text or `ctx.cwd` heuristics
- run `wolfpack session create <project> --harness shell --grid --json`, then `wolfpack session send <session-id> "exec hunk diff --watch" --json` through `pi.exec` argv arrays
- notify success/failure through `ctx.ui.notify`; do not call `pi.sendUserMessage`, register an LLM tool, or include command output in model context
- on send failure, include the created session name/ID in the notification and leave cleanup to the user

**red evidence required:** extension test fails because `/hunk` is not registered.

**green gate:** extension tests pass with no real Wolfpack server, Hunk process, or model request; only the external CLI boundary is substituted.

## 3. Package and document the integration

**deliverable:** users can install the Wolfpack package as a pi package, discover `/hunk`, and understand prerequisites and lifecycle.

- update `package.json` so the npm tarball includes `extensions/` and the pi manifest declares the extension while preserving existing skill discovery
- add only development/type metadata needed to typecheck the extension; do not introduce a runtime dependency from the Wolfpack CLI to pi
- add a package-content regression test or existing pack-check assertion proving the extension is present in the published file set
- update `docs/session-control.md` with shell creation and `--grid` semantics, including structured-context requirements and viewer guard behavior
- add a concise `/hunk` section to the existing pi/agent integration documentation rather than duplicating session-control details
- document `hunk` as an external prerequisite, same-host limitation, zero-model-turn behavior, partial send failure, and the optional review skill

**green gate:** package tests and `npm pack --dry-run` (or the repository's canonical equivalent) show the extension and required docs, with no unexpected runtime dependencies.

## 4. Verify contracts and live behavior

**deliverable:** automated and manual evidence demonstrates the integration without regressing agent spawn or terminal/grid behavior.

- run focused unit and integration tests for session control, session creation/opening, API routes, package contents, and the pi extension
- run `bun run typecheck`
- run the focused desktop grid Playwright cases covering `sub_session_opened`
- run full `bun test`
- install/load the local extension in pi, invoke `/reload`, then invoke `/hunk` from a wolfpack-hosted pi session
- verify the new Hunk session joins the current single-session view as a grid, refreshes after a repository edit, and disappears after quitting Hunk
- manually verify failure messages for missing Hunk and a forced send failure without allowing the model to run
- record exact commands, pass/fail counts, and any untested areas in this plan before claiming completion

**completion gate:** all automated checks are green and the local Pi → Wolfpack grid → Hunk watch flow is observed end to end.

**out of scope**

- embedded hunk rendering
- automatic hunk installation
- remote/cross-machine viewer launch
- argument variants such as staged, commit, or path-filtered reviews
- changing existing grid capacity or view guards
- generalized workflow/plugin execution tracked by issue 215
- replacing hunk's review skill

## implementation status evidence — 2026-07-23

### red evidence

- `bun test tests/unit/session-control.test.ts tests/unit/session-control-fast-path.test.ts tests/unit/session-create.test.ts tests/integration/api.test.ts tests/unit/hunk-extension.test.ts tests/unit/pi-package.test.ts` failed before production changes with 11 failing tests + 1 module-load error:
  - shell `--grid` create parsed as usage error
  - grid create made no `/api/session-create` request and missing context returned usage
  - `extensions/hunk.ts` was missing, so `/hunk` was not registered
  - package manifest/tarball lacked `pi-package`, `pi.extensions`, and `extensions/hunk.ts`
  - session-create dropped parent identity and `/api/session-create` rejected shell/parent requests
- `bun test tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts tests/unit/session-open-contract.test.ts` then failed because the generated control API schema snapshot had not yet been updated for `SessionCreateHarness` + `parentSession`.

### green/focused verification

- `bun test tests/unit/hunk-extension.test.ts`: 5 pass, 0 fail.
- focused contract/API/package suite: `bun test tests/unit/session-control.test.ts tests/unit/session-control-fast-path.test.ts tests/unit/session-create.test.ts tests/integration/api.test.ts tests/unit/hunk-extension.test.ts tests/unit/pi-package.test.ts tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts tests/unit/session-open-contract.test.ts tests/unit/session-open.test.ts`: 189 pass, 0 fail, 1 snapshot.
- `bun test tests/unit/taxonomy-ownership.test.ts`: 4 pass, 0 fail after replacing raw `"shell"` check with `AGENT_KIND.SHELL`.
- `bun run typecheck`: passed (`bunx tsc --noEmit -p . && bunx tsc --noEmit -p public/`).
- `bun test`: 1833 pass, 21 skip, 0 fail, 1 snapshot. skipped broker tests require a locally built broker binary.
- `npm pack --dry-run --json`: tarball includes `extensions/hunk.ts`, `docs/session-control.md`, `docs/agent-skills.md`, `skills/**`, no bundled deps.
- `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop -g "sub-session notification"`: 2 passed.

### generated artifacts

- ran `bun run gen:schema`; updated `docs/generated/control-api.schema.json` and `tests/unit/__snapshots__/control-api-schema.test.ts.snap`.
- no browser bundle/assets touched.

### manual gaps / risks

- not run: live manual Pi package install/reload and real Pi → Wolfpack → Hunk smoke. remaining manual check: install/load local package in Pi, invoke `/reload`, invoke `/hunk` from a Wolfpack-hosted Pi session, confirm Hunk joins the single-session view as grid, refreshes after repo edit, exits with Hunk, and confirm missing-Hunk/send-failure notifications without a model turn.
- broker-backed integration tests that require a locally built broker binary remained skipped by the existing test guards.

## review finding remediation — 2026-07-23

### fixed finding 1: incompatible create-success response could target a non-shell/blank session

- red: `bun test tests/unit/hunk-extension.test.ts` failed after adding regression coverage. A nominal create success with `harness: "pi"` still made `wolfpack session send stable-hunk "exec hunk diff --watch" --json`; expected no send and an incompatible-response notification.
- change: `extensions/hunk.ts` now validates the parsed create success before send: `session` and `sessionId` must be non-empty, `harness` must be exactly `shell`, and `project` must exactly match the project derived from `WOLFPACK_PROJECT_DIR`.
- green: `bun test tests/unit/hunk-extension.test.ts` => 6 pass, 0 fail.
- green: `bun run typecheck` => passed (`bunx tsc --noEmit -p . && bunx tsc --noEmit -p public/`).

### intentionally remaining findings after finding 1 pass

- finding 2 was still open after the finding 1 pass: stale-parent recheck not addressed there.
- finding 3 remains open: subprocess timeout/error bounding not addressed there.

## review finding remediation — 2026-07-23 finding 2

### fixed finding 2: session-create grid notification stale-parent recheck

- inspected: `/tmp/wolfpack-216-review.md`, `3fcf1d4 fix(server): fail closed on stale session-open parent`, current `src/server/session-open.ts`, `src/session-create-contract.ts`, `src/cli/session-control.ts`, and `src/control-api/schema.ts`.
- red: `bun test tests/integration/api.test.ts -t "agent-native top-level session control"` failed after adding regression coverage: post-create parent disappearance and same-name UUID replacement both returned `200` and would notify by reusable parent name.
- change: `/api/session-create` now re-reads structured parent identity after successful create and before notification. unchanged parent id => notify/success; missing parent => typed partial failure `PARENT_SESSION_NOT_FOUND`; replaced UUID => typed partial failure `PARENT_SESSION_CHANGED`; both include `createdSession` because the shell may survive, and both emit no `sub_session_opened` frame.
- public contract: `SESSION_CREATE_ERROR.PARENT_SESSION_CHANGED` and `SESSION_CREATE_HTTP_STATUS` were added; generated schema now lists session-create coded errors by HTTP status. docs explain post-create partial-success semantics.
- green: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test tests/integration/api.test.ts tests/unit/session-create.test.ts tests/unit/session-open.test.ts tests/unit/session-open-contract.test.ts tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts tests/unit/session-control-fast-path.test.ts tests/unit/session-control.test.ts` => 185 pass, 0 fail, 1 snapshot.
- green: `bun run typecheck` => passed (`bunx tsc --noEmit -p . && bunx tsc --noEmit -p public/`).
- green: `bun test tests/unit/hunk-extension.test.ts` => 6 pass, 0 fail, confirming finding 1 regression remains green.
- green: `git diff --check` => no whitespace errors.

### follow-up: fixed remaining finding-2 CLI/extension partial-success contract defect

- red: `bun test tests/unit/session-control-fast-path.test.ts tests/unit/hunk-extension.test.ts` failed after adding regressions. CLI JSON for `PARENT_SESSION_CHANGED` omitted validated `createdSession`; `/hunk` reported only the mapped create error and did not mention the surviving shell identity.
- change: CLI session-create error handling now parses only structured JSON API error bodies for typed post-create partial failures (`PARENT_SESSION_CHANGED`, `PARENT_SESSION_NOT_FOUND`), preserves a validated non-empty `{ session, sessionId, project, harness }` as top-level `createdSession` in `--json`, and ignores malformed partial identities. plain output appends the surviving session/id when available.
- change: `/hunk` now parses only structured CLI JSON on nonzero create results for typed post-create partial codes; if the validated `createdSession` is `harness: "shell"`, has non-empty `session/sessionId`, and its `project` matches the current `WOLFPACK_PROJECT_DIR` basename, it reports the surviving session name/id and still does not call `wolfpack session send`.
- docs: `docs/session-control.md` notes that CLI JSON preserves validated `createdSession` for grid partial failures.
- green: `bun test tests/unit/session-control-fast-path.test.ts tests/unit/hunk-extension.test.ts tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts` => 37 pass, 0 fail, 1 snapshot.
- green: `bun run typecheck` => passed (`bunx tsc --noEmit -p . && bunx tsc --noEmit -p public/`).
- green: `git diff --check` => no whitespace errors.

### fixed finding 3: bounded Pi `/hunk` subprocess duration and notifications

- red: `bun test tests/unit/hunk-extension.test.ts` failed after adding regressions. `pi.exec` calls had no timeout options, killed preflight/create/send results were trusted like normal output, oversized structured messages rendered unbounded text, and arbitrary stderr was surfaced as user-visible failure text.
- constants: `HUNK_PREFLIGHT_TIMEOUT_MS = 5_000`, `WOLFPACK_CREATE_TIMEOUT_MS = 15_000`, `WOLFPACK_SEND_TIMEOUT_MS = 5_000`, `MAX_STRUCTURED_ERROR_CHARS = 160` Unicode code points plus `…` suffix when clamped.
- change: local Pi API type now models `pi.exec(command, args, { timeout })`; every `/hunk` subprocess still uses fixed argv arrays and now passes the phase timeout.
- change: killed results are handled before parsing stdout or status: preflight => `Timed out while checking whether Hunk is available.`, create => `Timed out while creating the Wolfpack Hunk session.`, send => `Created Wolfpack session <name> (<id>), but timed out while starting Hunk.`
- change: create/send failures parse only structured JSON `error.message`; arbitrary stderr/prose is ignored and falls back to phase defaults (`session creation failed`, `send failed`). structured messages are Unicode-safe clamped. Pi has no documented maxBuffer option, so this bounds subprocess duration and rendered notification text while keeping canonical `pi.exec`.
- preserved: missing-binary, malformed create JSON, post-create partial survivor reporting, send-failure survivor reporting, and non-shell/version-skew checks remain green.
- green: `bun test tests/unit/hunk-extension.test.ts tests/unit/pi-package.test.ts tests/unit/package.test.ts` => 12 pass, 0 fail.
- green: `bun run typecheck` => passed (`bunx tsc --noEmit -p . && bunx tsc --noEmit -p public/`).
- green: `git diff --check` => no whitespace errors.

### intentionally remaining findings

- no review findings remain intentionally open from the original three-item review set.

## final parent verification — 2026-07-23

- independent GPT-5.5 re-review: ship; no actionable findings after all three remediation passes.
- `bun run typecheck`: passed.
- `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test`: 1843 pass, 21 existing broker-dependent skips, 0 fail, 1 snapshot across 123 files.
- deterministic schema regeneration: `docs/generated/control-api.schema.json` SHA-256 `ebdfc399f5275da8de47d9708b16a9b189fa646981258b03c16289dbd9606dca`; snapshot SHA-256 `18a2b0473880f98d127f12ad910ef025f39cc4e35f1076646e502a9ce5b8f413`; both unchanged after regeneration.
- `npm pack --dry-run --json`: 13 package files; `extensions/hunk.ts`, `docs/session-control.md`, and `docs/agent-skills.md` present.
- `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop -g "sub-session notification"`: 2 passed.
- real Pi RPC loader smoke loaded `extensions/hunk.ts`, listed `/hunk` as an extension command, invoked `/hunk`, emitted the expected missing-Hunk UI notification, emitted zero model-turn events, and emitted no extension error.
- `git diff --check`: clean.

### remaining manual gap

- `hunk` is not installed on this host, so the real Pi → Wolfpack shell/grid → `hunk diff --watch` lifecycle cannot be exercised here. automated extension, API, browser-grid, packaging, and Pi-loader boundaries are green; broker-backed tests retain their pre-existing skip guards because a local broker test binary is not built.
