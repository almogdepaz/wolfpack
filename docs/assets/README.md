# product media

current screenshots and demos were captured on 2026-09-07 from the running wolfpack v1.6.21 ui, using real broker-backed sessions. no mocked sessions, substituted terminal output, or ui restyling was used. solid muted-green bars redact machine names; session names, activity, and terminal contents are genuine.

| view | source asset | capture size |
| --- | --- | --- |
| desktop sessions | [dashboard](wolfpack-desktop-dashboard.png) | 1440 × 900 |
| mobile sessions | [sessions](wolfpack-mobile-sessions.png) | 390 × 844 |
| mobile terminal | [terminal](../mobile-ghostty.png) | 390 × 844 |
| desktop walkthrough | [demo](wolfpack-usage-demo.gif) | 1000 × 625, 18 seconds |

`docs/mobile-sessions.png` is the same mobile sessions capture. the homepage uses content-hashed png/webp versions of these views, a desktop terminal capture, and a 1440 × 900 h.264 mp4 of the same walkthrough. site filenames use the first 16 hex characters of each file's sha256; update consumers in `site/index.html` and the png allowlist in `.gitignore` when replacing them.

the walkthrough samples the real browser at 4 fps in two capture segments: expanded sessions → the existing `wolfpack-2` parent/child grid → the `338-implementation` terminal → sessions. no terminal input, takeover, session creation, or termination was performed. ordinary terminal viewing uses the app's normal attach/resize behavior.

captures use headless Chromium at desktop and mobile viewport sizes, not physical-device Safari. screenshots and decoded demo frames were visually inspected. machine names remain redacted in every published view; private originals and capture intermediates are not repository assets.

[historical visual-makeover comparisons](../design/visual-makeover/README.md) retain their original before/after evidence and are not current product media.
