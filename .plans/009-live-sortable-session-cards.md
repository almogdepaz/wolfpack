# live sortable session cards

## goal

replace handle-only drop ordering with direct card manipulation: the selected card follows the pointer and neighboring cards shift before release.

## success criteria

1. desktop card-body drag starts after a movement threshold; clicks and card controls retain existing behavior.
2. touch card-body drag starts after a long press; ordinary vertical scrolling remains available before activation.
3. the dragged card remains visible under the pointer and a placeholder moves live among same-scope siblings.
4. delegation subtrees remain attached and cross-scope drops are impossible.
5. release persists once; cancellation restores the original DOM without persistence.
6. alt+arrow keyboard movement remains available from the card-open control.
7. focused unit/e2e coverage, typecheck, full bun tests, and relevant browser suites pass.

## phases

1. replace existing e2e expectations with failing direct-drag/live-placeholder coverage.
2. implement pointer candidate, floating card, subtree placeholder, and live sibling displacement.
3. remove visible handles and wire accessible keyboard ordering to card-open controls.
4. verify click, scroll, delegation, accessibility, and persistence regressions.
