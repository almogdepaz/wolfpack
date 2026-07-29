# ux/ui and terminal optimization implementation status

- plan: `.plans/004-ux-terminal-implementation.md`
- sha-256: `872c016041e46f5053265b2cc8c9f294099cf6987d626b255180275a6470da2b`
- branch: `feat/ux-terminal-reliability`
- overall: `in_progress`
- current phase: task 5 — blocked on representative Pi trace and remediation decision

## goal-lock

- direct contribution: tasks 1–4 are complete; task 5 remains blocked at its documented evidence gates
- source of truth: representative Pi ANSI trace, reproduced terminal state, and the existing corruption investigations
- preserved boundaries: broker attach, replay, snapshot, resize, and terminal authority remain unchanged by task 4
- non-goal check: no offline-terminal claim, repaint workaround, speculative corruption fix, or unmeasured prewarm policy

## task states

- 1: `completed`
- 2: `completed`
- 3: `completed`
- 4: `completed`
- 5: `blocked`

## decisions

- execute one independently verified task at a time
- task 1 uses one shared stream/color policy for stdout and stderr
- `NO_COLOR` overrides every color request; `FORCE_COLOR=0` disables color; other `FORCE_COLOR` values enable it; otherwise color requires a tty and non-dumb terminal
- list/kill JSON failures use one stable line: `{ "ok": false, "error": { "code", "message" } }`
- human diagnostics use stderr; successful human output and machine JSON use stdout
- `wolfpack --version` and `-V` are side-effect-free and read the package version
- task 3 exports broker output watermarks as canonical decimal u64 strings so JSON preserves full precision
- missing sequence fields from older brokers remain quiet and never trigger a snapshot fallback
- first observations, stable values, and regressed values are quiet; only a value above the retained watermark reports generic output
- dashboard summaries keep the legacy `lastLine` field empty; explicit transcript/read and attach paths retain authoritative snapshots
- task 5 is blocked by the representative Pi trace and remediation-decision gates in `.plans/background-tab-rendering.md`
- focused WebKit coverage stays intentionally small and exercises mobile settings/back navigation, transcript, accessory input, paste/beforeinput, touch scrolling, notification routing, reconnect, visibility resume, session drawer, visual viewport, and terminal output
- notification routes carry bounded stable session identity plus machine context; mutable session names are display/fallback data only
- service-worker notification clicks navigate an existing same-origin client to the stable route before focus, or open that route in a new client
- install metadata uses explicit 192/512 raster any-purpose and safe-zone-padded maskable icons
- disconnected output is described as cached and read-only; live terminal actions explicitly require reconnection
- production retains one Ghostty prewarm: three-run desktop/mobile/grid measurements save approximately 1.59 MiB backing storage versus two while preserving solo warm hits and acceptable reveal timing
- prewarm pool overrides remain bounded to 0–2 and debug-only

## verification

- plan digest reverified before task 1 completion
- baseline reproduced: `NO_COLOR=1 bun src/cli/index.ts list` emitted 20 ANSI sequences
- baseline reproduced: missing `kill --json` wrote colored human text to stdout, no JSON, and no stderr
- task 1 red: 14 passed, 6 expected failures for ANSI suppression, JSON failures, stderr diagnostics, and `--version`
- additional red: session-control JWT warnings and usage failures violated the stream/color contract
- additional red: non-interactive attach emitted ANSI to stderr
- additional red: `FORCE_COLOR=0` did not disable color on a tty
- focused green: 63 passed across CLI formatting/help/list/session-control/attach unit and integration tests
- typecheck green: `bun run typecheck`
- full suite green: `bun test` — 1,446 passed, 0 failed, 1 snapshot, 3,880 assertions
- diff hygiene green: `git diff --check`
- manual contract check: `NO_COLOR=1 ... list` emitted zero ANSI sequences; missing `kill --json` emitted one JSON error on stdout and empty stderr
- task 2 focused browser suite green: `bunx playwright test tests/e2e/accessibility-navigation.e2e.ts tests/e2e/ux-navigation.e2e.ts` — 61 passed, 20 intentionally skipped
- task 2 unit/full suite green: `bun test` — 1,446 passed, 0 failed, 1 snapshot, 3,880 assertions
- task 2 typecheck green: `bun run typecheck`
- task 2 diff hygiene green: `git diff --check`
- full Chromium E2E: 183 passed, 158 intentionally skipped, 4 failed; all four failures reproduce unchanged at baseline commit `56ade8d` (three final-column canvas checks and one grid recovery-snapshot check)
- task 3 red: broker facts omitted `outputSequence`; `/api/sessions` snapshotted each live session and did not react to sequence-only changes; schema rejected the new projection
- task 3 regression red: a regressed watermark replaced the retained high-water mark and falsely reported a later below-watermark value as output
- task 3 focused green: 226 passed across broker backend, output-sequence, schema, and API tests
- task 3 broker green: `cargo test --manifest-path broker/Cargo.toml` — 153 passed across unit, socket, FFI, fixture, and stress suites
- task 3 full suite green: `bun test` — 1,450 passed, 0 failed, 1 snapshot, 3,901 assertions
- task 3 typecheck green: `bun run typecheck`
- task 3 diff hygiene green: `git diff --check`
- task 4 focused unit green: 72 passed across push, stable notification routing, service-worker routing, PWA manifest, prewarm policy/debug, and performance harness suites
- task 4 WebKit red: `insertFromPaste` produced no PTY frame because the typed beforeinput allowlist omitted that input type
- task 4 paste regression green: 44 passed in `tests/unit/desktop-terminal-logic.test.ts`; focused WebKit then passed 12/12 mobile compatibility workflows
- task 4 focused desktop routing/offline regressions green and all equivalent Chromium cases passed in the broad run
- task 4 full suite green: `bun test` — 1,463 passed, 0 failed, 1 snapshot, 3,935 assertions
- task 4 full Chromium E2E: 186 passed, 158 intentionally skipped, 4 failed; the same three final-column canvas checks and one recovery-snapshot check reproduce at baseline `56ade8d`
- task 4 typecheck green: `bun run typecheck`
- task 4 generated-asset verification: `scripts/gen-assets.ts` rebuilt 31 embedded files after the final paste, service-worker, manifest, icon, bundle, and offline-message changes
- task 4 diff hygiene green: `git diff --check`
- pr build green: `bun run scripts/build.ts` regenerated 31 embedded assets, rebuilt the release broker, and compiled all four Bun targets
- final pr verification green: `bun test` — 1,463 passed; broker `cargo test` — 153 passed; focused WebKit — 12 passed; typecheck and staged diff hygiene passed
- plan digest reverified: `872c016041e46f5053265b2cc8c9f294099cf6987d626b255180275a6470da2b`

