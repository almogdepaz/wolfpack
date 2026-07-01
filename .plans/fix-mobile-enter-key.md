# fix mobile enter key

status: review notes addressed

## success criteria
- mobile terminal proxy enter still sends `\r` for interactive menus.
- mobile message textarea enter inserts newline even if `enterSends` is true/persisted.
- desktop enter-send behavior remains unchanged.
- regression test covers the decision logic.

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
