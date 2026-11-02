# Wolfpack render suspension patch

This is a **Wolfpack-supported patched API**, not a public upstream ghostty-web API.

## Supported terminal surface

- `suspendRendering()` stops the presentation RAF, cursor blinking, scrollbar/scroll animations and selection autoscroll. Repeated calls are harmless, including before `open()`.
- `resumeRendering()` invalidates the retained viewport and starts one presentation loop. Reattach the host before resuming. Repeated calls and calls after disposal are harmless. Visible animation clocks restart; pending pointer drags are stopped, not replayed.
- `readonly renderingSuspended: boolean` reports presentation state.

Parsing, resize state, terminal queries/replies, and input/viewer ownership remain live. While suspended, `write(data, callback)` completes its callback after synchronous parsing via a microtask instead of waiting for a rendering frame. Output flow credit remains owned by the existing socket client. Do not use this API to suspend socket reads or withhold credit. The first resumed frame is fully invalidated; existing synchronized-output/ordered-resize presentation barriers still apply.

The controller applies suspension before a delayed `open()` and guards its direct canvas/repaint paths. Mount failure still requires the owner's normal disposal path; this patch does not promise reopening a failed/disposed terminal. Renderer helpers are implementation details, not additional stable Wolfpack APIs.

## Provenance and build

`ghostty-web-render-suspension.json` pins installed `ghostty-web@0.4.0`, the existing Bun patch digest, four exact installed distribution inputs, this unified patch, and patched JS/declaration output digests. These inputs include the existing Wolfpack fixes. `ghostty-web@0.4.0.patch` and the installed dependency/cache are not edited.

`scripts/ghostty-web-stage.ts` copies only those four files into a uniquely owned temporary stage. Declaration CRLF is normalized to LF there for portable unified hunks. It applies verified patch bytes with zero fuzz and rejects **all offsets**, verifies output digests, and removes the stage in `finally`, including on failed patch/build/consumer operations. Drift fails with an actionable error; never repair it by loosening hashes, adding fuzz, or rewriting minified private names.

`scripts/bundle-ghostty.ts` builds the single staged ESM implementation into the existing browser-global surface. It retains the MIT license/copyright and the existing compatibility/compiled-module/per-instance-WASM wrapper. There is no second minified patch. Canonical generation remains `bun run scripts/gen-assets.ts`.

When intentionally updating the dependency/base patch, review and repin inputs, regenerate exact unified hunks and output digests, and rerun the stage and real-browser suspension/renderer tests. The supported ambient declarations in `public/types-globals.d.ts` must agree with staged `dist/index.d.ts`.

## Focused checks and resource profile

- `bun test tests/unit/ghostty-web-stage.test.ts`
- `WOLFPACK_TEST=1 bun node_modules/@playwright/test/cli.js test tests/e2e/ghostty-render-suspension.e2e.ts --project=desktop --grep-invert 'resource profile'`
- `WOLFPACK_TEST=1 WOLFPACK_PERF_RENDER_RESOURCES=1 bun run scripts/terminal-load-perf.ts`

The optional profile uses raw isolated 1/4/16 terminals and the real one-slot default prewarm policy, **not** increased production grid/pool limits. `WOLFPACK_PERF_RENDER_ARTIFACT_PARENT` selects an existing private parent; each run owns a unique artifact child. `WOLFPACK_RENDER_BASELINE_BUNDLE` optionally supplies the exact saved baseline Ghostty bundle for the same workload without editing served assets.

Reports distinguish page-level CDP task duration, renderer/cursor/canvas calls, parser callbacks/replies, lifecycle counts, owned WASM linear bytes and JS heap. Linear-byte accounting excludes the loader singleton/native overhead; JS heap is not WASM or RSS. Disposal counters show released ownership, not proof of garbage collection or resident-memory release. Cached Chromium fixtures do not establish real-device or canonical older-browser pixel-golden coverage.
