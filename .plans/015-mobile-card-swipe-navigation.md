# mobile card swipe navigation

## goal

restore swipe-left navigation from a mobile session card to that card's terminal without exposing a blank terminal view.

## success criteria

- completing a left swipe activates the card's authoritative `.card-open` control;
- `state.currentSession` is selected before the terminal view is considered navigated;
- incomplete swipes still snap back without opening;
- terminal right-swipe back behavior remains unchanged;
- touch reordering remains long-press plus vertical movement and does not claim quick horizontal swipes;
- Chromium and mobile WebKit swipe regressions pass;
- the frontend is deployed with broker replacement disabled.

## non-goals

- changing terminal attachment or prefill behavior;
- changing swipe thresholds or terminal back-swipe edge policy;
- changing card ordering semantics;
- changing desktop navigation.

## 1. reproduce blank forward navigation

complete the existing card-swipe test and assert that the swiped card becomes the selected session.

## 2. activate the authoritative card control

replace the stale outer-card click with activation of the nested `.card-open` control while retaining swipe cleanup.

## 3. verify and deploy

run focused Chromium/WebKit swipe, reorder, and terminal-navigation coverage, full tests, and local `--broker=no` deployment verification.
