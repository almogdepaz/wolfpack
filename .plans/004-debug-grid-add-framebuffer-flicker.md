# debug grid-add framebuffer flicker

## status
- target: `dev07`
- state: complete
- user authorization: autonomous reproduction, fix, verification, deployment, and live retest

## reported behavior
- adding a terminal to an existing grid flickers
- stale window pixels / green highlights appear in unrelated regions
- resizing the browser clears the corruption

## success criteria
- existing grid canvases never remain visible with stale framebuffer pixels while topology changes
- new cells remain hidden until authoritative hydration completes
- grid add/remove still causes one bounded backend resize per changed cell
- 2→3, 3→4, 4→5, and 5→6 transitions render correctly without requiring a browser resize
- single-terminal and reconnect hydration behavior remains unchanged

## evidence
- headed and headless real-pty colored fixtures did not reproduce persistent corruption under automation
- screenshots at 0/16/50/150ms show existing canvases remain visible while geometry changes
- current relayout removed the former hide/two-pass/reveal barrier in `e3e5013`
- `ghostty-web@0.4.0` has documented wasm/canvas state retention workarounds in `public/app.ts`
- a browser resize triggers another fit/repaint, matching the reported recovery
- root cause: topology mutation leaves existing canvases visible with their old framebuffer while CSS grid geometry changes; repaint is asynchronous and hardware compositing can retain stale regions until a later resize
- red regression observed: existing cells were `transitioning=false` and `visibility=visible` immediately after 2→3 add
- minimal fix: hide only existing topology-affected cells synchronously, run the existing single relayout fit, force one full repaint on the next frame, then reveal
- focused green: regression passed; desktop grid suite 18/18; related units 90/90

## plan
1. [x] inspect ghostty canvas resize/render behavior and current tests
2. [x] add a failing browser regression for topology-change visibility/repaint ordering
3. [x] implement the smallest source fix, avoiding duplicate resize ownership
4. [x] run focused unit/e2e, typecheck, asset determinism, then full suites
5. [x] commit, push, detached deploy, verify artifact identity
6. [x] rerun live colored/TUI transitions and clean fixtures

## verification
- regression red: 1 expected failure; existing canvases remained visible during 2→3 topology mutation
- regression green: 1 passed
- focused desktop grid: 18 passed
- related units: 90 passed
- full bun: 1,695 passed, 0 failed
- full rust: 174 passed, 0 failed
- full playwright: 83 passed, 103 skipped, 0 failed
- typecheck: passed
- generated assets: deterministic; bundle `74d6edd964c389d0b065caeeda23811b6a1aa771430a524bf498b78fd368f1d2`
- `git diff --check`: passed
- detached deployment: status 0; server PID 49532; broker PID 49523
- deployed/source bundle: `74d6edd964c389d0b065caeeda23811b6a1aa771430a524bf498b78fd368f1d2`
- live real-pty grid transitions: 2→3, 3→4, 4→5, and 5→6 synchronously hid every existing canvas, then revealed after fit/full repaint
- live transition settlement: 223–679 ms including new-cell hydration; no stuck transitions or console errors
- live six-cell screenshot: `/Users/home/.dev-browser/tmp/grid-relayout-live-6.png`
- temporary sessions: removed
