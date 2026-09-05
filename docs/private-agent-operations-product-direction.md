# Wolfpack private agent operations — market research and product direction

**Status:** working strategy, not a committed roadmap  
**Research snapshot:** September 4, 2026  
**Interactive concept:** [`prototypes/agent-operations-concept.html`](prototypes/agent-operations-concept.html)

## Executive summary

The market has validated demand for remote, persistent, and parallel coding-agent workflows. It has not established that developers will pay for a standalone agent dashboard. Remote control, worktrees, mobile supervision, multi-agent views, vendor-neutral launchers, cloud sandboxes, and self-hosted workers are rapidly becoming standard features.

Wolfpack should therefore not position itself as another multi-agent orchestrator or a better terminal grid.

The direction worth investigating is not yet a platform commitment. The immediate hypothesis is narrower:

> **Help one team delegate a recurring private-service regression task without giving the agent a reusable service credential, then return a quarantined patch with evidence that team already accepts.**

The broader strategic shorthand remains useful as a vision, not current positioning:

> **Your own agent cloud, on machines you trust, for agents you do not.**

The differentiated workflow is:

1. Run an agent durably in an isolated guest on customer-owned compute.
2. Mediate sensitive operations through a trusted supervisor outside the guest.
3. Show a human exactly what authority or private data a request would release.
4. Export an untrusted result rather than trusting the producing environment.
5. Reproduce and verify it with a pinned, independently invoked harness.
6. Require a separate, scoped human decision before creating a branch or draft pull request.

This is still a hypothesis. The interactive mock is a recruiting and discovery instrument; it is not evidence that the current product implements the depicted security guarantees. The present recommendation is a narrowly bounded design-partner experiment—not authorization to build the full platform roadmap.

---

## How this relates to Wolfpack today

Wolfpack’s current strength is durable control of agent and terminal sessions on machines the user owns, including after a browser or laptop disconnects. It offers a better operational experience than manually combining SSH and `tmux`.

That remains useful, but the generic remote-control wedge is eroding:

- Anthropic offers native Claude Code Remote Control.
- Cursor controls agents on managed and self-hosted machines from desktop, web, mobile, Slack, GitHub, and Linear.
- Happy provides open-source mobile remote control for Claude Code and Codex.
- Conductor is adding cloud persistence, collaboration, APIs, and mobile access.

[`growth-foundation.md`](growth-foundation.md) describes the earlier near-term activation thesis around remote replies from a second device. It remains relevant to the current product and onboarding, but it does **not** represent the full longer-term product direction in this document.

The strategic bridge is to preserve session durability and remote supervision while testing whether private execution can become safer and more governable.

### Operating decision while the hypothesis is unproven

Wolfpack has no paying-user base from which to run an immediate paid experiment. Near-term work should therefore:

- continue honest onboarding and activation improvements for the shipped remote-control product;
- use the concept mock to recruit a small number of qualified design partners;
- pause broad platform, fleet, multi-runtime, and enterprise-governance implementation;
- change Wolfpack's primary positioning only after a real security-blocked task succeeds under constrained authority and a buyer agrees to paid continuation.

A remote reply from a second device remains an activation measure for today's product. It is **not** activation for private agent operations. A candidate metric for the proposed product is: a real task previously blocked by security completes under approved constraints, with acceptable operator effort.

### Shipped, proposed, and pilot-only boundaries

| Capability | Status | Honest claim |
| --- | --- | --- |
| Durable PTY sessions and browser/phone control | Shipped | Sessions survive web-server restarts and can be controlled remotely. |
| Shell-level authority in selected projects | Shipped | Existing sessions run as the local user and are not contained security principals. |
| Global API/JWT/Tailnet access policy | Shipped | There is no inter-session authorization layer; access must be treated as shell access. |
| Isolated guest with no ambient host/private-network authority | Proposed | The concept requires a new boundary; current sessions do not inherit this label. |
| Typed capability and private-data broker | Proposed | The current PTY broker is not a capability or security broker. |
| Independently invoked verifier and signed verdict channel | Proposed | Mock evidence is simulated. |
| One-workflow concierge integration | Pilot-only | May be manually assembled with an existing runtime, service adapter, and CI. |

Basic operator identity, guest/control separation, and enforceable authority boundaries are prerequisites to any security pilot. Full enterprise RBAC can wait. Existing no-stealth-telemetry commitments remain: customer-owned operational audit data is distinct from optional product analytics. Any future hosted coordination service must disclose what it receives and that it changes today's no-hosted-relay deployment promise.

---

## Market findings

### 1. Demand is established for coding-agent tooling, not this category

