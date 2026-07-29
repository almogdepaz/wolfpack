# terminal canvas corruption investigation

status: root cause identified; remediation blocked on an upstream unreleased WASM fix

## observed symptom

After leaving a browser terminal session for an unknown interval, terminal background paint is corrupted while text remains coherent. A manual browser resize restores correct rendering.

## investigation gates

1. reproduce or isolate the lifecycle transition with browser/CDP evidence.
2. determine whether a direct full repaint restores the canvas without a resize.
3. trace the first divergent renderer/layout state; do not ship a workaround before the root cause is confirmed.

## evidence

- Chrome CDP freeze → 2s pause → active against a real Ghostty terminal did not reproduce corruption: the only changed canvas pixels were the blinking cursor (120 pixels, bounds 168–175 × 15–29).
- `forceRepaint()` calls Ghostty's documented internal full-render path (`renderer.render(wasmTerm, true, viewportY, terminal)`), which clears and redraws every terminal row. A browser resize also reallocates the canvas backing store before taking that same full-render path.
- Therefore the reproduction does not support attributing this to ordinary page freeze alone; the remaining distinction is whether the incident is a renderer/compositor backing-store failure that requires canvas reallocation, or whether terminal state is already wrong before paint.
- Read-only broker snapshot of `looper-ai` (188×57) found the screenshot's exact `Took 0.2s` row in retained scrollback. Every padding cell deliberately has `bg: 24320` (`#005f00`), not the default background. Ghostty's `renderCellBackground` maps that state to `rgb(0,95,0)` and fills each cell, so the green panel is source terminal styling rather than a canvas-invented rectangle.
- An additional browser test wrote that exact RGB full-width row into Ghostty, froze Chrome through CDP for two seconds, resumed it, and compared the canvas pixel buffer. Zero pixels changed. The prior generic lifecycle test changed only the cursor (120 pixels).

## conclusion

The screenshot's green panels originate upstream of the browser canvas, but they are still visually wrong for this browser terminal: `BrokerBackend` creates Pi sessions with `TERM=xterm-256color` and no `COLORTERM=truecolor`. Pi therefore selects its 256-colour mode. Its declared dark-theme tool-success colour, `#283228`, is emitted as `CSI 48;5;22m`; xterm palette index 22 is vivid `#005f00`, exactly the `bg: 24320` found in the broker snapshot and shown in the screenshot. Ghostty-web supports truecolour, so the session advertises an unnecessarily weak capability and Pi's muted tool panels are quantized to saturated green.

Verified directly against the installed Pi 0.80.6 theme with the session's environment: `TERM=xterm-256color COLORTERM=''` produces `\x1b[48;5;22m` for `toolSuccessBg`. This explains the screenshot's source state; it is not a canvas backing-store defect. The reported resize-dependent behaviour remains unproven and cannot be caused by terminal capability negotiation, which is fixed when the session is spawned. Do not ship a repaint workaround; the corrective path, if requested, is to declare `COLORTERM=truecolor` for browser-backed broker sessions and cover the emitted Pi colour mode.

## later investigation: terminal state corruption

The browser corruption report is separately explained by an installed `ghostty-web` 0.4.0 WASM defect, not page sleep or canvas compositing. Upstream issue [#139](https://github.com/coder/ghostty-web/issues/139) describes coherent-looking state changing into merged/misplaced terminal rows when the visible viewport crosses Ghostty internal page boundaries. Its root causes are: (1) resolving every WASM viewport row independently rather than through Ghostty's coherent `RenderState` cache, and (2) treating the JavaScript `scrollback` *line* count as a byte budget.

I reproduced the second root cause against Wolfpack's installed, patched 0.4.0 bundle in Chromium using the upstream 130×39 ANSI-heavy workload. Configured `scrollback: 10000` grew to 641 rows then dropped to 345 after the eleventh batch (then 413/481/549), despite append-only output and far fewer than 10,000 rows. The current visible rows happened to remain coherent in that run; this proves the corrupting state transition but not the exact screen artifact. The upstream fix [#177](https://github.com/coder/ghostty-web/pull/177) repairs both causes and has a regression test for this pattern, but it is open and unavailable as an npm release. `0.5.0-rc.0` is a GitHub release only; npm still publishes 0.4.0 as latest.

A separate unmerged upstream PR [#166](https://github.com/coder/ghostty-web/pull/166) tracks runtime DPR changes. It could account for zoom/monitor-scale issues, but it cannot explain a resize consistently repairing terminal content because the 0.4.0 renderer retains its original DPR even across terminal `resize()` calls. Do not conflate this with #139 or ship a DPR/repaint workaround.
