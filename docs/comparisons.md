# Wolfpack comparisons

Reviewed: 2026-07-11
Owner: Wolfpack maintainers
Cadence: review every release that changes installation, remote access, PTY ownership, Ralph, or the README positioning; otherwise review quarterly.

This page explains where Wolfpack fits against adjacent tools. It is not a benchmark page and it should not make claims that depend on private product roadmaps, unreleased features, or competitor marketing copy.

## Scope

Initial comparison set:

- `tmux`
- `zellij`
- Warp
- browser SSH clients
- terminal-native agent multiplexers

The matrix separates durable product-shape facts from opinionated positioning. If a claim depends on a specific competitor version, either cite a stable public source in the row note or remove the claim.

## Capability matrix

| Category | Primary interface | Where sessions run | Remote model | Persistent PTY owner | Agent workflow support | Best fit |
| --- | --- | --- | --- | --- | --- | --- |
| Wolfpack | Browser/PWA, desktop and mobile | Your macOS/Linux machine or cloud VM | Bring your own private network, usually Tailscale | `wolfpack-broker` Rust daemon | Agent command presets, session triage, notifications, Ralph loop | Checking and steering long-running coding agents from phone/browser |
| `tmux` | Terminal | Host running the shell | SSH or local terminal attach | `tmux` server | Generic terminal multiplexing | Keyboard-first terminal persistence on machines you already SSH into |
| `zellij` | Terminal | Host running the shell | SSH or local terminal attach | `zellij` process/session | Generic terminal multiplexing with layouts/plugins | Terminal workspace management with a batteries-included TUI |
| Warp | Desktop terminal app | Local shell or SSH target | Desktop app plus SSH workflows | Terminal app/session model | AI-assisted terminal features | Polished local desktop terminal experience |
| Browser SSH clients | Browser | SSH target | Web app or self-hosted SSH gateway | SSH server/session stack, varies by product | Usually generic shell access | Opening a remote shell from a browser when SSH is the product boundary |
| Terminal-native agent multiplexers | Terminal | Host running the shell | SSH, local terminal, or tool-specific sync | Usually terminal multiplexer or supervising process | Agent-focused session orchestration | Developers who want agent control inside the terminal instead of a browser/PWA |

## Positioning

Wolfpack is for developers who already trust their own machines and tailnet, and want a mobile/browser command center for agent sessions. Its useful center is not "a better terminal"; it is persistent, inspectable agent control when you are not sitting at the terminal where the agent started.

Wolfpack differentiators:

- **Browser/mobile PWA**: the main interface works from a phone or browser, with installable PWA behavior and reconnect handling.
- **Tailnet-first deployment**: Wolfpack does not provide a hosted relay or account. Remote access is designed around private network exposure, normally Tailscale.
- **Broker-owned PTYs**: sessions live in `wolfpack-broker`, so restarting the Bun server does not kill active agents.
- **Ralph automation**: Ralph can run plan-driven iterations and report structured status through Wolfpack.
- **MIT license**: the Wolfpack repository is MIT licensed.

## When another tool is better

Use `tmux` when you want a tiny, proven terminal multiplexer and your normal workflow is already SSH plus keyboard shortcuts. Wolfpack adds a browser server, PWA, and broker process; that is needless machinery for pure terminal splitting and detach/reattach.

Use `zellij` when you want terminal-native layouts, panes, and plugin ergonomics. Wolfpack's desktop grid is for monitoring and light control from the browser, not replacing a full terminal workspace manager.

Use Warp when you primarily want a polished desktop terminal with local AI-assisted terminal features. Wolfpack is deliberately self-hosted and browser/mobile oriented, which is a different product shape.

Use a browser SSH client when the goal is simply "open SSH in a browser." Wolfpack is narrower: it controls local commands and coding-agent PTYs on machines you control, usually behind a tailnet.

Use a terminal-native agent multiplexer when you want every control surface to stay inside the terminal. Wolfpack is better when phone access, PWA installability, multi-machine browser views, and push-style session triage matter.

## Maintenance notes

- Keep claims about competitors categorical and stable; avoid UI-detail comparisons that churn every release.
- Do not copy text from competitor websites, docs, READMEs, or license pages.
- Prefer "best fit" language over "better/worse" unless the repository has a testable fact to back the claim.
- Re-check this page when Wolfpack changes remote access, broker behavior, Ralph behavior, licensing, install packaging, or README positioning.
- If a new docs checker is added, include this page in that validation.

## Package impact

The npm package currently ships only `bin/run.cjs` and `bin/install.cjs` through `package.json` `files`. These docs are repository documentation and are not included in the npm package unless the package file list changes.
