# Wolfpack growth foundation — no-user work

## Objective

Make Wolfpack easy to understand, easy to try, and measurable without weakening its privacy position. Do this before chasing more traffic.

**One activation definition:** a developer starts an existing Claude Code or Codex session and successfully opens/replies to it from a second device through Wolfpack.

## ICP and job to be done

### Initial ICP

A solo developer or small-team technical founder who:

- already uses Claude Code or Codex on macOS or Linux;
- runs long-lived coding tasks on a laptop, workstation, home server, or cloud VM;
- leaves the desk while an agent is working; and
- is comfortable with Tailscale or willing to install it for private remote access.

Do not initially market to generic “AI teams,” terminal beginners, or users who do not already run an agent CLI.

### Core job to be done

> When my coding agent needs me while I am away from its machine, let me see the session and reply from my phone or another computer without SSH juggling or exposing the machine publicly.

## Landing-page direction (draft only)

### Hero

**Eyebrow:** REMOTE CONTROL FOR CLAUDE CODE AND CODEX

**Headline:** Your coding agent is waiting. Reply from anywhere.

**Supporting copy:** Wolfpack gives your existing Claude Code, Codex, Gemini, and shell sessions a private browser and phone control surface. It runs on your machines and reaches them through your Tailscale network—no Wolfpack account or hosted relay.

**Primary CTA:** Start a private remote session

**Secondary CTA:** Watch the 45-second workflow

**Proof strip:** Open source · Self-hosted · macOS + Linux · No hosted relay

### CTA around the installation command

**Before the command:** Already running Claude Code or Codex? Install Wolfpack, scan the QR code, and pick up the same session from your phone.

**After the command:** First run opens setup. Your agent credentials and project files stay on your machine.

### Keep, but move below the first screen

- “Your agents. Your machines. Your tailnet.”
- broker architecture and persistent PTY details;
- multi-machine grid and custom-agent support;
- Tailscale trust-boundary explanation.

They are differentiation and proof, not the first reason to try Wolfpack.

## 45-second demo storyboard

**Rule:** use one real Claude Code or Codex workflow. No feature montage.

| Time | Visual | On-screen copy |
| --- | --- | --- |
| 0–4s | Desktop: an agent is running a real task. | Your coding agent keeps working after you leave. |
| 4–10s | Agent asks a concrete question / reaches an approval point. | Until it needs you. |
| 10–16s | Phone opens Wolfpack PWA; session card clearly says `Needs input`. | See the session from your phone. |
| 16–28s | Read recent terminal output, type the answer, send it. | Reply without SSH or a public port. |
| 28–36s | Desktop/phone terminal shows the agent continuing. | Keep the loop moving. |
| 36–43s | Brief multi-machine/session-grid shot. | Claude Code · Codex · Gemini · Shell |
| 43–45s | Wolfpack logo plus exact install command. | Self-hosted. Private by default. |

Use captions. The demo must be understandable muted.

## Privacy-respecting activation measurement spec

### Product promise

No stealth telemetry. Collection is **explicitly opt-in**, explained during setup, disabled by default, and can be disabled later. The setup screen must state exactly what is collected and link to a local, inspectable queue/log.

### Allowed event envelope

Every event may contain only:

- `event` — fixed event name from the list below;
- `timestamp_day` — UTC date, not precise timestamp;
- `app_version`;
- `os_family` (`macos` or `linux`);
- `arch` (`arm64` or `x64`);
- `install_channel` (`curl`, `npm`, `bun`, `source`, or `unknown`);
- `failure_code` — from a fixed allow-list, when applicable.

Use a rotating random installation ID only for deduplicating opted-in reports. Do not attach it to other systems or logs.

### Explicitly prohibited data

Never collect or transmit:

- prompts, terminal output, session names, session contents, or agent transcripts;
- project names or paths;
- usernames, hostnames, device names, IP addresses, MAC addresses, or Tailscale/tailnet identities;
- tokens, JWTs, credentials, browser data, command arguments, or configuration values;
- precise event times or browsing behavior.

### Events

| Event | Fired when | Allowed properties |
| --- | --- | --- |
| `telemetry_consent_granted` | User explicitly opts in. | envelope only |
| `install_started` | Installer begins. | envelope only |
| `binary_verified` | CLI and broker checksum verification succeeds. | envelope only |
| `setup_started` | Setup wizard begins. | envelope only |
| `setup_remote_ready` | Private remote route verification succeeds. | envelope only |
| `setup_local_ready` | Local-only setup completes. | envelope only |
| `first_session_created` | A first session is created. | `harness_kind` from fixed list only |
| `second_device_connected` | A non-host browser reaches a session. | envelope only |
| `activation_completed` | A remote session can receive input. | envelope only |
| `setup_failed` | A setup step exits with a documented failure. | `failure_code` only |
| `telemetry_disabled` | User revokes consent. | envelope only |

