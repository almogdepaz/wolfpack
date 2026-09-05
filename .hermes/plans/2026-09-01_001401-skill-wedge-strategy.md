# Wolfpack Agent-Skill Wedge Strategy Plan

> **For Hermes:** Execute this plan task-by-task; do not publish outreach, install third-party skills, or enable tracking without the owner’s explicit approval.

**Goal:** Turn `wolfpack-tailnet-control` from buried documentation into a trusted acquisition and activation wedge: agents recognize when a user needs private remote coding-session control, guide the user through a reviewed install, and help reach one verifiable phone/second-device reply.

**Architecture:** Keep Wolfpack’s existing safety model intact. The control skill remains an auditable, narrowly scoped CLI contract; public positioning and agent-readable discovery identify the right use case without giving an agent authority to install software, change Tailnet policy, access a remote host, create sessions, or send input without the user’s explicit approval. Attribution is separated into campaign links for top-of-funnel measurement and optional aggregate activation telemetry for product learning.

**Tech stack:** Existing `skills/wolfpack-tailnet-control/SKILL.md`, `README.md`, `docs/agent-skills.md`, static Netlify site under `site/`, `llms.txt` / `llms-full.txt`, Bun tests in `tests/unit/agent-skills.test.ts`, GitHub Discussions/Issues, and existing release workflow.

---

## Current context and guardrails

- Wolfpack ships a bundled `wolfpack-tailnet-control` skill. Its contract safely uses the canonical CLI, treats selectors as opaque handles, fails closed for remote machines, and requires explicit user intent for session creation, input, remote access, notifications, and destructive actions.
- `wolfpack setup` already offers Pi users an explicit default-no skill + Pi Tasks installation. Other compatible harnesses require an audited manual clone/symlink/copy flow.
- The current homepage links `Join the pack` / `Become a tester` to GitHub Discussion #262. It presents the product well but does not make the agent-skill use case a primary conversion path.
- Activation is not a package download, GitHub clone, star, or page view. The canonical event is: a user opens an existing coding-agent session from a second device and sends a reply.
- No hidden telemetry. Do not collect prompts, terminal/session content, project paths, hostnames, Tailscale identities, IP addresses, credentials, or raw referrers.
- Do not claim a harness supports Wolfpack skills until a verified install and first-use path exists for that harness.

## Strategy in one sentence

> When a developer already using a coding agent needs to check or continue a session away from its host machine, their agent can point them to Wolfpack’s reviewed control skill and guide a human-approved path to one private remote reply.

## Primary user and trigger

**Initial ICP:** Solo developers and technical founders already using Claude Code, Codex, Gemini, or Pi on macOS/Linux; they run long-lived work on a laptop, workstation, home server, or VM and want to answer an agent remotely without SSH juggling or exposing a public port.

**Strong discovery triggers:**
- “My coding agent is running while I’m away.”
- “I need to answer Claude Code / Codex from my phone.”
- “How do I supervise sessions across my workstation and laptop?”
- “I need private remote terminal control over Tailscale.”

**Non-goals:** Generic agent framework discovery, agent beginners, public terminal sharing, autonomous installation, or marketing to teams that do not already run agent CLIs.

## Funnel and evidence model

```text
skill/docs discovered
  → skill source reviewed
  → skill installed or Pi opt-in accepted
  → Wolfpack installed / doctor clean
  → first agent session created
  → second device connected
  → remote reply sent  = activation
  → repeated remote reply in week 2 = retained use
```

Keep metrics separate:

| Metric | Meaning | Does not prove |
| --- | --- | --- |
| Campaign-link visit | source awareness | install, user, activation |
| Skill page/repository click | agent-wedge interest | successful skill load |
| Opt-in skill installation | intent | Wolfpack is configured or used |
| `wolfpack doctor` healthy | technical readiness | second-device workflow |
| Remote reply | activation | retention |
| Repeat remote reply after 7 days | retained use | broad product-market fit |