## changed files

### task 1 production

- `src/cli/formatting.ts`
- `src/cli/api.ts`
- `src/cli/attach.ts`
- `src/cli/index.ts`
- `src/cli/session-control.ts`
- `src/cli/sessions.ts`
- `README.md`

### task 1 tests

- `tests/unit/cli-formatting.test.ts`
- `tests/unit/cli-help.test.ts`
- `tests/unit/session-control.test.ts`
- `tests/unit/session-list.test.ts`

### task 2 production

- `public/app-dialog.ts`
- `public/app-grid.ts`
- `public/app.ts`
- `public/index.html`
- `public/project-picker.ts`
- `public/styles.css`
- `src/public-assets.ts`

### task 2 tests

- `tests/e2e/accessibility-navigation.e2e.ts`
- `tests/e2e/ux-navigation.e2e.ts`
- `tests/unit/project-picker.test.ts`

### task 3 production

- `broker/src/protocol.rs`
- `broker/src/registry.rs`
- `broker/src/session.rs`
- `broker/src/session_router.rs`
- `docs/broker-protocol.md`
- `docs/generated/control-api.schema.json`
- `src/broker-output-sequence.ts`
- `src/control-api/schema.ts`
- `src/server/backend.ts`
- `src/server/broker-backend.ts`
- `src/server/mock-backend.ts`
- `src/server/routes.ts`

### task 3 tests

- `tests/integration/api.test.ts`
- `tests/unit/__snapshots__/control-api-schema.test.ts.snap`
- `tests/unit/broker-backend.test.ts`
- `tests/unit/broker-output-sequence.test.ts`
- `tests/unit/control-api-schema.test.ts`

### task 4 production

- `.gitignore`
- `playwright.config.ts`
- `public/app.ts`
- `public/index.html`
- `public/manifest.json`
- `public/sw.js`
- `public/icon-512.png`
- `public/icon-maskable-192.png`
- `public/icon-maskable-512.png`
- `public/wolfpack-icon-maskable.svg`
- `scripts/terminal-load-perf.ts`
- `src/ghostty-prewarm-debug.ts`
- `src/ghostty-prewarm-policy.ts`
- `src/server/push.ts`
- `src/session-notification-route.ts`
- `src/terminal-input.ts`
- `src/public-assets.ts`

### task 4 tests

- `tests/e2e/notification-routing.e2e.ts`
- `tests/e2e/session-switch.e2e.ts`
- `tests/e2e/ux-navigation.e2e.ts`
- `tests/unit/desktop-terminal-logic.test.ts`
- `tests/unit/ghostty-prewarm-debug.test.ts`
- `tests/unit/ghostty-prewarm-policy.test.ts`
- `tests/unit/push.test.ts`
- `tests/unit/pwa-manifest.test.ts`
- `tests/unit/session-notification-route.test.ts`
- `tests/unit/sw-push-url-sanitize.test.ts`
- `tests/unit/terminal-load-perf.test.ts`

### tracking

- `.plans/004-ux-terminal-implementation.md`
- `.plans/004-ux-terminal-implementation.status.md`
- `.plans/004-terminal-prewarm-measurements.md`

## next action

- keep task 5 blocked until a representative Pi ANSI trace is captured and the typed resize request/ack versus upstream Ghostty remediation decision is evidence-backed
