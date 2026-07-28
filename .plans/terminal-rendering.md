# terminal rendering remediation

status: verification complete (full suite has unrelated pre-existing failures)
branch: `fix/terminal-rendering`

## goal

Correct browser terminal content corruption, effective-DPR changes, and Pi tool-panel colour capability negotiation.

## scope

1. Vendor the upstream Ghostty Web fixes represented by #177 (coherent WASM viewport row mapping and line-based scrollback) and #166 (runtime DPR tracking).
2. Preserve Wolfpack's required Ghostty Web compatibility patch while updating the generated browser bundle.
3. Advertise `COLORTERM=truecolor` to browser-backed broker sessions.
4. Add regression coverage for each behavior and run targeted verification.

## evidence

- Wolfpack's installed Ghostty Web 0.4.0 bundle reproduced the upstream #139 scrollback failure: append-only ANSI output at 130×39 grew from 641 to 345 retained rows.
- as of 2026-07-27, #177 is open, approved, clean to merge, and all upstream checks pass; it is not released to npm.
- as of 2026-07-27, #166 is closed without merge or discussion. its runtime-DPR implementation remains vendored because Wolfpack's direct browser regression reproduces the affected behavior and passes with the patch.
- npm/GitHub latest release remains `v0.4.0`.
- Browser-backed Pi receives `TERM=xterm-256color` without `COLORTERM`; it selects palette index 22 (`#005f00`) instead of its intended `#283228` tool-success background.

## execution

- [x] inspect the upstream #177/#166 source baseline and local compatibility patch.
- [x] vendor the smallest coherent upstream source/artifact update.
- [x] add failing regression coverage before production changes where the harness permits it.
- [x] set the browser session colour capability and test it.
- [x] regenerate public assets; typecheck and run targeted tests.

## constraints

- do not add repaint/timing workarounds.
- do not change non-browser broker session capability negotiation.
- do not silently discard the local Ghostty focus/cleanup patch.

## verification

- `bun run typecheck` passes.
- `bunx playwright test tests/e2e/ghostty-scrollback.e2e.ts --project=desktop` passes (scrollback retention and runtime DPR).
- `bunx playwright test tests/e2e/terminal-lifecycle.e2e.ts --project=desktop` passes.
- `bun test tests/unit/broker-backend.test.ts` passes.
- `bun test` ran: 1,447 pass; unrelated failures remain in the taxonomy ownership test (`.cache/ghostty-vt/.../CLAUDE.md` ENOENT) and the stale control API schema snapshot.
