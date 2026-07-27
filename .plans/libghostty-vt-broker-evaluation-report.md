# libghostty-vt broker evaluation report

status: recommendation ready; implementation not started
date: 2026-07-26
Ghostty revision: `7aa9591746ffa4d2eee458960c76554352832595`
Wolfpack comparison revision: `592d2bd6a308023524103129293d7083ad2b4086` (PR #227)

## recommendation

proceed with a staged replacement of Wolfpack's custom `TerminalState` implementation by `libghostty-vt`, but do not cut over in one change.

Ghostty materially improves correctness, feed throughput, and memory use. Its C ABI is sufficient for the existing cell snapshot contract, and the broker can retain PTY ownership, sequence ordering, replay rings, fanout, and protocol behavior in Rust.

use two delivery stages:

1. make Ghostty the canonical broker terminal model while preserving the existing structured snapshot protocol
2. add a compact Ghostty-generated VT checkpoint method after resolving the formatter cursor-order gap described below

## current replacement seam

only the emulator implementation needs replacement:

- `TerminalState::new(cols, rows)`
- `TerminalState::feed(bytes)`
- `TerminalState::resize(cols, rows)`
- state accessors and `snapshot_with_reflow(...)`

these remain unchanged around it:

- Rust PTY ownership and process lifecycle
- the terminal mutex
- feed-before-sequence-bump ordering
- output ring and fanout
- snapshot sequence watermark
- subscription replay
- WebSocket attach ordering

## public C API coverage

Ghostty's current C API provides:

- terminal creation, destruction, reset, byte feed, and resize/reflow
- primary/alternate screen identity
- active and history coordinate traversal
- row wrapping metadata
- full grapheme clusters
- wide-cell lead/tail markers
- foreground/background colors and style flags
- cursor coordinates, visibility, and visual shape
- title and scrollback size
- all Wolfpack wire modes through `ghostty_terminal_mode_get`
- plain, HTML, and VT formatters
- selection ranges suitable for limiting formatted history
- caller-serialized access compatible with Wolfpack's existing mutex

known API limitation: the public terminal getter does not expose scrolling-region coordinates. The VT formatter can emit them, but the structured cell projection cannot read them directly.

## behavioral comparison

throwaway Rust/C code linked the pinned static archive and replayed both engines from identical byte streams.

exact matches across visible cells, attributes, cursor, modes, title, and scrollback:

- plain shell output
- carriage-return redraws
- ANSI color and style
- alternate-screen partial redraw
- ICH/DCH/ECH edit operations from PR #227
- wide glyphs and combining graphemes
- application/origin/wrap/mouse/paste/insert modes
- ordinary scrollback

expected divergences where Ghostty is more complete:

- DEC special-graphics charset: current emits `lqk`; Ghostty emits `┌─┐`
- custom tab stops: current ignores TBC/HTS; Ghostty preserves them
- cursor shape: current always reports block; Ghostty reports DECSCUSR bar/underline/block state
- resize/reflow: current reflows its visible grid and existing history separately; Ghostty reflows the page list as one terminal model, changing the history/viewport split in the tested narrow resize

## structured snapshot limitation already present in Wolfpack

Wolfpack serializes `scroll_region`, but `src/broker/snapshot-render.ts` never restores it. It restores origin mode before applying an absolute CUP cursor position, which is not generally correct when a non-default scrolling region is active.

other terminal state absent from the current protocol includes custom tab stops, charset invocation, palette overrides, hyperlinks, keyboard modes, and accurate cursor shape.

switching only the emulator improves state correctness, but the current projection still discards these fields.

## compact VT checkpoint finding

Ghostty's VT formatter can serialize terminal contents plus palette, modes, scrolling regions, tab stops, keyboard state, charsets, cursor SGR, and hyperlinks. A fresh Ghostty terminal reproduced the primary-screen comparison state exactly from the generated checkpoint.

however, the pinned formatter emits screen cursor position before terminal extras. Scrolling-region and tab-stop sequences emitted afterward can move the cursor. An alternate-screen roundtrip ended at column 8 instead of column 7 for this reason. The formatter also does not emit the DECSCUSR visual cursor shape.

therefore a compact VT checkpoint is promising but not ready to treat as byte-exact without one of:

- an upstream formatter fix that emits final cursor position/shape last
- a public scrolling-region getter plus a small Wolfpack-owned final-state suffix
- a narrowly reviewed pinned Ghostty patch

do not parse the formatter's human-readable VT output to recover margins.

## performance measurements

measurements are release builds on macOS arm64. They are directional, not production SLOs.

representative snapshot: 126 columns, 34 rows, 530 styled output lines.

| operation | current | Ghostty | change |
| --- | ---: | ---: | ---: |
| structured snapshot JSON | 10,716,512 B | 10,716,512 B | schema dominates both |
| Ghostty VT checkpoint | — | 61,822 B | 173x smaller than structured JSON |
| current snapshot + JSON | 14.20 ms | — | baseline |
| Ghostty cell projection + JSON | — | 22.50 ms | naive per-cell FFI is slower |
| Ghostty VT formatter | — | 1.65 ms | 8.6x faster than current snapshot + JSON |
| feed throughput over 5.19 MB | 8.5 MB/s | 86.9 MB/s | 10.2x faster |

naive Ghostty cell projection performs multiple C calls per cell. A production structured adapter should expose a row/batch shim rather than repeat that implementation.

rough process-RSS deltas:

| retained history | sessions | current/session | Ghostty/session |
| --- | ---: | ---: | ---: |
| ~500 lines | 20 | ~5.07 MiB | ~0.67 MiB |
| ~5,000 lines | 5 | ~45.47 MiB | ~1.03 MiB |

RSS attribution is approximate, but the order-of-magnitude gap is credible: the current model allocates a Rust `String` and attributes per cell, while Ghostty uses compact page storage.

## build and packaging

verified:

- Zig 0.16.0 builds the pinned static library with SIMD disabled
- macOS arm64 static linking works from ordinary C and Rust
- Linux x86_64 and arm64 archives cross-compile successfully from macOS
- both Linux archives link into target-specific ELF executables
- the Rust executable has no runtime Ghostty dylib dependency when the archive is isolated in an archive-only search directory

pinned source artifact:

- URL: `https://tip.files.ghostty.org/7aa9591746ffa4d2eee458960c76554352832595/libghostty-vt-source.tar.gz`
- SHA-256: `468a0564bdd481e291f6150b94300f9ff37c1a7524f6ae76e99c4ec15535cf66`
- compressed size: 3.2 MiB
- extracted size: 18 MiB

build cost with SIMD disabled:

- cold native macOS build: 47.52 s, approximately 1.0 GB maximum RSS
- warm cached build: 0.70 s
- cold Linux x86_64 cross-build from macOS: 67.41 s
- Linux arm64 after shared caches: 28.70 s
- static archive: 8.0 MiB on macOS arm64; linked minimal Rust spike: 1.7 MiB

Wolfpack's release pipeline currently uses Cargo directly for macOS and `cross` containers for Linux. implementation must prebuild a target archive into a project-mounted path before Cargo runs. end users receive a statically linked broker and do not need Zig.

Rust/Cargo selected the colocated dylib despite `rustc-link-lib=static=ghostty-vt` on Darwin. copying only `libghostty-vt.a` into the Cargo link-search directory fixed it. production packaging should use an archive-only target directory or an explicit archive link argument.

## licensing and stability

- Ghostty is MIT licensed.
- its required Unicode/uucode dependency is permissively licensed but its notices must be included in source/release attribution.
- `include/ghostty/vt.h` explicitly says the API is incomplete, unstable, and expected to change.
- CMake reports library version `0.1.0`.

mitigations:

- pin an immutable Ghostty commit and source hash
- own a very small C shim and safe Rust wrapper
- never expose Ghostty C structs outside that wrapper
- upgrade only through fixture, ABI, cross-build, and browser-replay gates

## safety and operational concerns

- one terminal is not thread-safe; Wolfpack's existing mutex provides the required serialization
- a safe Rust wrapper will need a reviewed `Send` decision for the opaque terminal handle
- a Zig panic or C-ABI misuse can abort the broker process; wrapper invariants and malformed-stream tests are mandatory
- leave Ghostty's PTY-response callback disabled initially to avoid changing query-response ownership or duplicating browser responses
- disable Kitty graphics/file/shared-memory media initially; the snapshot contract does not transport images and broker-side file media would add unnecessary attack surface
- retain Ghostty's VT-processing-error flag as an observable diagnostic

## proposed migration

### stage 1: integration boundary

- add a minimal `ghostty-vt-sys`/C shim boundary
- download and verify the immutable 3.2 MiB source archive into a build cache
- prebuild one static archive per release target
- wrap terminal ownership in a safe Rust type
- add batched row extraction, not per-cell FFI

### stage 2: shadow model

- feed and resize both current and Ghostty models
- keep the current model authoritative
- compare bounded digests/field counters, never log terminal contents
- classify expected charset/tab/cursor/reflow differences
- run recorded fixtures, randomized chunk boundaries, malformed streams, resize sequences, and browser hydration E2E

### stage 3: Ghostty structured cutover

- make Ghostty authoritative behind the existing `TerminalState` Rust interface
- preserve the current `snapshot` RPC and TypeScript renderer
- keep a runtime/build rollback switch through one release
- measure broker RSS, snapshot latency, attach latency, and VT-processing errors

### stage 4: compact checkpoint protocol

- resolve the upstream formatter final-cursor issue
- add an additive `snapshot_vt` broker method rather than bloating the old JSON payload
- return sequence watermark, dimensions, encoding, and compact VT bytes
- let the TS broker client fall back to structured snapshots on `unknown_method`
- feed checkpoint bytes directly to Ghostty-web, then subscribe from the checkpoint sequence
- retain structured snapshots for old clients and copy/plain-text paths until compatibility expiry

### stage 5: removal

remove the custom Rust emulator only after:

- one release of shadow evidence
- cross-platform release builds
- fixture and browser hydration parity
- compact-checkpoint rollout or acceptable structured-snapshot performance
- tested rollback binary

## verdict

`libghostty-vt` is a better long-term source of terminal truth than Wolfpack's custom emulator. the strongest immediate wins are correctness, roughly 10x feed throughput, and dramatically lower retained-state memory. the strongest follow-up win is a compact VT checkpoint, potentially reducing a representative 10.7 MB snapshot to about 62 KB.

the only hard caution is integration maturity: the public API is explicitly unstable, and its current formatter does not compose all extras into an exact final cursor state. neither issue justifies continuing to own a terminal emulator indefinitely; both justify a pinned, isolated, staged adoption.
