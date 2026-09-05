# Wolfpack Distribution Next Steps Plan

> **For Hermes:** Execute this plan task-by-task with explicit boss approval before every external post, comment, PR edit/closure, release, or publication.

**Goal:** Turn Wolfpack’s existing package, release, homepage, demos, and partial directory coverage into a measurable acquisition loop that produces real multi-machine users and credible proof.

**Architecture:** Distribution should run as a proof-first funnel: stabilize the current product truth, unify the canonical landing/install path, recruit a small tester cohort, turn their results into evidence, then publish one flagship story and roll it through focused channels. Awesome-list maintenance is cleanup, not the primary growth engine.

**Tech Stack / Channels:** GitHub repository and Discussions, GitHub Pages/Netlify, npm, existing Wolfpack demo assets, Hacker News, focused Reddit/developer communities, relevant awesome lists, and GitHub traffic/npm download telemetry.

---

## Current verified baseline — 2026-08-04

- Repository: `almogdepaz/wolfpack`
- GitHub: 37 stars, 8 forks, 9 open issues.
- npm: `wolfpack-bridge@1.6.15` is published; the earlier measured baseline was 423 downloads in the last reported week and 1,097 in the last reported month.
- Release: `v1.6.15`, published 2026-08-04 with macOS/Linux arm64/x64 server and broker assets plus checksums.
- Discovery assets already live:
  - Netlify homepage: `https://get-wolfpack.netlify.app/`
  - GitHub Pages mirror: `https://almogdepaz.github.io/wolfpack/`
  - README screenshots/GIF/MP4, repository topics, `llms.txt`, sitemap, structured metadata.
- Existing tester CTA: GitHub Discussion #262, currently with no replies.
- Existing long-form draft: `/Users/almog/.openclaw/workspace/drafts/wolfpack-control-room.md`.
- Awesome-list results: two verified merges, several rejections, and seven stale/open submissions plus two newer submissions.
- PRs #271 and #273 are merged into `main`; release commit `5549047` is tagged `v1.6.15`. Local `dev_04` is currently behind its remote by two commits and `.hermes/` is intentionally untracked because it contains this plan.

## Success criteria for the first distribution sprint

Within 14 days of beginning execution:

1. At least 3 completed two-machine trials from people outside the core development loop.
2. At least 2 testers successfully reach a usable remote phone/browser session without live setup intervention.
3. All tester friction is captured in Discussion #262 or sanitized issues using `docs/multi-machine-trial-feedback.md`.
4. One canonical landing URL is used consistently by GitHub, npm, release notes, posts, and social previews.
5. One technically current flagship article is published after approval.
6. At least two focused channel posts are published sequentially, not as a simultaneous blast.
7. Stale awesome-list submissions are triaged so only credible, correctly positioned PRs remain open.
8. Weekly metrics record acquisition and activation signals, not only stars.

---

### Task 1: Verify the merged v1.6.15 campaign baseline

**Objective:** Ensure distribution points at a stable product version and current product truth.

**Files / surfaces:**
- Review: `README.md`
- Review: `package.json`
- Review: `llms.txt`
- Review: `site/index.html`
- Review: `site/llms.txt`
- Review: `site/llms-full.txt`
- Verify: merged GitHub PRs #271 and #273
- Review: release `v1.6.15`

**Steps:**

1. Confirm `origin/main` contains merge commits for PRs #271 and #273 and release commit `5549047`.
2. Verify the public `v1.6.15` assets and checksums are complete for all four supported OS/architecture pairs.
3. Confirm the discovery/activation commits on `main` are represented accurately by the `v1.6.15` release notes and public docs.
4. Verify npm has published the matching `wolfpack-bridge@1.6.15` package and platform packages before sending campaign traffic to package-runner commands.
5. Write a one-paragraph canonical product statement and use it everywhere:
   - Self-hosted browser/mobile control room for AI coding agents.
   - Sessions survive web-server restarts because a Rust PTY broker owns them.
   - Multi-machine access runs directly over the user’s Tailscale tailnet.
   - No Wolfpack-hosted relay or prompt-storage account.
6. Remove stale “tmux wrapper” positioning from any material selected for reuse.

**Validation:**

- `git status --short --branch` is clean.
- Required CI checks pass on the chosen campaign commit.
- The install command resolves to the advertised release.
- README, homepage, npm description, and release notes describe the same architecture and supported platforms.

**Approval gate:** Boss approves merges and any release before execution.

---

### Task 2: Make one canonical acquisition funnel

**Objective:** Eliminate split URLs and ensure every discovery surface lands on the same message and install path.

