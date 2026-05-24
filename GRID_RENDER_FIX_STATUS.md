# grid render + loading transition fix status

- [x] evidence: traced `addToGrid()` single→grid path; new grid cells are appended before async terminal mount starts hydration/loading.
- [x] regression: added e2e assertion that grid cells show loading immediately after `addToGrid()`; observed red before fix.
- [x] fix: new grid cells now enter `grid-loading` synchronously before async terminal mount.
- [x] verify: narrow e2e passed after bundle/assets; full desktop grid e2e passed; typecheck passed; `bun test` passed.
- [ ] verify: full Playwright suite has pre-existing/non-grid mobile broker failures at `POST /api/create`; desktop grid coverage passed.
