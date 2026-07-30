# tagged ghostty build release recovery status

- plan: `.plans/007-tagged-ghostty-release-recovery.md`
- plan sha256: `c0c40201b79f8b9c8cddc9119762dfd880f852b225387f813d35bf7d1e6bbabf`
- overall: `in_progress`
- current phase: `3`

## task state

- 1 reproduce tagged-build metadata leakage: `accepted`
- 2 isolate the ghostty source build: `accepted`
- 3 verify and merge the fix: `in_progress`
- 4 release v1.6.10: `not_started`

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

## next action

commit, push, open the fix pr, and require main ci before release.