## Task 1: Freeze the safety and value proposition

**Objective:** Add a concise, identical human/agent-facing statement of what the skill is for and what it will never do.

**Files:**
- Modify: `skills/wolfpack-tailnet-control/SKILL.md`
- Modify: `docs/agent-skills.md`
- Modify: `README.md`
- Test: `tests/unit/agent-skills.test.ts`

**Steps:**
1. Add a short `When to use this skill` block immediately after the skill’s title. Include the precise triggers: remote/phone supervision, cross-machine session control, and long-running coding-agent work.
2. Add a `Human approval boundary` block: review/install skills; Tailnet configuration; remote machine access; session creation; session send/wait; notifications; and termination all require explicit user intent and a target.
3. Add the user outcome before architecture: “open a real running agent session from another machine or phone and reply privately.”
4. Keep the skill under the current 80-line test limit. Move detailed explanation to `docs/agent-skills.md`, not into the live prompt.
5. Write failing tests that assert the new trigger and approval text exists, while preserving the current opaque-selector and fail-closed guarantees.
6. Run: `bun test tests/unit/agent-skills.test.ts`.

**Acceptance:** The skill has a crisp discovery trigger without expanding its authority or token footprint materially.

## Task 2: Create a public agent-skill landing page

**Objective:** Give humans and agents a short, auditable “why / what / install / first success” page rather than making them infer the feature from a long README.

**Files:**
- Create: `site/agent-skills.html`
- Modify: `site/index.html`
- Modify: `site/sitemap.xml`
- Modify: `site/llms.txt`
- Modify: `site/llms-full.txt`
- Modify: `README.md`

**Steps:**
1. Create `/agent-skills.html` with four concise sections: the user problem; safe capabilities; installation/review paths; and the first remote-reply outcome.
2. Lead with: “Your coding agent is waiting. Let it help you pick the session up from your phone.” Explain that Wolfpack runs on the user’s own machines/Tailnet and never supplies a hosted relay.
3. Include only verified installation paths:
   - Pi: reviewed default-no offer from interactive `wolfpack setup`.
   - Manual compatible harnesses: clone/audit then symlink/copy into the documented global skill root.
   - Do not add “one-click install” to any harness without proof it preserves audit and destination safety.
4. Include a trust callout: skills can execute commands with user permissions; users must inspect the source; installation does not grant autonomous remote access or input authority.
5. Add a visible `Read the skill source` link to the GitHub `SKILL.md`; add `Try the phone reply workflow` linking to a concise first-success section in docs.
6. Link this page from the homepage’s workflow/CTA area and README’s Agent Skills section; include it in sitemap and agent-readable files.
7. Validate static links with the existing site test/build command or a simple local HTTP link check.

**Acceptance:** A visitor can understand the skill’s value and safety constraints within one screen, then reach the audited source and the correct install path.

## Task 3: Add a canonical “agent-assisted first remote reply” guide

**Objective:** Remove the ambiguity between skill install, app install, agent control, Tailscale setup, and actual activation.

**Files:**
- Create: `docs/agent-assisted-first-reply.md`
- Modify: `docs/agent-skills.md`
- Modify: `README.md`
- Modify: `site/agent-skills.html`
- Test: `tests/unit/agent-skills.test.ts`

**Steps:**
1. Write one thin golden path for an existing local Claude Code, Codex, Gemini, or Pi session. It must end in an actual second-device reply, not merely successful `wolfpack doctor` output.
2. Separate human actions from agent actions in every step. Example: only the human approves setup/Tailnet/remote target and opens the QR URL; the agent may inspect status only after the requested capability exists.
3. Include exact success conditions: verified Tailnet HTTPS URL/QR; a session visible on second device; input sent; agent output continues.
4. Include four recovery exits: no Tailscale, unsupported/missing harness, unavailable remote peer, and failure after a service restart. Link canonical troubleshooting rather than duplicating contracts.
5. Add a minimal structured feedback prompt: OS, harness, elapsed time to remote reply, first blocker, and optional screenshot. Explicitly state not to share prompts, tokens, terminal logs, or machine identities publicly.
6. Add tests that every referenced document exists and that the guide does not suggest browser scraping, guessed auth, or unapproved action.