Open-source adoption and product claims show substantial interest in agent tooling. They do **not** establish demand or budget for private agent operations:

- [Claude Squad](https://github.com/smtg-ai/claude-squad): approximately 8.4k GitHub stars.
- [Happy](https://github.com/slopus/happy): approximately 23.6k stars.
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban): approximately 28k stars; it claimed 30,000 active users and 100,000 pull requests created.
- [Omnara](https://github.com/omnara-ai/omnara): approximately 2.8k stars.
- [OpenHands](https://github.com/All-Hands-AI/OpenHands): approximately 86k stars.
- [Daytona](https://github.com/daytonaio/daytona): approximately 71.8k stars.
- [E2B](https://github.com/e2b-dev/E2B): approximately 13.7k stars.

GitHub stars and vendor-reported usage are directional signals, not proof of retention, revenue, or willingness to pay.

### 2. Generic orchestration has at least one material monetization warning

[Vibe Kanban reported that it shut down its company](https://www.vibekanban.com/blog/shutdown) in April 2026 despite reporting thousands of daily users. Its announcement said the vast majority were free users and it could not find a business model the team found attractive. Preserve the exact quotation and date in a durable research note because the live page has not been consistently retrievable.

This is a warning, not causal proof that orchestration cannot monetize:

> A polished interface for parallel agents can attract substantial usage while still failing to produce an attractive standalone business.

### 3. Incumbents are absorbing horizontal features

Cursor now combines:

- local, cloud, remote SSH, and self-hosted execution;
- worktrees and parallel agents;
- personal machines and team worker pools;
- Mac, Linux, GPU, and Kubernetes workers;
- web, desktop, mobile, Slack, GitHub, and Linear control;
- subagents, diffs, pull requests, and long-running sessions.

Conductor combines:

- Claude Code, Codex, Cursor, and OpenCode;
- local worktrees and cloud microVMs;
- persistent cloud sessions;
- multiplayer collaboration;
- API access, team administration, and a planned mobile application.

Anthropic, OpenAI, and GitHub similarly own natural distribution points around the model, IDE, issue, and pull-request workflows.

Features such as mobile control, vendor neutrality, a session grid, task cards, worktrees, notifications, and background execution should be considered table stakes rather than a moat.

### 4. Sandboxes and governance are becoming product primitives

Docker must be treated as a strategic baseline, not only a runtime substrate. Its current documentation describes persistent microVM sandboxes; host-side credential and OAuth injection; network, filesystem, and MCP policy; MCP approval gates; centrally enforced organization policy; audit export; and a paid organization-governance subscription over a free sandbox CLI. This already overlaps both the proposed control stack and proposed free/team monetization boundary.

Docker also documents defaults and limitations that matter, including direct workspace writes, shared skills, credential scope, and optional clone isolation. The fair comparison is Wolfpack versus a **hardened Docker configuration**, not Docker's weakest defaults.

E2B, Daytona, Vercel Sandbox, Cloudflare Sandbox, Blaxel, Fly.io Sprites, microsandbox, Coder/Ona, and similar systems also provide increasingly capable execution and lifecycle primitives. Wolfpack should integrate rather than build a proprietary hypervisor. Any remaining value must be demonstrated on one workflow: stricter request/response constraints, trusted private-data transformation, locally controlled policy/evidence, useful independent verification, safer Git quarantine, or materially lower operator burden. These are unknowns to test, not an assumed opening.

### Claim ledger for investment decisions

Keep adoption counts in a dated appendix. Use this smaller ledger to separate evidence from inference and decisions:

| Claim | Evidence and date | Status/confidence | Consequence if false |
| --- | --- | --- | --- |
| Coding-agent orchestration attracts users | Dated repository stars and vendor usage claims in the September 2026 snapshot | Directional; not revenue evidence | Do not infer a buyer for governance. |
| Docker overlaps the proposed runtime, policy, approval, audit, and paid-governance boundary | Docker security, credentials, and governance docs checked September 2026 | Shipped claims; high confidence, configuration-specific | Wolfpack must beat or integrate the configured baseline. |
| Cursor supports managed private connectivity and self-hosted execution | Cursor live docs checked September 2026 | Shipped claims; high confidence; agent loop locality differs | Customer-owned execution alone is not a wedge. |
| Teams have a budgeted gap for brokered private-data release and independent evidence | No paying users or completed buyer study | Unknown | Do not authorize the platform roadmap. |
| Independent verification adds consequential findings beyond ordinary CI | No partner replay data | Unknown | Integrate existing CI and drop the standalone claim if no increment appears. |
| Narrow authority remains useful and operable | No representative-task trial | Unknown | Reject or change the beachhead if useful work needs ambient authority. |

---

## What people use today

### SSH, Tailscale, `tmux`, and worktrees

Power users commonly:

- reach a laptop, devbox, Mac mini, or server through SSH or Tailscale;
- keep agents alive in `tmux` or persistent shells;
- make one clone or Git worktree per task;
- inspect results manually;
- move accepted work through commits and pull requests.

This workflow is flexible, private, inexpensive, and compatible with every CLI agent. It is also operationally fragmented and normally gives the agent whatever credentials, files, sockets, and network access exist in the developer environment.

This manual stack is Wolfpack’s most important substitute.

### Native vendor workflows

Developers also use:

- Claude Code Remote Control for first-party continuation of local Claude sessions;
- Cursor Cloud Agents and Self-Hosted Machines;
- OpenAI Codex local and cloud agents;
- GitHub Copilot coding agents and Agent HQ;
- vendor-native mobile and pull-request review surfaces.

These are easy to adopt because they are integrated with an existing model subscription, editor, or source-control account.

### Local parallel-agent tools

Claude Squad, Vibe Kanban, Conductor local workspaces, and custom scripts automate worktrees and process management. They reduce filesystem collisions but do not necessarily provide a security boundary between an agent and its host.

### Hosted agent and sandbox systems

Teams that accept hosted execution use Cursor, Conductor Cloud, OpenHands, Omnara, E2B, Daytona, Vercel, and related platforms. These can be operationally simpler than maintaining private worker infrastructure.

---

## Competitor map

| Configured alternative | Why users choose it | Question Wolfpack must answer |
| --- | --- | --- |
| Docker Sandboxes + organization governance + existing CI | Persistent microVMs, credential injection, network/filesystem/MCP policy, approvals, audit, paid central governance | Does Wolfpack add materially tighter response controls, local evidence, lower setup burden, or safer handoff? |
| Cursor managed agent + private connectivity | Integrated agent, isolated VMs, network allowlists, environment secrets, privacy controls | Does customer-owned execution or local supervision change approval enough to buy another product? |
| Cursor self-hosted machine | Runs tools on customer workers while Cursor operates the agent loop | Is a local supervisor and guest boundary materially safer and operable? |
| Existing self-hosted CI runner + Vault/1Password/cloud IAM + branch protections | Already purchased, customizable, accepted by security | Is the integrated workflow cheaper and more reliable than assembling existing controls? |
| SSH/Tailscale + `tmux` + worktrees | Flexible, private, free, agent-neutral | Can Wolfpack remove ambient authority and ceremony without reducing task success? |
| Conductor local/cloud | Polished multi-agent workflow and persistence; listed at $50/month Pro and $60/user/month Teams in the checked pricing snapshot | Does the buyer need security/governance beyond orchestration? |

### The strongest direct threat: Cursor

[Cursor Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted.md) already executes agent tools on laptops, devboxes, remote VMs, Macs, GPUs, and team worker pools. [Cursor for iOS](https://cursor.com/docs/cloud-agent/mobile.md) starts and supervises those agents remotely.

Cursor therefore invalidates broad claims such as:

- “agents on your own machines”;
- “control them from mobile”;
- “route work to Macs or GPUs”;
- “parallel work across projects”;
- “private team workers.”

Cursor's self-hosted agent loop remains in Cursor's cloud, while its worker executes tools against customer infrastructure. Cursor also offers managed private connectivity, isolated VMs, network allowlists, environment-scoped secrets, and privacy controls. Needing private services therefore does not automatically require customer-owned execution. The question is whether a local supervisor, stricter guest boundary, exact response brokerage, or local evidence changes a real approval or purchasing decision.

### The strongest startup threat: Conductor

[Conductor](https://www.conductor.build/) already supports multiple first-party agent harnesses, isolated workspaces, cloud microVMs, persistent sessions, multiplayer collaboration, APIs, diffs, and pull-request workflows. Its checked pricing supplied useful anchors: $50/month Pro and $60/user/month Teams. Its current limitations—Mac-centric local operation, Vercel-hosted cloud environments, and incomplete customer-owned cloud support—may be temporary.

Vendor neutrality, worktrees, cloud persistence, collaboration, and polished UX are not sufficient differentiation from Conductor. List prices demonstrate packaging, not revenue.

---

## User pain revealed by the market

Anecdotal community responses to parallel-agent products describe the following possible pains. The current research does not yet include a dated, linked sample sufficient to call them repeated demand evidence:

- too much generated code to review;
- loss of mental context across parallel tasks;
- semantic conflicts even when worktrees prevent filesystem collisions;
- agents changing tests or introducing fallbacks that make checks pass incorrectly;
- tedious merge conflict resolution;
- concern about broad repository permissions and telemetry;
- doubt that a Kanban board adds enough value beyond terminals and worktrees;
- low trust in agent-produced claims of completion.

The important bottleneck may not be launching more agents. It may be safely granting authority and deciding which outputs deserve promotion.

---

## Recommended category and positioning

### Category

**Private agent operations**

Not:

- multi-agent Kanban;
- remote terminal software;
- another coding agent;
- generic sandbox infrastructure;
- “AI employees”;
- a Tailscale-specific agent product.

### Core job to be done

> When agents need to work unattended in my private, stateful environments, let them use only the minimum authority required, keep reusable credentials and infrastructure control outside their reach, and give me independently reproducible evidence before their work can leave quarantine.

### Product promise

> Run persistent agents on private infrastructure while treating both the agent and its output as untrusted.

### Important precision

Customer-owned execution does not automatically mean private inference.

The product must separately disclose:

1. **Execution location** — where tools and code run.
2. **Control-plane location** — where sessions, policy, evidence, and supervision live.
3. **Inference/data path** — which model endpoint receives prompts, selected code, tool output, fixtures, screenshots, or other context.

“No vendor-hosted execution worker” may be true while source or tool output still reaches a model vendor. Wolfpack must never collapse these into a single privacy claim.

---

## Initial purchasing hypothesis

Do not treat Macs, GPUs, robotics, private databases, and regulated teams as one ICP. The first recruitment hypothesis is deliberately narrower:

> **An identity or platform team maintains a service that repeatedly regresses against an internal compatibility fixture. Engineers already use coding agents, but security will not let an unattended agent hold the package-service credential or trigger privileged CI.**

The study should support one ordinary Linux guest on one customer-owned Mac or Linux build host. Xcode/signing, GPUs, device passthrough, production database writes, arbitrary private networking, and deployment are out of scope.

Separate the participants:

- **Developer user:** wants the recurring regression fixed with fewer active minutes.
- **Operational champion:** owns the build host, agent runtime, or developer platform.
- **Security approver:** decides whether the narrow data release and quarantine path are acceptable.
- **Economic buyer:** controls developer-tooling or platform budget; a security veto alone is not a budget.

A qualified design partner must demonstrate a recent blocked or heavily supervised task, its current workaround, frequency, and cost. Organization size is secondary. Teams satisfied with Docker governance, Cursor managed private connectivity, or existing CI/Vault assembly are valid negative evidence rather than weak leads.

---

## Intended workflow

### 1. Create a run

The user selects:

- task and project;
- agent harness;
- customer-owned machine or placement class;
- versioned security profile;
- model/inference endpoint and disclosed data destination.

### 2. Place an isolated guest

A trusted supervisor outside the guest creates the environment. The guest receives a bounded workspace and agent identity, not host, Tailnet, control-plane, Docker/hypervisor, or reusable infrastructure credentials.

Isolation claims must be measured and time-bound. The UI should report runtime/build, mounts, routes, sockets, egress policy, policy digest, supervisor identity, probe time, and stale or failed evidence. A successful probe is not a continuing guarantee or a defense against a compromised host administrator, supervisor, hypervisor, or VM escape.

### 3. Broker sensitive operations

When the agent needs private data or authority, it submits a typed request to the supervisor. A request should identify:

- signed origin and run identity;
- exact method and canonical destination;
- reason;
- request body and maximum response;
- data classification;
- destination inside the guest;
- whether the data can reach the configured model endpoint;
- transform or redaction policy;
- expiry, replay behavior, approver, and audit retention.

The supervisor retains the reusable credential and performs only the approved operation. This protects credential authority, not necessarily the confidentiality of returned data. An approval must distinguish a bounded future fetch from release of already-fetched exact bytes. When exact bytes exist, retain a response digest, transform identity, delivered digest, approver, destination, and delivery result in lineage.

Safe transforms must themselves be trusted and demonstrable: show the classification source, redactor version, removed fields, useful preview or summary, and confirmation that only transformed bytes reach the guest.

The run's signed policy snapshot is immutable for interpretation and audit, but emergency containment remains live. Grants require expiry and revocation; a trusted operator must be able to stop or destroy the guest, revoke a capability, and reduce model or compute budgets. Supervisor outage, partial execution, retry, replay, and stale-evidence behavior must fail closed for privileged operations.

### 4. Export an untrusted result

The producing environment exports a patch or other typed artifact. Its terminal output, tests, and completion message remain producer claims.

### 5. Verify independently

A separate verifier receives:

- a pinned clean base and exported patch;
- a pinned verifier image and immutable organization-owned harness;
- pinned dependency and fixture inputs where feasible;
- a policy defining the supported independence level and trusted verdict channel.

Evidence should include base, patch, image, harness, dependency, fixture, and policy digests; verifier identity; exact command; exit status; exact verdict bytes; signer; raw signed log; shared trust roots; mutable services; and explicit limitations.

A clean environment alone is not independent verification if the patch can modify the command or tests used to judge itself. Candidate code still executes in the verifier and must not receive signing keys, rewrite the harness/results, or control the trusted completion channel. Project scripts may be tested as behavior, but the verification decision must be invoked and observed independently. Signatures establish provenance, not correctness. Expensive stateful workflows may support only a weaker, explicitly named independence level.

Verifier failures cannot be acknowledged away. Separate human risk findings—such as modification of a protected build surface—may require explicit review after immutable checks pass.

### 6. Prepare a scoped Git write

Promotion should not mean direct merge or deployment. The first governed action is normally:

- show exact repository, base, quarantine target, patch digest, reviewers, and permitted Git operation;
- issue a narrow Wolfpack grant bound to those values and an idempotency key;
- let the broker use a repository/permission/time-scoped GitHub App installation token;
- handle partial failure and retry without widening the operation, then revoke on completion;
- return the resulting repository, branch, commit, and draft-PR identities.

A GitHub App token is not inherently a one-operation or one-branch credential and normally lasts longer than the desired action. Wolfpack's grant must enforce the narrower operation separately.

A draft branch or PR can trigger CI, previews, bots, package scripts, and self-hosted runners before merge. The quarantine destination must not automatically invoke privileged automation on untrusted changes. Branch protection alone is insufficient. The producing agent never receives repository, merge, or deployment authority.

---

## Trust model

### Trusted components

The proposed design trusts:

- the customer-controlled host administrator;
- the Wolfpack supervisor outside the guest;
- the selected sandbox or microVM runtime;
- policy and verifier images approved by the organization;
- the evidence-signing identity and storage;
- explicitly selected model and service endpoints to the extent data is released to them.

### Untrusted components

Treat as untrusted:

- the coding agent and model output;
- code executed inside the producing guest;
- producer terminal logs and test claims;
- repository content that can modify project scripts;
- exported changes until independently reproduced;
- delegated child agents unless each receives a separate identity, workspace, budget, and authority.

### Protected assets

The design aims to protect:

- host filesystem and control sockets;
- Tailnet and private-network reachability;
- reusable credentials and infrastructure APIs;
- other agents’ workspaces and mutable services;
- branch, merge, deploy, and production authority;
- the integrity and provenance of verification evidence.

### Non-goals and limitations

The concept does not by itself protect against:

- a compromised host administrator;
- a compromised Wolfpack supervisor;
- a sandbox or hypervisor escape;
- a malicious approved model endpoint;
- secrets intentionally released to the guest;
- weak organization-owned tests;
- supply-chain compromise in approved images, dependencies, fixtures, or mutable services;
- inference data leaving the organization when a vendor model or customer gateway with external upstreams is selected;
- privileged CI, preview, or bot execution unless the downstream quarantine policy also contains untrusted code.

---

## What may become defensible

No single feature is a durable moat. A defensible position would need to compound across:

### Hardened supervisor/guest protocol

- no agent access to control-plane or runtime-administration sockets;
- typed, narrow capability requests;
- short-lived, replay-safe grants;
- controlled artifact export;
- attributable and signed operational events.

### Permission and data brokerage

- perform approved operations without releasing reusable secrets;
- constrain both request and response;
- support trusted transformations and redaction;
- make model-data consequences visible;
- audit, revoke, and measure approval behavior.

### Verifiable promotion

- pinned clean bases and immutable harnesses;
- clear independence levels and shared trust roots;
- evidence lineage from request through draft PR;
- fail-closed behavior for stale proof, failed checks, or unverifiable controls.

### Runtime portability

- one supervisory contract across local microVMs, containers, customer VMs, Kubernetes, Macs, Linux GPU hosts, and hosted sandbox providers;
- placement by required capability and policy support rather than by vendor-specific workflow.

### Environment and policy ecosystem

- known-good setup and verifier recipes;
- repository-specific protected surfaces;
- policy versions and enforcement metadata;
- reliable recovery, placement, and lifecycle behavior;
- integrations with existing agents, CI systems, source control, and sandbox runtimes.

### Trust and deployability

- open and auditable local runner/protocol;
- customer-controlled or self-hosted control plane;
- optional coordination without mandatory source or transcript retention;
- precise, reproducible security claims.

These remain execution advantages, not permanent protection from incumbents.

---

## What is not a wedge

Assume competitors can copy or already provide:

- session grids;
- remote terminal streaming;
- mobile notifications and replies;
- worktrees;
- task cards and Kanban;
- agent status indicators;
- vendor-neutral agent launchers;
- Tailscale connectivity;
- background execution;
- cloud sandboxes;
- diff review;
- agent-to-agent messages;
- generic Docker wrappers.

Tailscale can be an excellent transport option but should not define the product category. Users may prefer direct local access, another private network, outbound relay, or a customer-hosted control plane.

Structured delegation is useful, but it should support the trust model rather than lead the positioning. Every child should have bounded context, authority, workspace, budget, and evidence—not unrestricted communication or shared mutable state.

---

## Purchasing and pricing hypothesis

Wolfpack has no paying users, so a tier inventory would imply confidence the research does not support. Docker already offers a free local sandbox CLI and sells organization governance. The first commercial question is whether a team will pay for one integrated workflow beyond that baseline.

After an unpaid design-partner thin slice demonstrates a useful outcome, test a **$2,500 fixed-scope pilot** for one repository, one worker, one read-only capability, quarantine export, and integration with the team's existing CI. Treat this price as a conversation instrument, not a validated price. Credit it toward a continuation only if that helps expose a real budget decision.

Measure delivery economics against:

- setup and support hours;
- active engineer and reviewer minutes saved;
- the team's existing agent/devtools budget;
- integration maintenance and incident ownership;
- repeat task volume.

Do not price from hypothetical avoided breaches. Test whether the likely charging unit is a team workspace plus active private workers rather than seats. Customer-controlled deployment cannot be reserved only for an enterprise tier if local control is the reason the first team buys. A plausible future boundary is free/open local execution, paid team policy and evidence workflow, and separately priced deployment support—but this remains unvalidated.

---

## Product risks

### 1. The wedge collapses into configured Docker + CI + existing identity tools

If operation brokerage and verification are not safer, easier, and more integrated than Docker governance plus existing CI, Vault/1Password/cloud IAM, and repository controls, Wolfpack has no durable reason to exist in this category.

**Required proof:** run the same recurring private-service task through the strongest configured substitute and a Wolfpack-assisted concierge path. Measure task success, setup/support time, approvals, containment, and review effort.

### 2. Vendor-neutral positioning conflicts with data governance

Different agents and model endpoints have different data paths and retention behavior.

**Mitigation:** make model endpoint, inference egress, and retention first-class policy and run choices. Never imply source privacy from execution location alone.

### 3. The initial ICP may not want to operate the stack

A 5–50 engineer team may lack appetite for microVMs, brokers, verifier images, policy integration, and evidence infrastructure.

**Mitigation:** begin with one bounded, managed integration and quantify reduced setup, approval, review, and CI toil. Identify the operational owner before treating usage as demand.

### 4. The capability broker becomes an attack surface or bottleneck

A broker can hide credentials while still releasing sensitive data, and frequent prompts can interrupt users.

**Mitigation:** constrain response schemas and sizes, support trusted transforms, deny high-risk classes by policy, measure approval frequency and latency, and enable reviewed reusable rules only where safe.

### 5. Verification creates false assurance

A fresh guest is insufficient if it shares a compromised host, mutable service, weak test, or project-controlled harness.

**Mitigation:** state independence precisely, pin trust roots, invoke immutable organization-owned checks, show what remains shared, and fail closed on stale or incomplete evidence.

### 6. Incumbents already occupy much of the proposed paid layer

Docker already ships and sells meaningful sandbox governance, policy, credential, approval, and audit capabilities. Cursor offers managed private connectivity and security controls in addition to self-hosted execution. GitHub, agent vendors, and existing CI/identity stacks own strong distribution and trust relationships.

**Mitigation:** do not race to reproduce their inventories. Integrate a thin slice and identify which single incremental outcome—safe response release, persistent local supervision, or trustworthy quarantine handoff—changes a buying decision.

---

## Interactive concept rationale

The redesigned mock deliberately avoids leading with “missions,” agent personas, or a Kanban board. It now tells one hypothetical identity-team story: repair a recurring enterprise SSO regression using an internal compatibility fixture without releasing the service credential. Its top-level story is three buyer outcomes:

1. **Delegate previously blocked work**
2. **Approve data, not a credential**
3. **Review with accepted evidence**

The compact walkthrough has four stages:

1. Isolated run
2. Bounded access
3. Independent verification
4. Prepare review

Stage labels are read-only explanations. They do not change approval state. The walkthrough stops at explicit human decisions, and promotion requires successful verification plus review of the actual patch finding.

The mock includes working interactions for:

- new-run choices that persist task, project, machine, policy, agent, and compatible inference endpoint;
- execution/control/inference disclosure;
- enforced policy separated from time-bound boundary observations;
- exact and transformed response digests with approver/transform lineage;
- real denial, stop, destroy, stale-evidence, and failed-verifier states;
- producer terminal inspection;
- independently invoked verifier logs, pinned inputs, verdict bytes, and explicit shared trust roots;
- an actual protected package-script diff with reject/request-change behavior;
- fail-closed promotion preparation;
- a scoped Wolfpack Git grant over a broader broker-held GitHub App token;
- persistent repository, branch, commit, PR, and quarantine-CI identities.

The mock’s values, hashes, attestations, and security controls are illustrative product requirements, not claims about the current implementation.

---

## Independent review and agreed changes

A dedicated Sol product reviewer challenged the initial redesign. Its verdict was that the workflow represented a potentially real wedge but relied on green labels and overclaimed privacy and isolation.

The review required:

1. Split execution, control-plane, and inference claims.
2. Replace absolute isolation labels with measured, time-bound boundary evidence.
3. Treat brokered response data as a separate confidentiality decision from credential protection.
4. Show immutable verifier images, harnesses, commands, logs, identities, signatures, and lineage.
5. Prevent one-click promotion over protected-file findings.
6. Replace cosmetic policy switches with versioned, read-only effective policy.
7. State the threat model, trust roots, and limitations.

The final convergence added four constraints:

- a verifier failure can never be waived by human acknowledgment;
- redaction must identify a trusted transform and prove only transformed bytes reach the guest;
- locality and probe claims must be scoped and timestamped;
- draft-PR creation must show exact repository, base, target, operation, digest, reviewers, and credential scope immediately before the action.

A subsequent read-only GPT-6 Astra review found that the strategy understated Docker and that the prior mock still allowed stage navigation to approve data implicitly, showed a file list instead of a diff, ignored New Run choices, and represented failure mainly through toasts. It recommended a narrowly bounded buyer-led falsification experiment rather than the platform roadmap. The current revision incorporates the concrete mock corrections and the material competitor/security corrections in this document; the business hypothesis remains unvalidated.

Optional work intentionally left out of the concept includes full RBAC, SIEM/audit search, SBOM and broad dependency analysis, policy simulation, arbitrary hardware placement, and production fleet management.

---

## Validation plan

Wolfpack currently has no paying-user base. The mock's first job is to recruit qualified design partners, not to manufacture validation. Do not treat mock enthusiasm, GitHub stars, free installs, friendly letters of intent, or security comfort as product-market-fit evidence.

### Design-partner recruitment sprint

Contact 20–30 narrowly targeted identity/platform teams and aim for 5–8 conversations. Ask prospects to demonstrate rather than speculate:

1. Show a recurring task recently blocked or heavily supervised because it needed a private fixture or service.
2. What exact data, credential, route, or state did the task require?
3. How is it handled today with Docker, Cursor, CI, secrets tooling, SSH, or manual review?
4. How often does it recur, and how many active engineer/reviewer minutes does it consume?
5. Who operates the worker, who approves the risk, and who owns the budget?
6. Would narrow data release change what the team permits an agent to do?

Only then show the mock. Test whether the participant can answer:

- Where do execution, control, evidence, and inference each happen?
- What exact response bytes or transformation would approval release?
- Which events are producer claims versus independently observed evidence?
- Which patch hunk still requires judgment after checks pass?
- What Git operation and downstream automation can occur?
- What remains unknown or trusted?
- Is this better than the team's strongest configured substitute, and why?

A useful unpaid design partner commits a representative repository/environment, one recurring task, an engineer, the relevant security or infrastructure stakeholder, baseline measurement, and a scheduled purchase decision. “Keep me updated” is not participation.

### Concierge thin-slice tests

Use an existing runtime, one agent/endpoint, one read-only service operation, the partner's accepted CI/harness, and a quarantine destination. Manual operations behind the interface are acceptable for learning. Test the whole outcome together rather than serially productizing components.

Measure:

- useful tasks completed out of ten representative attempts;
- install/setup and ongoing support time;
- active engineer minutes and reviewer time;
- approval count, latency, and bypasses;
- benign failures plus hostile redirects, replays, unauthorized service access, and extraction attempts;
- findings incremental to ordinary CI;
- every automation triggered by branch/PR creation;
- repeat use and willingness to fund continuation.

### Precommitted go, narrow, or stop gates

Set final thresholds against the observed baseline before running the trial, not after failure. Initial proposed gates are:

1. **Budgeted gap:** at least two qualified teams demonstrate an unmet requirement, identify an economic buyer, and accept the fixed-price pilot or deposit conversation. Otherwise narrow or stop.
2. **Useful constrained work:** install within half an engineer-day, complete at least 8/10 representative tasks without host/private-network bypass, and require at most one unplanned approval per task. Failure rejects that beachhead.
3. **Incremental evidence:** replay 10–20 historical and seeded malicious patches blind through ordinary CI and the proposed pinned path. Continue the separate verifier claim only if it finds consequential additional issues or materially reduces reviewer effort at acceptable cost, without privileged execution of untrusted changes.

If the unique value is only safe private access, persistence, or integration convenience, narrow to that result and drop the rest. If Docker/native tooling is sufficient, narrow or stop. If the verifier merely signs the same verdict more slowly, integrate existing CI rather than selling independent verification.

---

## Recommended sequence

### 1. Use the corrected mock to recruit—not to close

Run problem-first outreach and show the concept only after a prospect demonstrates its current workflow. Record claims, objections, configured substitutes, roles, and budget evidence.

### 2. Establish the strongest baseline

Configure Docker governance plus the partner's current CI/secrets/repository controls, or the relevant native-vendor private option, on the same task. Do not compare against a straw-man container.

### 3. Deliver one end-to-end concierge thin slice

Use one ordinary Linux runtime, one agent and inference endpoint, one read-only fixture operation, one existing accepted verifier, and quarantine export. Include identity, revocation, failure containment, evidence freshness, and installation burden from the start.

### 4. Ask for paid continuation

After the unpaid design-partner experiment produces a measured result, offer the $2,500 fixed-scope pilot. Payment is the exit test for discovery, not a prerequisite for initial recruitment.

### 5. Make a written go/narrow/stop decision

Productize only the component that changed task delegation, operator effort, security approval, and budget. Keep arbitrary private networking, merge/deploy, Macs requiring Xcode/signing, GPUs/devices, policy ecosystems, and fleet operations outside the first commitment.

---

## Current conclusion

Wolfpack should preserve and honestly improve durable remote supervision as the shipped product. It should not yet reposition as an agent cloud or commit to a private-agent-operations platform.

The opportunity worth falsifying is one workflow:

> **Let a team delegate a recurring private-service regression fix without exposing a reusable service credential, then return a quarantined patch with evidence the team already accepts.**

Docker governance, Cursor's private options, and existing CI/identity tooling materially weaken any claim of open competitive space. The next milestone is therefore a qualified design partner with a demonstrated blocked task—not more platform surface. Use the corrected mock to recruit that partner, compare the strongest configured substitute, deliver a concierge thin slice, and ask for paid continuation. Expand only if the boundary changes what the team delegates and the result is worth buying.

---

## Primary sources

- [Cursor Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted.md)
- [Cursor: choose where Cloud Agents run](https://cursor.com/docs/cloud-agent/self-hosted/choose-runtime.md)
- [Cursor for iOS](https://cursor.com/docs/cloud-agent/mobile.md)
- [Cursor Agents Window](https://cursor.com/docs/agent/agents-window.md)
- [Cursor Worktrees](https://cursor.com/docs/configuration/worktrees.md)
- [Cursor Cloud Agent security](https://cursor.com/docs/cloud-agent/security.md)
- [Conductor](https://www.conductor.build/)
- [Conductor pricing and cloud workspace details](https://www.conductor.build/pricing)
- [Vibe Kanban](https://www.vibekanban.com/)
- [Vibe Kanban shutdown announcement](https://www.vibekanban.com/blog/shutdown)
- [Claude Squad](https://github.com/smtg-ai/claude-squad)
- [Happy](https://happy.engineering/)
- [Omnara](https://www.omnara.com/)
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/)
- [Docker Sandboxes security](https://docs.docker.com/ai/sandboxes/security/)
- [Docker Sandboxes credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/)
- [Docker Sandboxes governance](https://docs.docker.com/ai/sandboxes/governance/)
- [Docker organization access controls](https://docs.docker.com/ai/sandboxes/governance/access-controls/organization/)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
- [E2B](https://github.com/e2b-dev/E2B)
- [Daytona](https://github.com/daytonaio/daytona)
- [microsandbox](https://github.com/superradcompany/microsandbox)
