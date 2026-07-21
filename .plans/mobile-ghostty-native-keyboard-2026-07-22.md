# mobile ghostty native keyboard — 2026-07-22

status: rollback deployed; corrected native-input candidate verified locally
branch: fix/mobile-keyboard-grid-polish
pr: #196
rollback/deployed baseline: 921e46e

## goal

replace wolfpack's custom mobile keyboard proxy with ghostty-web's native textarea/input handler while preserving explicit keyboard open/close control, accessory keys, terminal scrolling, viewport positioning, and session swipe behavior.

## acceptance criteria

- mobile terminal uses ghostty-web `onData`; no `#mobile-kb-proxy` or autocomplete-fragment inference remains.
- keyboard starts closed: native textarea is blurred, read-only, `inputmode=none`, and stdin disabled.
- keyboard button opens native textarea input and enables stdin; pressing it again closes input.
- visual viewport collapse synchronizes the closed state.
- an intentional terminal drag over 10px closes an open keyboard exactly once, then existing scroll/swipe handling continues.
- native composition commits once; native backspace sends DEL through ghostty-web.
- desktop input behavior and terminal attach/hydration timing are unchanged.
- deploy uses `--broker=no`.

## plan/status

- [x] inspect current proxy, ghostty-web v0.4.0 textarea API, touch handling, and history
- [x] add failing e2e coverage for native textarea ownership and keyboard gating
- [x] add failing touch-handler coverage for drag dismissal
- [x] remove custom proxy and wire native textarea open/close
- [x] regenerate embedded assets
- [x] run focused unit/e2e and typecheck
- [x] run full test suites for corrected candidate
- [ ] amend/push corrected pr #196
- [ ] deploy corrected candidate server-only after android validation

## constraints

- autocorrect remains disabled by ghostty-web; do not infer correction semantics from event fragments.
- do not alter websocket attach, hydration, reveal, or broker behavior.
- playwright cannot reproduce a real gboard ime; final android behavior needs manual verification after deterministic browser tests pass.

## evidence

- destructive retained-buffer experiment `33a3f28` was rolled back from local deployment and pr to `921e46e`.
- ghostty-web v0.4.0 exposes `term.textarea`, handles keydown/composition, and sets autocorrect/autocapitalize/spellcheck off, but its published bundle does not connect textarea `beforeinput` to `onData`.
- native ownership red: expected no `#mobile-kb-proxy`, received one.
- drag dismissal red: native textarea was not focused because the proxy still owned input.
- post-drag refocus red: Ghostty canvas `touchend` refocused the textarea after movement dismissal.
- viewport authority red: a synthetic viewport height change set keyboard state open without enabling native stdin.
- focused mobile e2e: 11 passed / 19 skipped across accessory, scrolling, and session-switch suites.
- final full bun suite: 1827 passed / 0 failed.
- final full playwright suite: 102 passed / 123 skipped.
- known unrelated flake: `desktop sidebar hover does not put live terminal into loading state` failed 1/5 repeated runs, then passed in the final full suite; untouched by this mobile input diff.
- deployed with `./scripts/deploy-local.sh --broker=no`: server 82661 → 31189; broker pid 34586 preserved; 3 sessions preserved.
- live `/api/info` returned version 1.6.7; `/api/backend` returned broker available with count 3.
- failed candidate was rolled back to exact `921e46e`: server 31189 → 51568; broker pid 34586 and all 3 sessions preserved; served rollback bundle sha256 `26e70830815a4f9def244f45f6f98d426a76ac6086fe84d38b023ab7f179830c`.
- android evidence: gboard showed autocomplete while terminal received no input; accessory keys still worked because they bypass Ghostty input handling.
- confirmed input root cause: npm ghostty-web 0.4.0 listens for parent keydown/composition but not textarea `beforeinput`; red expected `["a"]`, received `[]`.
- confirmed layout root cause: Ghostty autofocus during the entering view transition scrolled overflow-hidden `#view-container`; red expected `{ viewScrollLeft: 0, terminalLeft: 0 }`, received `{ viewScrollLeft: 196, terminalLeft: -196 }`.
- corrected candidate backports textarea `beforeinput` with keydown/composition duplicate suppression and uses `focus({ preventScroll: true })` inside a Bun dependency patch.
- both exact reds pass; focused viewport/native-input/drag suite passes 4/4.
- headless mobile screenshot confirms a full-width terminal with `viewScrollLeft: 0` and `terminalLeft: 0`.
- corrected candidate clean install reapplies the dependency patch; full bun suite passes 1827/1827 and full Playwright passes 104 with 124 expected skips.