`harness_kind` is limited to `claude`, `codex`, `gemini`, `shell`, `pi`, `cursor`, `custom`, or `unknown`; never transmit the configured command.

### Reporting

- Batch at most once per day, only while the app is running.
- Show the user the exact JSON before first send and provide `wolfpack telemetry status` / `wolfpack telemetry disable`.
- Publish a short data-retention policy before enabling this in a release.

## Solo onboarding QA checklist

Run this before recruiting or posting anywhere. Record a pass/fail, elapsed time, and exact failure step in a local test sheet.

### Release/install coverage

- [ ] macOS arm64: clean user/profile, curl installer, checksum verification.
- [ ] macOS x64: clean user/profile, curl installer, checksum verification.
- [ ] Linux x64: clean user/profile, curl installer, checksum verification.
- [ ] Linux arm64: clean user/profile, curl installer, checksum verification.
- [ ] npm runner: `npx --yes wolfpack-bridge@latest` uses matching current binaries.
- [ ] Bun runner: `bunx wolfpack-bridge@latest` uses matching current binaries.
- [ ] Installer fails clearly if a release asset/checksum is unavailable.
- [ ] Upgrade preserves a working service and existing settings.
- [ ] `wolfpack uninstall --yes` removes only Wolfpack-managed files.

### First-run coverage

- [ ] Existing Tailscale, authenticated: complete private HTTPS setup and QR route.
- [ ] No Tailscale: decline installation and reach local-only mode.
- [ ] No Tailscale: accept installation path where supported and complete sign-in.
- [ ] Existing Claude Code detected and usable.
- [ ] Existing Codex detected and usable.
- [ ] No supported agent installed: setup explains the next action without dead-ending.
- [ ] Create a session, refresh the browser, and verify session continuity.
- [ ] Connect a second device and send input to an existing agent session.
- [ ] Stop/restart service and verify the broker-owned session survives where promised.
- [ ] `wolfpack doctor` produces an actionable diagnosis for each deliberately broken prerequisite.

### Time targets

- Fresh install to local first session: **under 5 minutes**.
- Tailscale-ready install to phone-connected session: **under 10 minutes**.
- Any step over target gets a screenshot and a written friction note.

## Seven-day execution: no recruited users required

### Day 1 — establish baseline

- [ ] Run the full solo QA checklist on the primary macOS path.
- [ ] Record exact elapsed time and blockers for install → first remote reply.
- [ ] Freeze a one-sentence product promise around remote agent replies.

### Day 2 — production-quality demo

- [ ] Record the 45-second workflow with captions.
- [ ] Export a full clip, a 15-second cut, and a GIF/MP4 loop.
- [ ] Verify the clip demonstrates a real second-device reply, not mocked UI.

### Day 3 — landing-page draft

- [ ] Apply the draft hero/CTA language in a local branch only.
- [ ] Put the demo above the first long explanatory section.
- [ ] Preserve privacy, self-hosting, and Tailscale details as proof below the fold.

### Day 4 — README conversion path

- [ ] Add a top-level “Claude Code from your phone in 10 minutes” path.
- [ ] Add a parallel Codex path.
- [ ] Move architecture detail below quickstart and troubleshooting.

### Day 5 — install reliability

- [ ] Fix the most expensive friction found in solo QA.
- [ ] Add or strengthen a regression test for it.
- [ ] Re-run clean-install coverage.

### Day 6 — measurement design review

- [ ] Decide whether the opt-in measurement design is acceptable to ship.
- [ ] If yes, turn this spec into a small implementation plan and privacy copy.
- [ ] If no, use only transparent campaign/link analytics until there is a better design.

### Day 7 — release package, not distribution

- [ ] Re-run full solo QA on the candidate build.
- [ ] Prepare the demo, screenshots, concise install path, and changelog.
- [ ] Do not publish yet; the gate is a verified end-to-end remote reply on at least the primary supported platform.

## Definition of ready to recruit testers

Wolfpack is ready for external recruiting when:

1. the primary install path repeatedly reaches a real remote reply within the time target;
2. the demo shows that exact workflow;
3. the site and README lead with that outcome; and
4. there is an explicit, privacy-respecting way to learn whether new users reach activation.
