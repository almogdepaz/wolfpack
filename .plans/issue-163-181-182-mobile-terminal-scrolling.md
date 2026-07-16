# mobile terminal scrolling: issues #163, #181, #182

goal: reproduce each reported mobile scrolling failure and apply only evidence-backed fixes on one branch.

## ~~1. Create isolated branch and establish scope~~

- fresh worktree: `/private/tmp/wolfpack-mobile-terminal-scrolling`
- branch: `fix/mobile-terminal-scrolling`
- base: `main` at `ed009b3`
- issues: #163, #181, #182

## ~~2. Reproduce and diagnose #163~~

- historical fix `bedb118` covered switching between already-open sessions only
- reproduced unresolved path: fresh mobile load → first agent/session → 170px drag left `viewportY = 0`
- root cause: first-open used viewport prefill, which requests zero scrollback rows; switch-session already forced full prefill
- falsified touch/focus timing: the same first-open gesture worked when full history was supplied
- fix: first-session opening now uses the same full-prefill contract as switching
- focused regression passes on iPhone SE and iPhone 14 projects

## ~~3. Reproduce and diagnose #181~~

- reproduced: a 170px drag moved 6 rows while rendered row height required 11
- root cause: fixed 28px threshold ignored the actual ~15px terminal row height
- fix: derive touch-scroll threshold from renderer metrics with a fallback
- focused regression passes

## ~~4. Reproduce and diagnose #182~~

- reproduced: opening the keyboard left `viewportY` above zero
- root cause: keyboard activation did not release controller scroll lock or scroll to bottom
- active touch momentum could also move away from bottom after keyboard activation
- fix: cancel momentum and route bottom scrolling through the controller
- focused regression passes

## ~~5. Verify the combined branch~~

- focused iPhone SE: 5 passed (#163 first-open/switch, #181, #182, cached restore)
- focused iPhone 14: 5 passed (#163 first-open/switch, #181, #182, cached restore)
- typecheck: passed
- full Bun suite: 1,683 passed, 20 broker-dependent skips, 0 failed
- full Playwright rerun: 78 passed, 117 project/broker-dependent skips, 0 failed
- one prior Playwright run hit the unchanged fake-clock prefill-timeout test; isolated rerun and full rerun passed
- generated browser assets refreshed with `scripts/gen-assets.ts`
