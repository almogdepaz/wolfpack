# Terminal scrollback / prefill truth + cleanup plan

Date: 2026-05-27
Status: corrected after branch review; no implementation started from this plan.

## Current truth

There are three different scrollback mechanisms. Mixing them up caused the bad diagnosis.

1. **live continuity**
   - the same Ghostty/xterm instance stays mounted
   - scrollback remains because nothing was destroyed
   - example: mobile drawer open/close; active grid cells while grid stays mounted

2. **cached local tail replay**
   - `flushSnapshot()` saves plaintext tail to `localStorage`
   - `initTerminal(cached)` writes that plaintext into a new terminal before attach
   - viewport prefill then clears/repaints the visible screen while preserving client scrollback
   - example: mobile fast switching in the deployed/`HEAD` behavior

3. **broker-restored scrollback**
   - server asks broker snapshot for scrollback lines
   - snapshot is rendered to ANSI and streamed into the terminal
   - example: solo full

`prefillMode: "viewport"` by itself does **not** restore broker scrollback. It requests zero broker scrollback lines.

## Why mobile fast works

Mobile fast switching works in the deployed/`HEAD` behavior because of cached local tail replay, not because mobile keeps every terminal live.

Relevant `HEAD` behavior:

- `public/app.ts`
  - has `_cachedLoaded`
  - `mount({ cached })` writes cached plaintext for any mode, including viewport
  - first viewport connect skips reset when cached text was loaded
- `src/server/websocket.ts`
  - viewport prefill passes `preserveScrollback: true`
- `src/broker/snapshot-render.ts`
  - preserve mode sends `CSI 2J` but not `CSI 3J`
  - visible screen is cleared, client scrollback is not erased

Machine switching still works because the snapshot key includes machine URL:

```text
wp-snap|<machineUrl>|<sessionName>
```

## Why desktop fast can create garbage

Cached snapshots are plaintext, not terminal state.

They are width-sensitive and state-blind:

- already wrapped for the old terminal width
- no cursor/mode/alt-screen state
- no semantic distinction between shell output, TUI output, or prose

Mobile often gets away with this because terminal width is stable: same phone, portrait, full-width container.

Desktop exposes the lie:

- sidebar collapsed/expanded/hover changes columns
- grid ↔ solo changes columns
- window size changes columns
- cached full-width text replayed into a different width becomes real scrollback with wrong wraps
- viewport prefill fixes only the visible screen; poisoned scrollback remains above it

## Dirty branch garbage to remove/revert

The dirty working tree currently contains strict-viewport changes that are now known to be the wrong direction if we want to preserve mobile fast behavior.

Garbage changes/conclusions:

- blanket-removing cached replay from viewport paths
- removing viewport `preserveScrollback`
- tests that assert viewport never seeds cached prose
- docs claiming mobile fast can only work when the controller is not destroyed

Correct replacement:

- keep cached replay as an explicit, gated policy where it is known-safe enough
- do not make it global/implicit
- never confuse cached replay with broker-restored scrollback

## Safer target model

### Solo/mobile fast

Use cached replay only when it is likely safe.

Add snapshot metadata:

```ts
{
  d: string,
  ts: number,
  cols: number,
  rows: number,
  surface: "solo" | "grid"
}
```

Replay cached tail only when:

- mode is fast/viewport
- snapshot surface is solo
- saved cols match current cols, or mobile allows a tiny tolerance if verified
- snapshot is not from alt-screen/TUI state if we can detect that later

Attach should explicitly tell the server whether client scrollback was seeded:

```json
{
  "type": "attach",
  "prefillMode": "viewport",
  "preserveClientScrollback": true
}
```

Then server uses preserve-scrollback rendering only when the client says it seeded safe local scrollback.

This avoids the current implicit server behavior where every viewport attach preserves client scrollback whether or not the client intentionally seeded it.

### Desktop solo fast

Default should be conservative:

- desktop solo avoids cached replay by always using full prefill

This prevents the wrapped/scraped garbage while keeping desktop solo history broker-restored.

### Solo full

Full remains broker-restored scrollback. Cached plaintext is not trusted history.

Decision applied first:

- solo desktop always requests full prefill; desktop fast control is disabled/ignored
- mobile keeps its existing prefill behavior
- solo full uses the generic loader instead of showing cached plaintext placeholder
- full no longer writes cached plaintext into Ghostty before broker prefill

For fewer flashes while staying fast:

1. stream full prefill into hidden Ghostty immediately
2. keep canvas hidden until:
   - prefill bytes have written
   - `prefill_done` received
   - `pty_ready` received or subscribe is established
   - short silence window passes after last write
   - force repaint has run
3. reveal once, after a forced repaint

## Next plan

### Phase 1 — cleanup

- [ ] revert/remove dirty strict-viewport changes that removed cached replay mechanics needed for mobile fast
- [ ] delete/replace tests whose expected behavior is now invalid:
  - “solo fast clears cached prose instead of using it as scrollback”
  - “grid viewport prefill does not seed cached prose” if grid policy changes, otherwise keep grid-specific no-replay test
- [ ] keep the consolidated doc; remove incorrect phase-0 probe conclusions

### Phase 2 — make cached replay explicit and gated

- [ ] store snapshot metadata: cols, rows, surface
- [ ] pass current cols to replay decision after first fit
- [ ] add `preserveClientScrollback` attach field
- [ ] server preserves client scrollback only when that field is true
- [ ] mobile fast uses cached replay when cols match
- [ ] desktop solo stays full-only, so cached replay policy is mobile-fast/grid-specific unless a desktop fast mode returns

### Phase 3 — reduce solo full flashes

- [x] disable cached placeholder for full and show generic loader until hydration
- [x] make solo desktop full-only without changing mobile setting behavior
- [x] add e2e coverage for hidden cached snapshot in desktop full and desktop saved-fast→full policy
- [ ] reproduce any remaining flash with trace enabled
- [ ] classify remaining flash source:
  - canvas revealed before full prefill writes complete
  - post-prefill resize redraw after reveal
  - stale canvas retained from previous Ghostty instance
- [ ] if reveal timing is the source, tighten hydration condition around `prefill_done`, write callbacks, `pty_ready`, silence window, and force repaint

### Phase 4 — optional broker `recent`

Only if cached replay remains too fragile or full remains too slow:

```text
fast   = current screen + safe cached local tail when eligible
recent = broker-backed limited scrollback
full   = broker-backed larger scrollback
```

## Decision points

1. Should desktop fast replay cached tail only on exact column match, or never?
2. Should mobile fast allow cached replay if cols differ by 1–2, or exact match only?
