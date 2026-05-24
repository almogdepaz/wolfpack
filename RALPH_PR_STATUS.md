# ralph codex/srt pr status

- [x] branch identified: `fix/ralph-codex-srt`
- [x] reverted default srt host broker socket access
- [x] docs updated for default-srt socket policy
- [x] regression tests updated for no default `allowUnixSockets` / `allowAllUnixSockets`
- [x] verification rerun after revert

verification:
- `bun test tests/unit/ralph-sandbox.test.ts` — 19 pass
- `bun test` — 1501 pass
- `bun run typecheck` — pass
- `cargo test --manifest-path broker/Cargo.toml --bin wolfpack-broker` — 3 pass
- `cargo test --manifest-path broker/Cargo.toml` — 164 pass total

notes:
- base branch: `main`
- README checked; no srt socket policy text needed there
- commit/push requested after this status update
