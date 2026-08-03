# mobile drawer delegation hierarchy

## goal

make the in-terminal mobile session drawer present delegation relationships clearly instead of flattening child agents into unrelated rows.

## success criteria

- collapsed drawer lists top-level sessions and orphan sessions, not ordinary children;
- a parent row has a compact accessible disclosure with child count;
- expanding a parent inserts its children directly below it in hierarchy order;
- child rows are visibly indented and remain inside drawer bounds;
- selecting a drawer row retains existing session-switch behavior;
- multi-machine labels and current-session styling remain intact;
- focused mobile drawer, delegation, navigation, and accessibility coverage passes.

## non-goals

- changing delegation identity or broker behavior;
- adding a separate drawer ordering system;
- changing desktop sidebar behavior;
- changing installation behavior.

## 1. add hierarchy regression coverage

prove collapsed, expanded, adjacent, indented, and accessible drawer behavior with structured parent identities.

## 2. project drawer rows through shared hierarchy

reuse the authoritative delegation projection and existing per-machine expansion state when rendering drawer rows.

## 3. polish and verify

add bounded child-row styling, preserve switching and drag-to-close behavior, then run focused and broad verification.
