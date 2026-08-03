# real mobile touch sorting

## goal

make long-press card sorting reliable in real mobile browsers without sacrificing ordinary vertical scrolling or changing desktop/keyboard ordering.

## success criteria

- touch movement before the 300ms hold remains native page scrolling and does not start sorting;
- after the hold activates sorting, card movement follows the touch and prevents native scrolling;
- release commits one reorder and cancellation restores the original order;
- controls inside cards never initiate sorting;
- mouse and keyboard ordering retain their current behavior;
- focused mobile, desktop, and ordering regression coverage passes;
- the frontend is deployed locally with broker replacement disabled.

## non-goals

- changing ordering persistence or hierarchy semantics;
- replacing the whole-card interaction;
- changing install behavior;
- changing the broker or active sessions.

## 1. reproduce native touch semantics

replace synthetic touch-pointer coverage with touch-event coverage that observes pre-activation scrolling allowance and post-activation cancellation.

## 2. separate mouse pointer and touch gesture handling

keep pointer events for mouse input and implement touch candidates, activation, movement, release, and cancellation with non-passive touch listeners.

## 3. verify and deploy

run typechecking, unit tests, focused mobile/desktop browser coverage, regenerate assets, deploy with `--broker=no`, and verify the served bundle plus broker/session preservation.
