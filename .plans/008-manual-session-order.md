# persistent manual session-card ordering

## goal

session cards stay in the user-selected order across refreshes and runtime-state changes. delegation trees remain structurally valid: roots move as whole trees and children move only among siblings.

## scope

- browser-local persistence keyed by stable machine URL and broker session identity
- drag handles supporting mouse/pointer/touch interaction
- keyboard movement from the same handle
- per-machine reset action
- new sessions append; stale identities are ignored/pruned on the next explicit write
- no broker API, syncing, automatic attention ranking, or worktree behavior

## success criteria

1. default order is unchanged until the user explicitly moves a card.
2. a moved card retains its position after refresh and runtime-state changes.
3. session identity, not display name or status text, drives persistence.
4. roots and sibling children can be reordered without breaking delegation grouping.
5. inaccessible/corrupt storage falls back safely.
6. focused unit tests, typecheck, full unit suite, and targeted browser tests pass.

## phases

1. add failing unit tests for storage validation, reconciliation, hierarchy-preserving moves, and reset.
2. implement a small pure ordering module and integrate it into session projection.
3. add drag/pointer/keyboard handles plus per-machine reset controls.
4. add browser regression coverage for persistence, runtime-state stability, hierarchy, and keyboard/reset behavior.
5. run focused verification, typecheck, full unit tests, and targeted e2e tests.
