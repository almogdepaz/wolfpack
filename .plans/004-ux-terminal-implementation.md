# ux/ui and terminal optimization implementation

## goal

Implement the remaining actionable findings from `.plans/003-current-ux-terminal-review.md` while preserving broker authority, terminal attach/replay correctness, truthful source-backed status, and the current visual identity.

## success criteria

- cli output honors tty/color policy, `NO_COLOR`, stderr/stdout separation, and stable JSON success/failure envelopes
- primary browser workflows no longer depend on native blocking dialogs and preserve user context on failure
- offline machines do not consume primary dashboard space or expose invalid session-creation actions
- project search and project creation are distinct interactions, and mobile settings prioritize frequent controls
- dashboard refresh no longer materializes a terminal snapshot for every live session merely to infer generic activity
- critical mobile terminal flows execute in Chromium and WebKit
- terminal prewarm changes, if any, are justified by measured memory and cold-open latency
- terminal corruption remediation follows the existing source investigation and introduces no repaint/timing workaround
- each behavior change begins with a failing regression and passes focused plus full verification

## 1. Enforce deterministic CLI output contracts

Add stream-level regressions for interactive and non-interactive output, `NO_COLOR`, `TERM=dumb`, human diagnostics, JSON success/failure, and version output. Introduce one shared output policy used by list, kill, top-level dispatch, and related CLI paths rather than command-specific escape stripping. Human diagnostics must use stderr with nonzero exits; every `--json` result must write exactly one stable JSON envelope to stdout. Add a side-effect-free `--version` command and update help/documentation contracts.

## 2. Repair browser workflow and information architecture

Add browser regressions before changing behavior. Replace native `prompt`, `alert`, and `confirm` in primary workflows with a small accessible dialog/form primitive that traps focus, restores focus, and preserves entered data after failure. Make offline machine presentation compact, retain stable machine ordering, expose structured failure categories and retry, and disable invalid creation actions. Separate existing-project search from new-project creation so Enter in search cannot create a directory; add recent/ranked bounded results. Add mobile settings section navigation and progressive disclosure while preserving back/deep-link context and existing terminal/session semantics.

## 3. Remove snapshot-driven dashboard polling

Use the broker’s structured output sequence as the generic activity source instead of parsing or repeatedly snapshotting terminal text. Add the smallest compatible typed field through the broker protocol, TypeScript broker boundary, server session facts, public API projection, and tests. Compare sequence values to present only truthful generic `output`/`quiet` activity. Make terminal preview explicit/on-demand and reserve authoritative snapshots for attach, transcript/read, or explicit preview. Preserve snapshot sequence invariants, bounded recovery, reconnect behavior, identity redaction, and compatibility with broker/server rolling upgrades.

## 4. Strengthen browser compatibility, PWA ergonomics, and measured performance

Add a focused WebKit project for mobile navigation, `beforeinput`, paste, visual viewport, background/resume, reconnect, transcript, and back navigation; keep the full suite Chromium-first. Measure zero/one/two Ghostty prewarms across mobile solo, desktop solo, and grid scenarios, recording memory, FCP, cold/warm reveal p50/p95, hit rate, and long tasks before selecting a policy. Add maskable install assets and typed session-aware notification routing without claiming offline terminal capability. Keep the disconnected shell explicit and recoverable.

## 5. Resolve terminal corruption at the proven source boundary

Treat `.plans/background-tab-rendering.md` and `.plans/terminal-canvas-corruption.md` as the detailed source of truth. First capture and replay representative Pi ANSI output after broker responsiveness is restored. Then choose either typed resize request/ack ordering or a proven upstream Ghostty remediation based on the reproduced boundary. Add a failing screenshot/state regression before production changes. Verify solo/grid attach, resize, background output, reconnect, and ordered input/output. Only after the regression passes may legacy focus/pageshow/periodic repaint recovery be removed.

## sequencing

Tasks execute in numeric order unless a task is explicitly blocked. Each task is independently reviewed and verified before the next begins. Task 5 remains blocked until its existing trace and remediation-decision gates are satisfied; no other task may smuggle in resize, repaint, delay, or terminal-protocol work.

## non-goals

- no UI framework or icon-library migration
- no visual identity redesign
- no browser ownership of PTY, snapshot, history, or session authority
- no semantic state inferred from terminal prose, logs, or error-message regex
- no repaint, resize, reconnect, or arbitrary-delay workaround for terminal corruption
- no speculative prewarm reduction without measurements
- no unrelated refactor; module extraction is allowed only when directly required by the task being implemented
- no modification of this plan after implementation starts; progress belongs only in the companion status ledger
