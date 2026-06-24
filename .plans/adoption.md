wolfpack adoption remaining work
status: active
updated: 2026-06-24

context:
- completed in this pass: public story/readme, npm metadata, quickstart, troubleshooting doc, trust/security copy, agent recipes, launch-copy draft, public-metrics policy.
- goal now: finish the work that actually increases conversion after someone lands on the repo.
- constraint: no default telemetry, no wolfpack-hosted relay/account framing, no product rewrite.

## 1. Add demo-first conversion asset

why: screenshots are okay; a 20-40 second workflow demo will convert better than more prose.

scope:
- record a short silent-friendly demo showing:
  - desktop grid/session list
  - phone opening the same wolfpack instance
  - session state/needs-input triage
  - replying from phone
  - optional multi-machine view if available
- add the demo above the screenshots in README.md.
- keep the asset small enough for github readme load.

acceptance criteria:
- README.md shows one primary demo asset above install/quickstart.
- the demo is understandable without audio.
- filenames are clean under `docs/`.

## 2. Review and ship the docs/metadata pr

why: npm and github positioning only helps once merged and released.

scope:
- review current README.md and docs/troubleshooting.md copy.
- decide whether launch copy belongs in repo docs or stays external.
- commit the docs/metadata/troubleshooting changes.
- open pr against main.
- after merge, cut a patch release so npm metadata updates.

acceptance criteria:
- pr includes only docs/package metadata/plans, no product behavior changes.
- ci passes.
- npm package page no longer says tmux-based after release.

## 3. Add lightweight in-product help/share surface

why: once users install, they need quick access to install/debug/share info without hunting docs.

scope:
- add an about/help entry in settings or equivalent existing UI.
- show version, github link, install command, doctor command, issue/discussion links.
- add copy-install-command button.
- keep it utility-first; no naggy growth prompts.

acceptance criteria:
- user can copy install command from UI.
- user can find `wolfpack doctor` from UI.
- user can find github/issues from UI.
- no telemetry or popups.

## 4. Improve empty states for activation

why: first-run confusion kills adoption faster than missing features.

scope:
- session list empty state: explain create-session flow.
- settings/agents empty or default state: explain built-in commands and wrapper-script pattern.
- phone/qr path: make the next step obvious when running locally.

acceptance criteria:
- fresh users can infer the next action from UI copy.
- copy stays concise and does not duplicate README/troubleshooting docs.

## 5. Launch and collect feedback

why: after demo + docs are ready, we need targeted users, not random broad marketing.

scope:
- post to Show HN, Tailscale community, Claude/Codex/Gemini relevant communities, and one social channel.
- create one GitHub Discussion for launch feedback.
- track public signals only: npm downloads, stars, issues/discussions, release downloads.

acceptance criteria:
- every launch post links to repo, demo, install command, and feedback discussion.
- feedback requests ask for platform, install method, agent command, tailscale setup result, and first-five-minutes confusion.
