# UX Overhaul — Mobile-First Smooth Terminal PWA

## Context

Wolfpack PWA works but feels clunky on mobile — everything is click-based with instant view swaps, tiny cards, raw log dumps. Goal: keep the terminal-first retro vibe but make it feel native on mobile with swipe gestures, smooth transitions, bigger touch targets, and visual polish. Also add bunx publishing for zero-friction install.

**Files:** `public/index.html` (all UI), `package.json` (bunx publishing), `cli.ts` (bin entry)

---

## ~~1. Swipe gesture engine~~

**File:** `public/index.html`

Build a vanilla touch gesture system (~150 lines):
- `touchstart` → record start X/Y + timestamp
- `touchmove` → track delta, apply `transform: translateX()` in real-time (follows finger)
- `touchend` → if deltaX > threshold (80px) and velocity > minimum, commit the transition. otherwise spring back with CSS transition
- Thresholds: 80px distance OR 300px/s velocity (whichever triggers first)
- Directional lock: if first 10px of movement is more vertical than horizontal, cancel swipe (user is scrolling)
- Wire into views:
  - Session card swipe left → open that session's terminal (card slides off left, terminal slides in from right)
  - Terminal view swipe right → back to sessions (terminal slides off right, sessions slide in from left)
  - Ralph card swipe left → open ralph detail
- Only active on mobile (`ontouchstart in window`)
- Desktop keeps click behavior unchanged

## ~~2. View slide transitions~~

**File:** `public/index.html`

Replace instant `display: none/flex` class toggles with CSS transform-based slides:
- Views positioned with `transform: translateX(100%)` (offscreen right) or `translateX(-100%)` (offscreen left)
- Active view at `translateX(0)`
- `transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)` (iOS-like ease)
- `showView()` sets direction based on navigation hierarchy:
  - Forward (sessions→terminal, ralph→detail): current slides left, new slides in from right
  - Back (terminal→sessions, detail→ralph): current slides right, new slides in from left
- Maintain a simple view stack for back navigation
- On desktop: keep instant transitions (no slide), or use a subtle 150ms fade

## ~~3. Bigger mobile cards + two-line preview~~

**File:** `public/index.html`

Rework `.card` for mobile:
- Padding: 6px → 14px
- Dot: 7px → 10px
- Name font: 13px → 15px, slightly bolder
- Preview: show last 2 lines instead of 1, line-height bump
- Add thin colored left border (like ralph cards) — green for active, gray for idle, yellow for attention
- Card min-height: ~64px (comfortable touch target)
- Subtle hover/active state: background shift + scale(0.98) on press
- Desktop: keep current compact size via `@media (min-width: 769px)` override
- Add swipe affordance: subtle right-arrow chevron on right edge of card (fades in on touch)

## ~~4. Ralph log as expandable iteration cards~~

**File:** `public/index.html`

Replace raw `.ralph-log` textarea dump with structured iteration cards:
- Parse ralph log into iterations (split on `=== 🥋 Wax On N/M ===` markers)
- Each iteration renders as a collapsible card:
  - Header: "Iteration 3/5" + status dot + duration
  - Collapsed: single-line summary (task name being worked on)
  - Expanded: full log output for that iteration, monospace, scrollable
- Most recent iteration expanded by default, others collapsed
- Tap to toggle expand/collapse with smooth height transition
- Summary section at top: progress bar + stats (same as current, just styled better)
- Keep "view raw log" link at bottom for full dump if needed

## ~~5. Retro visual polish~~

**File:** `public/index.html`

Enhance the terminal-retro aesthetic:
- **Phosphor glow:** `text-shadow: 0 0 8px rgba(0,255,65,0.3)` on #00ff41 elements (header title, card names, active indicators). Subtle — not distracting.
- **Scanline overlay (optional):** CSS pseudo-element on body, repeating-linear-gradient with 1px semi-transparent dark lines every 3px. Toggle in settings, off by default.
- **Typewriter effect on view titles:** when `showView()` changes the header title, animate it character-by-character over 200ms. Skip on back navigation (instant).
- **Card entrance animation:** cards stagger-fade-in when list loads (each card delays 30ms * index). CSS `@keyframes fadeSlideUp` from `opacity:0; translateY(8px)` to final position.
- **Terminal cursor blink:** CSS animation on a pseudo-element in the header or loading states. Pure aesthetic.
- **Status dot glow:** active dots get a subtle pulsing box-shadow (already have `.pulse` for yellow, extend to green/purple).

## ~~6. Haptic feedback on gestures~~

**File:** `public/index.html`

Use the Vibration API (already wired for notifications):
- Swipe commit: `navigator.vibrate(10)` — short tick
- Card press: `navigator.vibrate(5)` — micro tap
- Back gesture: `navigator.vibrate([5, 30, 5])` — double tick
- Cancel/error actions: `navigator.vibrate(20)` — slightly longer
- Guard: `if (navigator.vibrate)` — no-op on desktop/unsupported
- Respect a settings toggle (haptics on/off, default on)

## ~~7. Settings toggles for effects~~

**File:** `public/index.html`

Add to existing settings panel:
- "Scanlines" toggle (default: off)
- "Haptic feedback" toggle (default: on)
- "Animations" toggle (default: on) — master switch, disables all transitions/effects for accessibility
- Persist to localStorage (existing pattern: `bridge-settings`)
- When animations off: `* { transition: none !important; animation: none !important; }` override
- When scanlines on: add `.scanlines` class to body

## ~~8. bunx publishing setup~~

**Files:** `package.json`, `cli.ts`, `scripts/build.ts`

Make wolfpack installable via `bunx wolfpack`:
- Add `"bin": { "wolfpack": "./dist/wolfpack" }` to package.json
- Add `"name": "wolfpack"` (or scoped `"@wolfpack/cli"` if name taken)
- Add `"files": ["dist/"]` to include only the compiled binary
- Build step already produces platform binaries in `dist/`
- Add `"postinstall"` script that copies the right platform binary
- Or: publish as a simple JS wrapper that downloads the right binary on first run (like esbuild/turbo pattern)
- Test: `bunx ./` locally before publishing
- npm publish workflow: manual for now, can add to CI later
