# dev07 combined build and local deploy

## status
- branch: `dev07`
- worktree: `/private/tmp/wolfpack-dev07`
- base: `origin/main` (`115232d`)
- integrated commit: pr #177 (`a27ebcc`)
- current step: complete

## success criteria
- [x] create `dev07` from refreshed `main`
- [x] integrate pr #177 committed work
- [x] overlay findings 1–19 and pr #177 b1–b2 remediations
- [x] regenerate combined assets and schemas
- [x] pass combined focused tests and typecheck
- [x] build host binaries
- [x] deploy server and broker locally
- [x] verify restarted services and served app bundle

## verification
- combined bun suite: 1,690 passed, 0 failed
- combined rust suite: 174 passed, 0 failed
- desktop chromium regressions: 2 passed, 0 failed
- typecheck and `git diff --check`: passed
- installed server signature and signed-build hash: matched
- installed broker signature and signed-build hash: matched
- server restarted: pid 72332 -> 72507
- broker running from deployed path: pid 65470
- served app bundle sha-256 matched `public/app.bundle.js`
- live `/api/info`: version 1.6.7
