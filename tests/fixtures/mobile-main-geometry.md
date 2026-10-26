# main mobile geometry baseline

source: local `main`, `909d5150c4d004135751da375b880d814543ba69`.

`mobile-main-geometry-{375,390,390-safe34}.json` contains DOM rects captured by
`tests/e2e/keyboard-viewport.e2e.ts` on that exact source, with regenerated embedded
assets, using `WOLFPACK_GEOMETRY_CAPTURE=1` and the `iphone-14` Chromium project.
The identical spec runs on redesign; do not regenerate baselines from redesign.

The existing `wp-effects` animations=false preference removes entry-swipe/focus
scroll timing from the comparison. visualViewport height/offsetTop are overridden
and real resize/scroll events dispatched; body/html/frame rects are not overridden.
`panned` models visualViewport offsetTop=40, not actual window scrolling.

375: viewport 375×667, exposed height400. 390: viewport390×844, exposed height500.
`safe34` substitutes only the existing terminal-view env(safe-area-inset-bottom)
consumer with34px. Both main and redesign retain that padding; native Chromium
reports0px and the accessory meets the visualViewport bottom exactly. Main has no
mobile-tab-bar; redesign's retained navigation must be display:none/zero rect in
terminal view. Physical Android/Gboard/iOS/WebKit coverage is not implied.
