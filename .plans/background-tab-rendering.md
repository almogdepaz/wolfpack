# background tab terminal rendering

status: root cause chain isolated; implementation decision required
branch: `fix/background-tab-rendering`

## goal

Reproduce and fix terminal row/cell corruption after a hard-reloaded browser tab remains backgrounded while terminal output arrives.

## existing evidence

See `.plans/terminal-canvas-corruption.md` for prior screenshot analysis, truecolor correction, Ghostty #139/#177 findings, and the earlier no-output CDP freeze control. Do not duplicate or modify that record.

New evidence: `/Users/home/Documents/Screenshot 2026-07-28 at 14.48.45.png` was captured after a hard reload against deployed #236. It shows merged/misaligned terminal rows after background-tab use, so ordinary append-only coverage from #236 is insufficient.

## success criteria

- reproduce the corruption or identify the smallest lifecycle condition that distinguishes it.
- compare WASM viewport state with canvas output at the first divergence.
- test background output with and without a resize while rendering is suspended.
- add a regression that fails before the production fix.
- fix the source layer only; verify the screenshot-class corruption no longer occurs.

## boundaries

- no app-level resize, delay, or periodic repaint workaround.
- no broker, prefill, or grid-contract changes without boundary evidence.
- evaluate upstream Ghostty #132 (`fc99955`) if resize is required for reproduction.
- if WASM rows remain coherent but the canvas is stale, renderer invalidation on structured page visibility restoration is acceptable only after the regression proves that boundary.
- leave `.plans/terminal-canvas-corruption.md` and `.plans/open-issues-gap-audit.md` untouched.

## findings

- A hard-reloaded browser uses an isolated Ghostty WASM instance; shared-singleton traps are not representative of Wolfpack.
- RAF suspension and append-only output remain coherent. The first resumed incremental content frame matches a forced full frame; differences are confined to Ghostty's right-edge scrollbar.
- One isolated terminal deterministically traps when its browser dimensions alternate between 130x39 and 101x31 while old-width, high-cardinality truecolor TUI frames continue arriving. Plain output, a reused fixed style, and dimension-matched frames pass.
- The first failing symbol in an unstripped ReleaseSmall WASM build is `terminal.bitmap_allocator.BitmapAllocator(16).free`, called by `Page.clearGrapheme` from `Terminal.print`. WASM state is corrupt before canvas paint; repaint or visibility invalidation cannot fix it.
- Ghostty-Web #132 (`fc99955`) does not fix this sequence. Targeted Ghostty core fixes #9866, #10337, #10383, and a backported #13294 page-map implementation also do not fix it.
- ReleaseSafe survives the synthetic sequence but increases the browser bundle from about 628 KB to 3.4 MB. This is an emergency build-mode mitigation, not an accepted source fix.
- Incident linkage is not yet proven because the synthetic failure requires many distinct RGB styles while Pi normally reuses a smaller theme palette.
- Production broker PID 53897 is an older `ghostty-vt-shadow` build. It is currently using about 35% CPU, flooding `ghostty-vt shadow mismatch` warnings, and timing out resize/list RPCs. Current main removed shadow mode and uses libghostty-vt authoritatively, but replacing this broker would violate active-session preservation.
- Broker resize delays create the exact stale-dimension window used by the deterministic browser failure: the browser resizes immediately while the PTY can continue emitting old-width frames.

## implementation decision

The principled application-layer fix is resize acknowledgement: keep the browser terminal at its old dimensions until the broker confirms the PTY resize, then apply the local Ghostty resize. This requires a typed `/ws/pty` resize request/ack contract and ordered handling for solo and grid terminals. The alternative is an upstream Ghostty core fix; repaint hooks and delays are rejected.

## progress

- [x] test frozen output without resize.
- [x] test frozen output with resize.
- [x] locate deterministic failure before canvas paint.
- [x] reject #132 and renderer invalidation as fixes for the isolated failure.
- [ ] capture/replay representative Pi ANSI output after broker responsiveness is restored.
- [ ] choose resize acknowledgement or upstream-core remediation.
- [ ] add the selected failing regression.
- [ ] implement minimal source fix.
- [ ] verify targeted and full suites.
