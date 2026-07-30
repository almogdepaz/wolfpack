# tagged ghostty build release recovery status

- plan: `.plans/007-tagged-ghostty-release-recovery.md`
- plan sha256: `c0c40201b79f8b9c8cddc9119762dfd880f852b225387f813d35bf7d1e6bbabf`
- overall: `in_progress`
- current phase: `4`

## task state

- 1 reproduce tagged-build metadata leakage: `accepted`
- 2 isolate the ghostty source build: `accepted`
- 3 verify and merge the fix: `accepted`
- 4 release v1.6.10: `in_progress`

## decisions

- preserve failed remote tag v1.6.9; advance package release to v1.6.10.
- source fix will prevent enclosing git discovery rather than inject a magic ghostty version.

## evidence

- failed release run: https://github.com/almogdepaz/wolfpack/actions/runs/30553762081
- both broker jobs panicked in ghostty `Config.zig` because wolfpack tag `v1.6.9` was detected as ghostty's own tag.
- red: focused test failed because `runGhosttySourceBuild` did not exist.
- green: `bun test tests/unit/build-ghostty-vt.test.ts` — 16 pass, 0 fail; real git command cannot discover the enclosing exact tag.
- tagged reproduction: exact temporary outer tag plus `bun run scripts/build-ghostty-vt.ts --target aarch64-apple-darwin` completed and staged the authenticated archive.
- `bun run typecheck` passed.
- `bun test` passed: 1464 pass, 0 fail.
- `cargo test --locked --manifest-path broker/Cargo.toml --all` passed: 153 tests across broker targets, 0 fail.
- fix pr #247 merged to main as `762d9976b5a9ea83378d058a65bbfa6a88b0f5a7`.
- post-merge main run 30578694562 passed both `test` and `ghostty-vt-behavior`.
- release worktree `bun run typecheck` passed.
- release/build-policy focused tests passed: 21 pass, 0 fail.
- first parallel full-suite run hit one unrelated randomized VAPID verification failure; 20 focused reruns passed, then a fresh sequential `bun test` passed: 1450 pass, 22 skip, 0 fail.

## next action

commit and push the verified v1.6.10 release branch and tag, then monitor github/npm publication.