**Acceptance:** A stranger can distinguish “skill loaded” from “Wolfpack activated,” and reach the activation event with a concrete fallback path.

## Task 4: Make attribution links useful and privacy-respecting

**Objective:** Learn which distribution surface produces qualified interest without pretending click data is activation data.

**Files:**
- Create: `docs/growth/agent-skill-attribution.md`
- Modify: `site/agent-skills.html`
- Modify: `site/index.html`
- Modify: `README.md`
- Modify: `docs/growth-foundation.md`

**Steps:**
1. Define a stable naming convention:
   ```text
   https://get-wolfpack.netlify.app/agent-skills.html?ref=<channel>&campaign=<asset>
   ```
   Examples: `ref=pi-skill`, `ref=claude-code`, `ref=agentskills-directory`, `ref=tailnet-community`; campaigns describe the concrete asset, e.g. `phone-reply-demo`.
2. Create a short internal registry table of campaign URL, asset/post, publish date, audience hypothesis, and desired next action. Do not put secrets or personal data in it.
3. Treat link data as aggregate acquisition only. Page analytics must not fingerprint users or send terminal/session/Tailnet data.
4. If adding a redirect/counting layer, review its data retention, IP-log behavior, and Netlify defaults first. Prefer aggregate site analytics that can be disabled or a transparent static link convention before creating server-side tracking.
5. Separate campaign attribution from the product’s future opt-in activation events (`second_device_connected`, `activation_completed`). Never silently bridge browser identifiers to product installation IDs.
6. Add an explicit disclosure near any tracking-enabled CTA and update privacy copy before publishing it.

**Acceptance:** Every external post can be compared by source and campaign, but the product remains privacy-first and no metric is mislabeled as users.

## Task 5: Build two reusable demonstration assets

**Objective:** Make the wedge legible without asking audiences to read protocol documentation.

**Files:**
- Create: `docs/marketing/agent-skill-demo-script.md`
- Create: `docs/marketing/agent-skill-launch-copy.md`
- Modify: `README.md`
- Modify: `site/agent-skills.html`

**Steps:**
1. Record a 45–60 second captioned real workflow: agent works on desktop → requests input → Wolfpack session appears on phone → human replies → agent continues. Include one brief frame showing the skill/canonical CLI, not a fake autonomous workflow.
2. Cut a 10–15 second loop for social/community context: “Agent needs input. Reply from your phone. Private Tailnet route.”
3. Write channel-neutral launch copy that leads with the pain and outcome, then states proof: self-hosted, own machines, Tailnet, no hosted relay/account.
4. Write a separate technical explainer: skill source is audited, CLI is canonical, remote targeting fails closed, and human approval boundaries remain intact.
5. Do not publish any asset during this task; render locally and verify every frame is a real supported workflow.

**Acceptance:** The same real scenario can be reused on the homepage, README, GitHub Discussion, Dev.to, X, Reddit, and agent-skill directories without changing the core claim.

## Task 6: Run a narrow, permissioned distribution experiment

**Objective:** Test agent-skill distribution before broad launch.

**Files:**
- Create: `docs/growth/agent-skill-experiment-log.md`
- Modify: `docs/marketing/agent-skill-launch-copy.md`