**Files likely to change:**
- Modify: `package.json` — align `homepage` with the chosen canonical landing page.
- Modify if needed: `site/index.html` — canonical, OG URL, CTA, analytics/event hooks.
- Modify if needed: `site/sitemap.xml`
- Modify if needed: `site/robots.txt`
- Modify if needed: `README.md`
- Modify if needed: `.github/workflows/pages.yml`

**Steps:**

1. Choose the canonical URL: preferably the controlled Netlify homepage unless there is a reason to move to GitHub Pages.
2. Make the secondary deployment redirect to the canonical URL or guarantee byte-equivalent generated output.
3. Align:
   - HTML canonical URL
   - Open Graph/Twitter URL
   - JSON-LD application URL
   - sitemap
   - README homepage link
   - GitHub repository homepage
   - npm `homepage`
   - release notes and future post links
4. Use one primary CTA: install Wolfpack and complete a two-machine trial.
5. Use one secondary CTA: join Discussion #262 and submit sanitized feedback.
6. Add privacy-safe conversion measurements if none exist:
   - landing-page CTA click
   - installer start/download proxy
   - Discussion #262 visit
   - completed trial report

**Validation:**

- Both public URLs return expected status and canonical behavior.
- Link checker finds no broken install/demo/discussion links.
- `npm view wolfpack-bridge homepage version --json` matches the intended funnel after publication.
- OG and JSON-LD validators show the selected canonical URL.

**Risk:** Do not add invasive analytics or collect machine/project/network identifiers.

---

### Task 3: Recruit a small tester cohort before broad launch

**Objective:** Produce credible installation and activation evidence from real users.

**Existing assets:**
- Discussion: `https://github.com/almogdepaz/wolfpack/discussions/262`
- Feedback template: `docs/multi-machine-trial-feedback.md`
- Demo: `docs/assets/wolfpack-usage-demo.gif`
- Install path: README Quickstart

**Steps:**

1. Tighten Discussion #262 around a specific ask:
   - three to five testers
   - macOS/Linux mix
   - two machines or machine + phone
   - 20–30 minute trial
   - sanitized feedback only
2. Define the activation event: user opens a verified Tailnet URL and sends input to a persistent agent session from a second device.
3. Prepare a short recruitment message linking the demo, install command, and Discussion #262.
4. Select five high-fit places or people; prioritize coding-agent users, Tailscale users, self-hosted developers, and terminal-heavy developers.
5. Send/post only after boss approval and one channel at a time.
6. Capture each trial in the existing template.
7. Convert recurring friction into GitHub issues; do not mix support conversations with marketing claims.
8. Stop broad promotion if the first two independent testers cannot activate without live intervention; fix onboarding first.

**Validation:**

- Minimum 3 completed templates.
- At least 2 unassisted activations.
- Time-to-first-remote-session recorded for each tester.
- No terminal output, project names, Tailnet URLs, machine names, or credentials appear in public feedback.

**Approval gate:** Boss approves recruitment copy and destinations before external contact.

---

### Task 4: Refresh the flagship “control room” article

**Objective:** Convert the existing draft into the main technical launch story.

**Source:**
- `/Users/almog/.openclaw/workspace/drafts/wolfpack-control-room.md`

**Proposed working copy:**
- Create during execution: `docs/distribution/wolfpack-control-room.md`

**Steps:**

1. Copy the draft into the repository working area during execution; preserve the legacy source unchanged.
2. Update product truth:
   - Rust PTY broker, not tmux ownership
   - direct Tailnet multi-machine control
   - current supported platforms
   - current install command and package version
   - current demo assets
   - explicit self-hosted/no-relay security boundary
3. Add evidence from completed tester trials:
   - setup time range
   - activation rate
   - one or two sanitized friction points and fixes
4. Keep the article focused on the user problem, not the feature inventory.
5. End with one CTA: run the two-machine trial and report feedback in Discussion #262.
6. Produce channel variants from the same source:
   - Show HN title/body
   - focused Reddit/developer-community version
   - short GitHub Discussion/README announcement
7. Review every claim against the current release and docs.

**Validation:**

- All links resolve.
- Demo loads on GitHub and the canonical site.
- No stale tmux-wrapper language remains.
- No claim implies Wolfpack is safe on the public internet without deliberate auth/network configuration.
- Boss approves final copy before publication.

---

### Task 5: Publish sequentially and learn between channels

**Objective:** Avoid a spam blast and improve the message using each channel’s response.

**Recommended order:**

1. Tester recruitment in a focused existing community or direct opt-in contact.
2. Show HN after independent activation proof exists.
3. One relevant Reddit/developer community adapted to that community’s rules.
4. Tailscale/self-hosted/coding-agent community only where self-promotion is allowed and directly relevant.
5. Optional Dev.to/blog mirror after the canonical post is established.

**Steps per channel:**

