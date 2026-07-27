# libghostty-vt broker evaluation

status: evaluation complete; implementation awaiting approval
started: 2026-07-26
scope: investigation only; no production changes or broker restart
worktree: `/tmp/wolfpack-libghostty-vt-eval` at `origin/main` (`d572f45`)

## goal

determine whether Wolfpack should replace the custom terminal emulator in `broker/src/terminal_state.rs` with `libghostty-vt`, while preserving broker ownership, the existing wire protocol, browser behavior, reconnect ordering, and live-session safety.

## assumptions

1. Ghostty is preferred unless its public API or operational costs create a hard blocker.
2. The Rust broker remains the sole PTY/session owner.
3. Browser Ghostty, broker protocol, snapshot JSON shape, replay rings, and attach ordering remain unchanged.
4. Any adoption pins an immutable Ghostty revision.
5. Investigation may use throwaway code outside production paths; implementation requires separate approval.
6. No broker deployment, replacement, or restart is allowed during this evaluation.

## success criteria

- map the complete current `TerminalState` contract and call graph
- verify Ghostty can feed arbitrary chunked bytes and expose equivalent screen, cursor, attributes, scrollback, alternate-screen, resize, and Unicode state
- establish the real Rust integration path through Ghostty's public C ABI
- compare current and Ghostty state using existing fixtures and representative recorded streams
- quantify build, binary, runtime, memory, licensing, versioning, and deployment costs
- produce a go/no-go recommendation and a staged migration/rollback design

## phases

- [x] 1. current contract inventory
  - inspect `terminal_state.rs`, broker call sites, protocol snapshot types, TS snapshot renderer, and fixtures
  - record required semantics and compatibility boundaries
- [x] 2. Ghostty API and packaging audit
  - inspect `include/ghostty/vt.h`, C examples, build files, supported targets, license, and version history
  - identify stable/public versus internal APIs
- [x] 3. throwaway Rust integration spike
  - compile or consume a pinned `libghostty-vt` static library
  - bind only the minimum C ABI required to feed, resize, and traverse terminal state
  - keep spike code outside Wolfpack production paths
- [x] 4. behavioral comparison
  - replay existing broker fixtures through both engines
  - compare cells, cursor, attributes, scrollback, alternate screen, resize/reflow, graphemes, and wide cells
  - classify divergences as current bug, Ghostty mismatch, or snapshot-protocol limitation
- [x] 5. operational comparison
  - measure feed/snapshot latency, memory per session, binary size, and clean-build overhead
  - assess compiler pinning, release packaging, cross-compilation, crash boundary, and upgrade burden
- [x] 6. migration design and recommendation
  - preserve the existing Rust `TerminalState` interface and snapshot protocol where possible
  - design dual-run shadow comparison before cutover
  - define deployment, observability, rollback, and removal gates
  - document hard blockers and remaining unknowns

## status log

- 2026-07-26: created clean detached worktree from `origin/main`; preserved unrelated dirty work in `/Users/home/Dev/wolfpack`.
- 2026-07-26: confirmed EDC ownership: broker remains canonical PTY/state owner; snapshot changes couple broker daemon, TS client/renderer, browser hydration, and tests.
- 2026-07-26: mapped the replacement seam to `TerminalState::{new,feed,resize,snapshot_with_reflow}`; PTY ownership, seq ordering, rings, fanout, and protocol can remain Rust-owned.
- 2026-07-26: audited Ghostty revision `7aa9591746ffa4d2eee458960c76554352832595`. Its public C API exposes terminal creation/feed/resize, active/history grid traversal, graphemes, wide-cell markers, styles, cursor, title, modes, scrollback, and VT formatting. The API explicitly remains unstable.
- 2026-07-26: built the pinned static library with Zig 0.16.0 and SIMD disabled; resulting macOS arm64 archive is 8.0 MB. A warm cached rebuild completed in 0.82 s; clean-build measurement remains pending.
- 2026-07-26: proved C consumption against the static archive. The throwaway Rust/C shim compiles, but Cargo selected the colocated dylib at final link despite the static request; isolate the archive or use an explicit link argument next.
- 2026-07-26: found a current protocol-projection gap: `scroll_region` is serialized but `snapshot-render.ts` does not restore it, while origin mode is restored before absolute cursor positioning. Ghostty's VT formatter can emit scrolling regions and broader state directly; evaluate an ANSI-checkpoint snapshot alongside cell projection.
- 2026-07-26: Rust/C spike linked the pinned static archive with no runtime Ghostty dylib dependency. Existing Wolfpack fixtures matched exactly; Ghostty correctly diverged on DEC graphics, custom tab stops, cursor shape, and full-page resize/reflow.
- 2026-07-26: representative measurements: ~10x feed throughput, materially lower retained-state RSS, and a 61,822-byte VT checkpoint versus 10,716,512-byte structured JSON for the same 530-line state.
- 2026-07-26: verified immutable 3.2 MiB Ghostty source artifact and macOS arm64/Linux x86_64/Linux arm64 static builds. Cold builds add roughly 48–67 seconds and about 1 GB peak build memory.
- 2026-07-26: recommendation and staged migration written to `.plans/libghostty-vt-broker-evaluation-report.md`.

## deliverables

- this plan/status document
- compatibility and operational findings: `.plans/libghostty-vt-broker-evaluation-report.md`
- no production-code changes without explicit implementation approval
