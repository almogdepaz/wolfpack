# mobile post-reorder terminal open

## goal

ensure a deliberate tap opens a session immediately after mobile touch reordering.

## success criteria

- touch release commits the reorder without leaving a global next-click suppression guard;
- the moved card can open its terminal immediately after release;
- mouse drag still suppresses the release-generated click;
- ordinary quick taps and pre-activation scrolling retain current behavior;
- Chromium and mobile WebKit regression coverage passes;
- the final frontend is deployed with broker replacement disabled.

## non-goals

- changing ordering persistence or hierarchy semantics;
- changing terminal attachment or prefill behavior;
- removing mouse click suppression;
- changing installation behavior.

## 1. reproduce the swallowed post-touch tap

add a mobile regression that commits a touch reorder and dispatches the deliberate card click before zero-delay timers run.

## 2. scope click suppression by input type

record drag input type and retain next-click suppression only for input paths that generate an unavoidable release click.

## 3. verify and deploy

run focused Chromium/WebKit ordering and terminal-open coverage, full tests, and local `--broker=no` deployment verification.
