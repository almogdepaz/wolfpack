# ralph srt socket status

- [x] confirmed failure mode: broker startup inside default srt fails on unix socket bind/listen
- [x] add explicit broker startup diagnostic for srt unix socket denial
- [x] keep default ralph srt from accessing Wolfpack's host broker socket
- [x] document ralph rule for plans needing unix socket bind/listen or host broker socket access
- [x] add regression coverage that default srt has no `allowUnixSockets` / `allowAllUnixSockets`
- [x] rerun focused + full verification after this revert

verification:
- `bun test tests/unit/ralph-sandbox.test.ts` — 19 pass
- `bun test` — 1501 pass
- `bun run typecheck` — pass
- `cargo test --manifest-path broker/Cargo.toml --bin wolfpack-broker` — 3 pass
- `cargo test --manifest-path broker/Cargo.toml` — 164 pass total across lib/bin/integration/fixtures/doc-tests
