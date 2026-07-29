# ux/ui and terminal optimizations

## Goal

Implement the actionable UX, accessibility, delivery-performance, operator-workflow, terminal-accessibility, and CLI improvements identified in `.plans/ux-ui-terminal-audit.md` while preserving broker authority and terminal correctness boundaries.

## Success criteria

- inactive browser views cannot receive focus and all primary cards/actions are keyboard-operable
- connection/loading/failure state is exposed to assistive technology without announcing terminal output continuously
- browser zoom is not suppressed and larger terminal font choices remain usable on mobile
- critical static assets use negotiated compression and validators/versioned caching, and the session shell can paint without parser-blocking Ghostty
- browser session refresh has one visibility-aware, non-overlapping coordinator and machine metadata failure does not hide valid sessions
- typed runtime attention state is visible and acknowledged through the existing typed API
- project search and creation are explicit, distinct actions
- blocking browser dialogs are removed from primary workflows and failures preserve context
- CLI color, stderr/stdout, and JSON contracts are deterministic; version and interactive discovery improve ergonomics
- critical mobile flows run in Chromium and WebKit, with regression coverage for focus isolation and relevant performance contracts
- existing UI-polish changes remain intact and verified

## 1. Accessibility and focus foundation

Add failing browser contracts for inactive-view focus isolation, keyboard-operable session/project cards, destination/restored focus, status announcements, browser zoom, and larger terminal font options. Implement the smallest semantic/focus changes that satisfy those contracts. Add an accessible bounded transcript only if it can source existing authoritative terminal output without duplicating terminal parsing.

## 2. Delivery and refresh performance

Add failing server/browser contracts for negotiated static compression, cache validation/versioning, non-parser-blocking shell paint, a single non-overlapping refresh coordinator, and independent machine info/session degradation. Implement with existing runtime/build primitives and preserve terminal cold-open behavior. Measure prewarm memory/open-latency before changing pool policy; do not guess.

## 3. Operator workflow and failure recovery

Add failing contracts for typed unseen/attention state and acknowledgement, explicit project search versus creation, preserved creation context on error, structured machine failure presentation, and reduced mobile settings traversal. Reuse typed runtime state and structured errors only; never infer task or machine semantics from prose.

## 4. CLI output and discovery

Add failing stream-level tests for TTY/non-TTY color, `NO_COLOR`, stderr/stdout separation, JSON success/error envelopes, and typed human session status. Add side-effect-free version output, shell completion generation, concise startup controls, and an interactive attach selector only for TTY use while preserving explicit scripted behavior.

## 5. Compatibility and verification

Add explicit WebKit coverage for critical mobile navigation/input/background flows plus focused accessibility and constrained-network performance gates. Run typecheck, unit/integration suites, focused Chromium/WebKit e2e, and the full suite. Record environment-limited physical-device and assistive-technology checks without claiming they passed.

## Non-goals

- no app-level resize, repaint, or timing workaround for terminal corruption
- no implementation of `.plans/background-tab-rendering.md` before its representative-trace and remediation-decision gates are satisfied
- no browser ownership of broker/session authority
- no semantic parsing of terminal prose, error strings, or logs
- no UI framework, icon package, or runtime dependency rewrite
- no speculative prewarm reduction without memory and terminal-open evidence
- no unrelated refactor or cleanup
