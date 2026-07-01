# fix mobile enter key

status: accessory focus-loss fix verified

## success criteria
- mobile terminal proxy enter still sends `\r` for interactive menus.
- native textarea enter follows `enterSends` on mobile and desktop.
- mobile accessory/keycheck enter inserts newline when `#msg-input` is focused.
- mobile terminal proxy enter still sends `\r` for interactive menus.
- regression test covers both decision paths.

## notes
- root cause hypothesis: message textarea directly uses persisted `wpSettings.enterSends`; if a user has it true, mobile enter submits instead of inserting a newline.
- red test: `bun test tests/unit/desktop-terminal-logic.test.ts` failed because `shouldSubmitMessageInputOnEnter` was not implemented/exported yet.
- implemented pure Enter decision helper; `public/app.ts` now treats mobile textarea Enter as newline while leaving `mobile-kb-proxy` Enter unchanged.
- regenerated `public/wolfpack-lib.js`, `public/app.bundle.js`, and `src/public-assets.ts` via `bun run scripts/gen-assets.ts`.
- narrow green: `bun test tests/unit/desktop-terminal-logic.test.ts` passes.
- typecheck green: `bun run typecheck` exits 0.
- full suite green: `bun test` reports 1538 pass / 0 fail.
- edc review: 0 findings across all modules; optional tooling recommendation was to add bundle-level coverage for `window.WP.shouldSubmitMessageInputOnEnter`.
- added generated bundle characterization test: `tests/unit/bundle-client-lib.test.ts`.
- review-note verification green: `bun test tests/unit/bundle-client-lib.test.ts tests/unit/desktop-terminal-logic.test.ts` reports 30 pass / 0 fail; `bun run typecheck` exits 0; `bun test` reports 1539 pass / 0 fail.
- user-reported follow-up: accessory-row Enter still sent terminal enter while typing in `msg-input`.
- red test: `bun test tests/unit/desktop-terminal-logic.test.ts` failed because `shouldInsertMessageNewlineFromAccessoryKey` was not implemented/exported.
- red bundle test: `bun test tests/unit/bundle-client-lib.test.ts` failed until `public/wolfpack-lib.js` was regenerated with `shouldInsertMessageNewlineFromAccessoryKey`.
- accessory fix verification green: `bun test tests/unit/desktop-terminal-logic.test.ts tests/unit/bundle-client-lib.test.ts` reports 33 pass / 0 fail; `bun run typecheck` exits 0; `bun test` reports 1542 pass / 0 fail.
- correction: native textarea Enter should send when `enterSends` is enabled; only accessory/keycheck Enter inserts a newline while `#msg-input` is focused.
- red test: changed mobile textarea tests and bundle expectation; `bun test tests/unit/desktop-terminal-logic.test.ts tests/unit/bundle-client-lib.test.ts` failed against the previous helper behavior.
- correction verification: `bun test tests/unit/desktop-terminal-logic.test.ts tests/unit/bundle-client-lib.test.ts` reports 33 pass / 0 fail; `bun run typecheck` exits 0; `bun test` reports 1542 pass / 0 fail.
- user-reported follow-up: accessory Enter still sent prompt in real mobile testing.
- root cause hypothesis confirmed by regression: relying only on `document.activeElement === #msg-input` is fragile on mobile accessory taps; if focus is lost before `fire()`, the helper sends terminal Enter.
- focus-loss fix: accessory Enter now inserts a textarea newline when `#msg-input` is focused OR the textarea has draft text.
- focus-loss verification: `bun test tests/unit/desktop-terminal-logic.test.ts tests/unit/bundle-client-lib.test.ts` reports 34 pass / 0 fail; `bun run typecheck` exits 0; `bun test` reports 1543 pass / 0 fail.