1. Check current posting/self-promotion rules.
2. Adapt headline and opening paragraph; do not cross-post identical spam.
3. Show the demo and architecture distinction early.
4. Link to the canonical landing page and tester CTA.
5. Record publication URL and timestamp.
6. Wait 48–72 hours before the next channel.
7. Record questions, objections, installs, completed trials, and bugs.
8. Update the next channel’s copy based on actual response.

**Excluded by prior direction:** Do not use Twitter/X unless the boss explicitly reverses the earlier “no Twitter” instruction.

**Approval gate:** Every post requires boss approval immediately before publication.

---

### Task 6: Triage the awesome-list backlog

**Objective:** Keep only high-fit submissions with accurate current positioning.

**Priority review:**

- Strong/credible fit:
  - e2b-dev/awesome-ai-agents #400
  - tailscale-dev/awesome-tailscale #1
  - ai-for-developers/awesome-ai-coding-tools #594
  - RoggeOhta/awesome-codex-cli #178
  - jaywcjlove/awesome-mac #1867
- Needs repair:
  - oven-sh/awesome-bun #118 — remove/fix duplicate entry.
- Re-evaluate fit before further nudging:
  - alebcay/awesome-shell #570
  - k4m4/terminals-are-sexy #356
  - devtoolsd/awesome-devtools #84

**Steps:**

1. Read each repository’s current contribution rules and recent accepted entries.
2. Check whether Wolfpack meets age, popularity, maintenance, or category requirements.
3. Fix technically valid PR problems, especially the duplicate in #118.
4. Rewrite stale copy using current Rust-broker/multi-machine positioning.
5. Do not post another generic “checking in” comment where maintainers have shown no interest.
6. Close poor-fit submissions voluntarily and record why.
7. Revisit awesome-tuis only after the maintainer’s six-month-age condition is satisfied.
8. Treat merged listings as credibility assets, not a substitute for tester acquisition.

**Validation:**

- Every remaining open PR has correct current copy and satisfies contribution rules.
- No duplicate entries or stale architecture claims remain.
- Closed/rejected PRs are not resubmitted without a material eligibility change.

**Approval gate:** Boss approves PR edits, comments, and closures.

---

### Task 7: Build the weekly distribution scorecard

**Objective:** Measure whether discovery becomes real usage.

**Proposed file during execution:**
- Create: `docs/distribution/scorecard.md` or a private local equivalent if public metrics are undesirable.

**Record weekly:**

- GitHub unique visitors, clones, stars, forks.
- npm weekly/monthly downloads.
- Landing-page CTA clicks, if privacy-safe measurement is enabled.
- Discussion #262 views/replies.
- Number of tester starts.
- Number of completed two-machine trials.
- Unassisted activation rate.
- Median time to first remote session.
- Top three onboarding failures.
- Channel/source for each tester when voluntarily provided.

**Steps:**

1. Capture the current baseline before publishing.
2. Update once per week, not continuously.
3. Separate vanity metrics from activation metrics.
4. Attribute spikes only when timing/source evidence supports it.
5. End each weekly review with one decision: continue, revise message, fix onboarding, or stop a channel.

**Validation:**

- Every metric has a source and date window.
- No personal or infrastructure data is stored.
- Next action is based on activation evidence, not raw clone counts alone.

---

## Recommended execution order

1. Verify the merged `v1.6.15` release and npm package parity.
2. Unify canonical URL and npm/GitHub funnel.
3. Refresh Discussion #262 and recruit the first testers.
4. Fix onboarding failures exposed by those trials.
5. Refresh and approve the flagship article.
6. Publish sequentially: HN, then one focused community.
7. Clean the awesome-list backlog in parallel only after core messaging is final.
8. Review the scorecard after seven and fourteen days.

## Risks and tradeoffs

- **Release-channel mismatch:** GitHub `v1.6.15`, npm, platform packages, homepage, and campaign claims must stay in lockstep.
- **Dual-site drift:** Netlify and GitHub Pages can split links and SEO signals.
- **Directory busywork:** Awesome-list PR volume can feel productive without producing activated users.
- **Security messaging:** Wolfpack controls shells; distribution copy must state the Tailnet/global-auth trust boundary plainly.
- **Support load:** Broad promotion before unassisted activation works can create noise and damage trust.
- **Attribution noise:** GitHub clone traffic can include automation and CI; it is not equivalent to users.
- **External-action safety:** Publishing, commenting, closing PRs, and releases all require explicit approval.

## Open decisions for the boss

1. Is Netlify the permanent canonical homepage, or should GitHub Pages become canonical?
2. Is the first target audience primarily coding-agent power users, Tailscale/self-hosted users, or terminal/tmux users?
3. Is “no Twitter/X” still active?
4. Are direct invitations to a small tester cohort acceptable, or should recruitment stay entirely public?
