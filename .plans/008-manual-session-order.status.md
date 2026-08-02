# persistent manual session-card ordering status

- plan: `.plans/008-manual-session-order.md`
- overall: `complete`
- current phase: `complete`

## task state

- 1 ordering model tests: `accepted`
- 2 ordering model and projection integration: `accepted`
- 3 drag, touch, keyboard, and reset controls: `accepted`
- 4 browser regression coverage: `accepted`
- 5 verification: `accepted`

## decisions

- ordering is browser-local and per stable machine/session identity.
- runtime state never affects ordering.
- delegation roots move with descendants; children move only among siblings.
- new sessions append; stale identities are pruned on the next explicit write.

## evidence

- replacement issue: https://github.com/almogdepaz/wolfpack/issues/248
- superseded automatic-ranking issue #212 is closed as not planned.
- red: ordering module import was absent; focused unit test failed before implementation.
- unit model: 13 focused ordering/delegation tests passed.
- browser behavior: 9 applicable delegation tests passed across iphone se, iphone 14, and desktop; covers keyboard, mouse drag, touch-pointer drag, refresh persistence, runtime-state stability, new-session append, tree preservation, and reset.
- accessibility/layout: 25 applicable accessibility and ui-polish tests passed.
- final typecheck passed across root, browser, and strict browser configs; both new ordering modules are strict-checked.
- final full bun suite: 1,456 passed, 22 skipped, 0 failed.
- full e2e exposed five failures; clean `origin/main` independently reproduces the three final-column failures and the grid snapshot failure. the one branch regression was traced to handle placement shifting the delegation toggle under the card-open hit point, fixed by placing the handle after card content.
- final relevant browser suites: 75 passed, 47 inapplicable skips, 0 failed across iphone se, iphone 14, desktop chromium, and applicable mobile webkit coverage.
- final delegation suite: 9 passed, 3 inapplicable skips, 0 failed; covers keyboard, mouse drag, touch-pointer drag, refresh persistence, runtime-state stability, new-session append, tree preservation, and reset.
- generated assets refreshed; `git diff --check` passed.

## next action

review the diff, then commit and open a pull request.
