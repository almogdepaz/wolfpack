# post-take ghostty prewarm replenishment

status: implemented
branch: post-take-ghostty-prewarm-replenishment

## goal
keep the Ghostty prewarm pool warm after a terminal consumes a prewarmed instance, without adding user-visible terminal-open delay.

## assumptions
- this is independent from pr #186; if #186 merges first, this branch may need a trivial rebase around `GHOSTTY_PREWARM_DELAY_MS`.
- refill should be best-effort/background-only.
- refill should not create more than `maxSize` idle+pending instances.

## success criteria
- consuming a prewarmed instance can schedule a replacement.
- taking from an empty pool does not schedule unnecessary work.
- concurrent/refill calls still respect pool capacity.
- app code remains non-blocking on terminal creation.
- typecheck and relevant tests pass.

## steps
- [x] create branch from main
- [x] write plan/status file
- [x] add failing unit test for refill-after-take behavior
- [x] implement deferred refill scheduler
- [x] wire terminal creation to schedule background refill after prewarm consumption
- [x] regenerate embedded assets
- [x] run focused tests + typecheck