**Steps:**
1. Select at most three high-intent surfaces: a Pi/agent-skill community, a Claude Code or Codex community where self-promotion rules permit it, and a Tailscale/self-hosted community.
2. For each surface, define: exact post title/body, campaign link, target user, allowed call-to-action, moderator/self-promotion rule, and success threshold.
3. Start with a tester invitation, not a “launch.” Ask for one phone/second-device remote reply and one precise friction report.
4. Publish only after owner approval and only where rules permit it. Do not cross-post blindly or use bots/agents to spam communities.
5. Record aggregate visits, voluntarily reported installs/activation, setup failures, and qualitative language users use to describe the problem.
6. After seven days, pick one action: improve onboarding, revise positioning/demo, double down on the channel, or stop the experiment.

**Acceptance:** We learn from a small, attributable, policy-compliant cohort rather than mistaking broad attention for demand.

## Task 7: Close the activation and retention loop

**Objective:** Turn external tester feedback into product priorities without invasive analytics.

**Files:**
- Modify: `docs/growth-foundation.md`
- Create: `docs/growth/agent-skill-feedback-template.md`
- Create: `docs/growth/agent-skill-weekly-review.md`

**Steps:**
1. Define success for this wedge as `activation_completed`: user sends input to a live agent from a second device and sees continuation.
2. Define the first retention proxy: the same user repeats the remote-reply workflow during the following week.
3. Maintain a private, voluntary feedback log with only submitted data. Categorize blockers as install, Tailnet, harness discovery, skill review/install, session control, mobile terminal, or trust/understanding.
4. Prioritize the single largest activation blocker per review cycle; write a focused implementation issue with an exact reproduction path and test expectation.
5. If optional aggregate telemetry is considered, turn the existing privacy proposal into a separate implementation/security review before adding code. It must remain disabled by default and inspectable by the user.

**Acceptance:** Each campaign produces a decision tied to activation friction, not vanity metrics.

## Verification checklist

- [ ] `wolfpack-tailnet-control` remains under its tested line budget and preserves explicit-intent/fail-closed rules.
- [ ] Every public skill claim maps to a documented, tested CLI capability.
- [ ] Pi and manual installation paths remain reviewed, default-safe, and non-destructive.
- [ ] The golden guide ends in an independently verified second-device reply.
- [ ] Homepage/README/agent page/llms files agree on the same user outcome and trust boundary.
- [ ] Campaign URLs have documented source/campaign names; no click metric is called a user count.
- [ ] Analytics disclosure and privacy review precede any tracking implementation.
- [ ] External posts are prepared but never published without explicit owner approval and channel-rule review.
- [ ] At least one clean-profile dogfood run validates the public agent-assisted path before recruiting testers.

## Risks and decisions

| Risk | Decision / mitigation |
| --- | --- |
| Skill becomes an unsafe autonomous operator | Preserve explicit user intent for any side effect; the skill is an instruction contract, not authority. |
| Marketing claims imply public remote access | Lead with private Tailnet control, own machines, and no relay/account; never imply an exposed public URL. |
| Skill install is confused with product activation | Center all docs/demos on the second-device remote reply. |
| Link analytics harms privacy posture | Use aggregate attribution only; no browser-to-install identity stitching; disclose any tracking. |
| Broad promotion attracts low-fit users | Start with three high-intent communities and a concrete tester request. |
| Too much in live skill burns agent context | Keep the short operational contract in `SKILL.md`; link references for detailed install and safety guidance. |
| Harness claims drift | Maintain a verified harness matrix and remove/qualify unsupported claims immediately. |

## Open questions before implementation

1. Which three exact external directories/communities currently accept an agent-skill/control-room submission under their self-promotion rules?
2. Do we want a dedicated static campaign link convention only, or a transparent Netlify aggregate analytics/redirect configuration?
3. Which harness gets the hero golden path first: Pi, Claude Code, or Codex? Recommendation: choose the one with the cleanest verified second-device demo and installation path.
4. Should the tester call-to-action remain GitHub Discussion #262, or should it move to a dedicated issue template/form with a less demanding first ask?
5. What is the minimum current supported version matrix we are willing to state publicly for Pi, Claude Code, Codex, and Gemini?
