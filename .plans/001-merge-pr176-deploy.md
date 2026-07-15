merge pr #176 into dev07 and deploy

- status: completed
- target branch: `dev07`
- source: pr #176 / `fix/163-mobile-session-scroll` / `bedb118`
- push: merge was initially local; subsequent `dev07` push is tracked separately

## ~~1. Merge pr #176~~
- merged the fetched pr head as `3b83088` with explicit history.
- resolved generated-asset overlap by regeneration.

## ~~2. Verify integration~~
- typecheck and `git diff --check` passed.
- focused session-switch suite: 20 passed, 31 skipped.
- full Bun suite: 1,690 passed; Rust suite: 174 passed.
- full Playwright suite: 73 passed, 89 skipped.

## ~~3. Build and deploy~~
- built release server and broker artifacts.
- deployed through `scripts/deploy-local.sh` and completed the interrupted server handoff with a detached restart.
- verified server pid change, valid signatures, served bundle identity, and live version 1.6.7.
