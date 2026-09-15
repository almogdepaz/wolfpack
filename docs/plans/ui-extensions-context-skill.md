# Wolfpack UI extensions: context views, terminal layouts, and an agent skill

Status: implementation approved by the user ("ok lets go"); independent re-review of phase-0 candidate `0f4c4e3` returned **CHANGES REQUIRED**. The delegated test-first corrective pass failed with most findings open. The coordinator now owns the remaining implementation; the independent reviewer is retained. Production integration is not approved yet. This worktree owns the current execution handoff.

## 1. Goal and acceptance story

Make Wolfpack customizable through shareable, installable packages. Prove the design with an **Agent Context** extension containing a context tab, a terminal-layout recipe, and an Agent Skills-standard skill. A real agent loads that skill and publishes structured context; the open browser displays the new revision without reloading the page, moving focus, or restarting terminal sessions.

“Update the extension” means **update its displayed data**, not rewrite its JavaScript, inject HTML, or install new code. Code updates remain an explicit package-management operation. If agent-driven UI code generation is wanted later, that is a separate trust and development workflow.

The first sample displays a goal, plan items, decisions, blockers, and next steps. It labels them **agent-authored context**, not verified task state or execution evidence. It does not need the Pi Tasks extension or task relay.

User journey, with proposed commands:

```sh
wolfpack extensions install npm:wolfpack-extension-agent-context@0.1.0 --skills pi
wolfpack extensions list --json
```

1. Installation separately discloses browser-code trust and skill installation. No package code runs during installation.
2. The user enables the **Agent Context** contribution and explicitly applies **Lead + stack** in the layout picker.
3. The user opens a Pi session with the bundled skill available; an existing Pi session may require its normal `/reload`.
4. The user requests `/skill:wolfpack-agent-context` with an exact scope-session ID and the context to publish.
5. The agent reads the skill, reads the current document, and uses the ordinary Wolfpack CLI to publish a revision.
6. The browser shows the accepted revision automatically, while the selected terminal remains usable and focused.
7. The agent revises a plan item; the second revision appears. Reload/reconnect restores the last accepted document.

All names and API shapes below are proposals to freeze in phase 0, not claims about existing APIs.

## 2. Current handoff and source grounding

- Planning repository: `/Users/almog/Dev/wolfpack` (left on `fix/drag-only-machine-ordering`).
- Implementation worktree: `/Users/almog/Dev/wolfpack-ui-extensions`, branch `feat/ui-extensions`.
- Exact implementation base: `d8fe1ad5f0d0654400314bb32a67885780b9a660`; initial execution HEAD: `54846fbb244e47247fe7316343f6bd694d09707c` (approved plan commit).
- Worktree prerequisites: Bun 1.4.2; isolated `node_modules` installed with `bun install --frozen-lockfile --ignore-scripts` (exit 0). Private log: `/Users/almog/.pi/agent/workflow-runs/7842d31b-e541-419a-aafc-02c71f475562/output.log`.
- Existing unrelated untracked work: `docs/fleet-commander-research.md`, `docs/parallel-growth-and-discovery-plan.md`, `docs/prototypes/`. Leave it untouched.
- Local discussion session: `9e36ebec-bfd4-4092-aa12-9fb99f0c6f89`.
- UX consultation: Optimus Prime, session `a475dd42-4ef4-4225-9036-5a0d24002633`, mock v10 at `.plans/sandbox-review-mock/index.html` on that machine. Consultation used explicitly requested terminal conversation, not task-relay assignment/completion evidence. No task-relay assignment was created for that UX consultation.
- Implementer: session `0aba983a-fe91-4ca9-9616-1423ce8fae81`, endpoint `wolfpack-pi-tasks-v2` / `f56f9302-bfca-44e9-8591-a531efe9cfbf`, model `openai-codex/gpt-5.6-terra`. Phase-0 task: `49e0b838-b555-4417-b52c-e1a86ffaa5ab` (completed and parent-acknowledged as received, not approved). Code candidate: `aaf206236d51c5393c93db3acaa719fe44066423`. Implementer session is explicitly retained for the corrective pass covering the full final review; prior assignment is closed. Corrective task `35fd2dee-90cd-4b1c-8ded-226d9d959f42` completed and parent-acknowledged as received, not approved. Corrected code candidate: `0f4c4e3776b8502a64d369f6fd6e29488b09b598`; test-first correction task `ef1e5c34-4b26-4748-81d9-8aad62c852fc` FAILED and was independently inspected/parent-acknowledged. Partial code commit `25878448c90291d8f13b1c3a2a7dc144051b442f` combines three regressions with fixes; it is not the requested test-first commit sequence. Parent verified those three tests at clean HEAD `99e928a3d253d3819de9673c742eb21a2ab44ab1`: **3 pass / 0 fail / 0 skip**, run `fd910b7e-4eed-4f05-b480-8dc9dd49199e`. Most P1/P2 findings remain open. After repeated incomplete correction passes, the coordinator takes code ownership instead of repeating the same delegation. Implementer session was killed by exact stable ID and its absence verified in `wolfpack list --json`; there is no active implementation task. Coordinator session `9e36ebec-bfd4-4092-aa12-9fb99f0c6f89` owns remaining code/tests from this HEAD; retain independent reviewer for completed candidate.
- Reviewer: session `674e2e49-bbc1-4a8b-bcfd-f3f00f5826f0`, endpoint `wolfpack-pi-tasks-v2` / `9870a010-f44a-4347-896a-e8343b6b7d85`, model `openai-codex/gpt-5.6-sol`, task `c62fc301-a8d8-4255-be50-5bfa2987046a`. First review task completed with **CHANGES REQUIRED** and parent acknowledgment recorded. Read-only worktree `/Users/almog/Dev/wolfpack-ui-extensions-review` is now at exact corrected candidate `0f4c4e3776b8502a64d369f6fd6e29488b09b598`; re-review task `e7792771-5c5c-4bd8-9ea6-67c1c10d214f` completed with **CHANGES REQUIRED** and is parent-acknowledged. Reviewer is explicitly retained for the next exact candidate; no active reviewer assignment. Updated frozen dependency log: `/Users/almog/.pi/agent/workflow-runs/2e7d8afb-07ad-42dd-b1fb-d15f5bef3f93/output.log`.
- Tool preflight: Pi 0.84.4, npm 10.9.8, Rust/Cargo 1.92.0 (different from CI's pin), Zig absent from PATH, Chromium cached. Coordinator downloaded WebKit only into private test cache `/private/tmp/wolfpack-ui-extensions-browsers.DiZa4x`; installation exit 0, log `/Users/almog/.pi/agent/workflow-runs/529c0e1a-887e-4bf8-a85a-f27202a469da/output.log`. No global browser/config change. Browser installation is not test coverage.
- Independent baseline: original tracked source at `d8fe1ad5f0d0654400314bb32a67885780b9a660` passed `bun run typecheck && bun run check:context` (exit 0; no test-run counts). Private log: `/Users/almog/.pi/agent/workflow-runs/d85f22a0-fa5b-4554-b234-98ae832459ec/output.log`.
- Baseline unit/snapshot run on the original tree: `bun test tests/unit/ tests/snapshot/`, exit 1, 131.4 seconds, final top-level Bun summary **1754 pass / 1 skip / 5 fail**, 1760 tests across 167 files. Five existing xmldom security regressions fail (mixed-case script/style/textarea/title closing tags and invalid entity-reference names); the skip is the Linux no-controlling-TTY install test. Private log: `/Users/almog/.pi/agent/workflow-runs/a331235b-22ca-41fb-b774-0a8d0aea27cf/output.log`. The runner's aggregate 1771 pass includes nested summaries and is not the top-level total. Isolate these baseline failures under frozen worktree dependencies before attribution; do not silently fix or waive them.
- Allowed now: phase-0 contract code/tests and isolated loader/storage/compiled-browser spikes; then implementation phases after independent contract review. Scoped worktree dependency changes and test fixtures are allowed. No production service/broker restarts, global skill/package installation, unrelated worktree changes, npm publication, or automatic task-relay repair.
- Real-agent test uses isolated configuration and approved model access; do not copy credentials into artifacts. Missing prerequisites remain blocked rather than passing via simulation.
- Initial reviewer constraints received and forwarded to implementer. Read-only artifact: `/Users/almog/Dev/wolfpack-ui-extensions-review/.plans/review-ui-extensions-contract.md`, reviewed baseline `54846fbb244e47247fe7316343f6bd694d09707c`. No candidate approval yet. Important refinements: static contribution identity versus post-load registration, compiled standard parser/validator tooling, complete-operation idempotency and durability, and explicit phase-1 terminal-retention obligations.
- Parent candidate checks at `aaf206236d51c5393c93db3acaa719fe44066423`: 11 focused tests passed, 0 fail/skip; typecheck and context check passed. Log `/Users/almog/.pi/agent/workflow-runs/e3cade20-b301-441d-a807-aa5a9c430ff8/output.log`.
- Parent WebKit rerun on that exact candidate FAILED (one test, 30-second timeout), not missing executable. Log `/Users/almog/.pi/agent/workflow-runs/987f450a-1db9-486f-8556-77cbe8f989a0/output.log`; trace under `tests/e2e/test-results/extension-loader-spike.e2e-49181-er-works-under-reviewed-CSP-mobile-webkit/trace.zip`. Browser DOM/trace reached `loaded`; fixture teardown/keepalive is suspected, not yet confirmed. Negative auth/digest/response-limit/safe-mode and compiled-host proofs remain absent.
- Parent contract probes on that exact candidate: 0 passed / 3 failed, exit 1. Confirmed numeric-leading installation UUID rejected despite canonical UUID installation identity; nested `$ref` accepted despite declared no-ref contract; unchanged owned skill refuses legitimate new-content upgrade as `modified`. Private reproducible command/log: `/Users/almog/.pi/agent/workflow-runs/039da944-56a5-497f-b9cb-ad561059f49c/` (`result.json`, `output.log`). These are extension-candidate defects, distinct from baseline xmldom failures.
- Final review artifact snapshot: `.plans/review-ui-extensions-aaf2062.md` in this worktree (copied from reviewer artifact; code reviewed exactly `aaf206236d51c5393c93db3acaa719fe44066423`). Blocking groups: loader bounds/auth/safe mode/compiled-browser evidence; authoritative UUID + strict persisted record/full-operation idempotency; bounded standard schema policy; skill inventory/ownership/clean upgrades; package SRI/standard SemVer/stream bounds/immutable inspect-extract; layout version/cardinality and normalized manifest paths.
- Reviewer independently confirmed focused 11/11, typecheck/context, compiled AJV and Chromium pass; WebKit timed out. Frozen-dependency broad run: **1769 pass / 1 skip / 1 timeout**, command exit nonzero; isolated release-smoke rerun **6/6 pass** does not make the broad run green. Original-tree xmldom failures passed under reviewer frozen dependencies; this is an environment-dependent baseline distinction, not an extension fix. Broad log `/Users/almog/.pi/agent/workflow-runs/19d36af1-6ecc-4ca3-b979-f6eb0c006809/output.log`; isolated log `/Users/almog/.pi/agent/workflow-runs/c58dcb75-4fc7-4a02-9dcf-aa989f40682c/output.log`. Reviewer bundle budget check lacked generated browser assets; generation must precede rerun, not a coverage pass.
- Corrected-candidate parent checks at `0f4c4e3776b8502a64d369f6fd6e29488b09b598`: 11 focused tests passed, 0 fail/skip; typecheck/context passed. Log `/Users/almog/.pi/agent/workflow-runs/78feae79-2c75-4ac3-b081-6ff448f966cc/output.log`. Implementer browser logs independently inspected: Chromium pass `ac262d55-3166-4ac1-bbdc-ac82b1582eab`, WebKit pass `f87e7209-c193-4e7a-a8c5-696b2288b316`; earlier combined run `1e7a99f4-75db-4500-966c-1562bb562507` still exited nonzero on Chromium missing from WebKit-only cache. Broad/integration gates were not rerun by implementer.
- Four parent correct-behavior probes FAIL on corrected candidate (0 passed / 4 failed): normal schema property named `pattern` rejected; user-added skill file deleted on package upgrade; `store.read` accepts a mismatched stored scope key; loader deadline ends at headers, leaving stalled body unbounded in time. Complete reproducible command and log: `/Users/almog/.pi/agent/workflow-runs/e247611a-af1a-40fa-9f11-83117c8f8b81/`. No source edits or global mutations from probes. Forwarded to reviewer; these are candidate defects, not baseline failures or later-phase integration obligations.
- Final second-review artifact: `.plans/review-ui-extensions-0f4c4e3.md` (immutable copy). Original UUID/nested-ref/clean-upgrade/SRI/duplicate-tar/layout-cap/browser repros closed. Remaining findings: schema-position/work-bound errors; incoherent cross-scope receipts and read identity; skill extra-file loss/path aliases/removal/swap recovery; loader body deadline/hard cap; archive prompt-abort/immutable extraction; standard canonical versions/malformed layouts; contradictory contract claims. These cannot be deferred as future integration.
- Second-review verification at exact `0f4c4e3`: focused **11/11**, typecheck/context, compiled dependency smoke, Chromium **1/1**, WebKit **1/1**, generated assets/budget all passed. Broad `beab4b52-62bf-4916-a477-b42d7837d3a1`: **1769 pass / 1 skip / 1 timeout**, exit nonzero. Isolated release-smoke `4773b44f-9e61-41fb-8940-838043ae4f85`: **5 pass / 1 timeout**, exit nonzero; do not replace this with the older 6/6 pass. Full logs under `/Users/almog/.pi/agent/workflow-runs/`; per-command IDs and independent negative probes in report. Compiled smoke only proves AJV/SemVer dependencies, not the compiled browser asset host or archive extraction; integration suite not run.
- Parent baseline attribution: exported exact base `d8fe1ad5f0d0654400314bb32a67885780b9a660` release-smoke source into an owner-private temporary directory, with original timeout and offline fixture npm calls. Same first-test 5000ms timeout reproduced: **5 pass / 1 fail**, exit 1. Run `/Users/almog/.pi/agent/workflow-runs/8f1202fc-470e-469f-96ef-6278756200cd/` contains full command/log. Relevant test/script/alias/preload sources have zero diff from base to `0f4c4e3`; no external dependencies were needed for this fixture. Temporary source cleaned, original tree untouched. This establishes a baseline failure, not a broad-gate pass; no timeout was enlarged or test disabled.
- Next handoff: coordinator implements remaining corrections with genuine failing-before/fixed-after coverage. `.plans/ui-extensions-correction-closure.md` currently records an incomplete pass, not approval. Preserve the existing regression successes, inspect exact final code/logs, then assign independent re-review before production integration approval. Keep phase 0 bounded to contracts/feasibility; later phases own integrated store/installer and real-terminal guarantees. Keep this section current; detailed contracts and verification reports are artifacts, not additional task-state ledgers.

Read `edc-context/index.md` and owning module documents before implementation. Inspected source establishes these starting points:

| Existing owner | Relevance |
| --- | --- |
| `public/app.ts`, `public/app-state.ts` | Large imperative orchestrator; settings are currently browser-local. Add adapters, not more plugin state inline. |
| `public/app-grid.ts` | Reuses grid cells/controllers in some transitions, but collapsing/suspending currently disposes controllers. Retention requirements need real changes and tests; do not assume they already hold. |
| `public/pty-terminal-controller.ts`, `public/terminal-resize-lifecycle.ts` | Host must retain ownership of terminal lifecycle and resize. |
| `public/browser-auth.ts` | Bearer tokens are per-origin in sessionStorage and added to fetch. Plain dynamic `import(url)` cannot attach these headers. |
| `src/server/index.ts`, `src/server/http.ts`, `src/server/routes.ts` | Auth/origin/rate boundaries and static serving. CSP currently permits self/nonce scripts, not blob modules; static fallback only handles top-level files. |
| `src/cli/api.ts`, `src/cli/machine-target.ts` | Canonical CLI auth and verified machine routing. Reuse these instead of private HTTP scripts in the skill. |
| `src/cli/session-control.ts` | `current-context` currently returns name/project directory, not a trustworthy stable current-session ID. Do not invent an env-ID guarantee. |
| `src/cli/pi-integration.ts` | Existing explicit, consented Pi skill installation. Do not couple the new sample to installing Pi Tasks. |
| `scripts/gen-assets.ts`, `scripts/build.ts`, `package.json` | Core assets are embedded in compiled binaries. Third-party packages need runtime storage/loading and must work outside a source checkout. |
| `playwright.config.ts`, `.github/workflows/test.yml` | Isolated browser fixtures, desktop/mobile shards, generated-asset/bundle gates, and isolated auth tests. |

## 3. Scope and decisions

### Included

- Namespaced context-view registry, per-view enable/order settings, lifecycle and visibility hooks.
- Host-owned terminal layout recipes: equal grid, lead + stack, and vertical stack; responsive fallback.
- A bounded workspace shell: context right, left, or bottom; constrained split sizing, collapse/restore, and full view.
- Local-directory and exact-version npm package installation; compatibility, integrity, explicit updates, rollback, disable/remove, and safe mode.
- Static bundled skills with an explicit Pi installation adapter; framework-neutral skill format and CLI publication protocol.
- A minimal, server-owned extension document store with validated JSON, exact-session scope, revision conflicts, and idempotent publication.
- Agent Context reference package and deterministic plus real-agent acceptance tests.

### Deferred

- Arbitrary docking, nested layout trees, unrestricted CSS as a layout API, and replacement terminal engines.
- Untrusted-code sandboxing, a marketplace, Git-source installs, runtime dependency graphs, arbitrary backend plugins, and install lifecycle scripts.
- Automatic project-local extension discovery/execution or fleet-wide package/skill synchronization.
- Effort membership services, immutable Git snapshots, captured verification evidence, and durable harness-log anchors. Those are later services required to complete the UX mock, not prerequisites for the context-data demonstration.
- Automatic skill setup for every harness, agent-driven code installation, and arbitrary agent-generated HTML/JavaScript.

### UX invariants from the consultation

- Terminals remain primary; the extension is not a second agent chat interface.
- Lead-first is an explicitly selected workspace preference. Installing Notes/Evidence must not change terminal presentation.
- Subagents appear as available members but only explicit user action opens their panes. Data updates and membership changes do not steal focus or change the selected context tab.
- Each shell region owns its collapse control and an accessible restore affordance. Never hide both regions without a recovery control.
- Tab changes preserve draft/selection/scroll state. Layout changes preserve session IDs, terminal instances, selection, buffers, and drafts while still using normal authoritative resize handling.
- Display the scope and revision actually represented. Future snapshot views must not silently imply that all tabs refer to the latest working tree.
- “Unavailable,” “not run,” and “failed” are different claims. Agent-authored context cannot be promoted to execution evidence.

## 4. Architecture

```text
installed package
  ├── browser bundle ──> context-view/layout registries ──> host shell
  ├── static data schema ──> core extension document service
  └── SKILL.md ──> agent ──> wolfpack extension-data CLI
                                 │
                          existing authenticated API
                                 │
                       validated revisioned document
                                 │
                    visible-view read/subscribe adapter
                                 │
                           context tab updates
```

### 4.1 Package and SDK contract

Use a normal `package.json` with a static `wolfpack` manifest:

```json
{
  "name": "wolfpack-extension-agent-context",
  "version": "0.1.0",
  "keywords": ["wolfpack-extension"],
  "wolfpack": {
    "manifestVersion": 1,
    "apiVersion": 1,
    "id": "agent-context",
    "ui": "dist/ui.js",
    "skills": ["skills/wolfpack-agent-context"],
    "documents": [
      { "id": "context", "schemaVersion": 1, "schema": "schemas/context.schema.json" }
    ]
  }
}
```

- Extension identity is stable and bound to package provenance. Contribution IDs are qualified by that identity. Reject conflicting ownership, duplicate contribution IDs, and unsupported API versions.
- Publish one self-contained browser ESM bundle with a default registration function. Bundle dependencies ahead of installation; no bare imports, remote modules, or install-time builds in v1. Bundle CSS/assets needed by the reference package as well.
- Expose a small authoring SDK/types entry point and examples. Use DOM mount/unmount as the boundary; do not require React or introduce a UI description language.
- Treat local installs as validated snapshots too. Editing their source does not silently execute new browser code; an explicit local refresh/update activates new bytes.
- The host validates declared file paths, schemas, contribution bounds, and package compatibility without importing package JS into the server/CLI.

### 4.2 View lifecycle and context

Proposed surface:

```ts
registerContextView({ id, title, mount(container, context) });
registerTerminalLayout({ id, title, arrange(layoutContext) });
```

- Registration occurs through an extension-scoped host object; registrations and subscriptions are automatically tracked for teardown.
- `mount` returns a controller with `dispose()` and optional `setVisible(boolean)`. Context exposes an abort signal, read-only selection, namespaced UI storage, theme tokens, and narrowly typed data operations.
- Lazy-mount a view on first selection. Keep visited views mounted but hidden within the current scope; notify hidden views and pause host-managed polling/work. Preserve a bounded number of views, with a documented contribution limit rather than silent arbitrary eviction.
- On scope change, dispose old scope resources before mounting the new scope. Persist drafts/selection/scroll by extension + scope when they should survive navigation.
- Revisions update view content, not extension registration or the whole workspace. A sample update must not replace a focused editor element.
- Disable/remove disposes the affected views and registration handles once; other views and terminals remain usable. Async results carry a generation/scope guard and cannot repaint a newly selected scope.
- Catch mount, arrange, event, and cleanup errors and show bounded diagnostics/fallbacks. Same-thread trusted JS can still block or corrupt the app; these are robustness measures, not isolation.

### 4.3 Layout recipes, not terminal DOM ownership

- The host provides stable pane references for **already opened** terminals, the selected lead, viewport constraints, and selected layout options.
- `arrange` returns a bounded placement description: tracks plus pane row/column spans. No raw selectors, HTML, CSS injection, session creation, attachment, or focus effects.
- Validate finite sizes, maximum tracks, nonoverlap, unique known pane IDs, and exactly one placement for every opened pane. Reject hidden/dropped/duplicated panes; fall back to the last valid/built-in layout.
- Ship SDK helpers for equal grid, lead + stack, and vertical stack. A third-party recipe can compose supported track/span primitives without manipulating terminal internals.
- Host applies geometry in the existing stable terminal containers and uses the current resize controller. Do not reparent canvases between extension containers or dispose/recreate controllers merely to rearrange panes.
- Keep visual order, DOM accessibility order, and keyboard navigation consistent. Exercise focus/selection preservation if host-level ordering must change.
- Shell choices (context left/right/bottom, split size, full view) are separate from grid recipes. Users explicitly select both, persisted per browser and installation/scope as appropriate.
- First supported integration surface: the existing session/delegation workspace. Dashboard-wide arbitrary widgets and cross-origin terminal layout orchestration are not part of this slice.

### 4.4 Runtime installation, loading, and trust

Proposed CLI: `wolfpack extensions install|list|enable|disable|update|remove|rollback`, plus explicit per-view preferences in the UI. Keep installation local-host and CLI-owned in v1; remote package installation is not silently inferred from a selected browser peer.

- Store packages outside embedded assets under an owner-private extension root with an install registry, immutable version directories, and separately retained data.
- For npm, require an exact version, retrieve the package without scripts, and validate integrity. Preflight the chosen package-fetch tool on compiled installs; do not assume a source checkout or global Bun CLI. Secure extraction must reject traversal, escaping symlinks/hardlinks, unexpected file types, oversized archives, and excessive files.
- Stage/validate first, atomically activate after success, and retain the prior version for explicit rollback. Failed installs leave the active version untouched. Updates preserve contribution choices. Schema-breaking updates are refused in v1 rather than executing migration code.
- Install browser code and bundled skills only after separate explicit trust choices. No sandbox/capability-enforcement claims for trusted same-origin JS or skills that can run shell commands.
- Use authenticated `/api/extensions/...` asset endpoints, not arbitrary filesystem serving. Keep metadata, JS allowlists, declared schemas, and skill source exposure distinct. No tokens in URLs or copied into packages.
- Browser loader spike: authenticated fetch of a bounded self-contained bundle, verify the expected digest, then import a Blob URL and revoke it after load. This requires an explicit reviewed `script-src blob:` CSP change. Do not add `unsafe-eval`, weaken data-route auth, or silently fall back to unauthenticated imports. Prove Chromium and WebKit behavior before freezing this choice.
- Native import cannot attach Wolfpack's bearer header; make this an early technical gate, not a late packaging surprise. If the Blob approach fails the CSP/security review, select and document a different authenticated loader before proceeding.
- Exclude extension documents and authenticated asset responses from the service-worker cache in v1. Versioned in-memory module loading is separate from persisted context data.
- Safe mode must prevent extension JS loading through a host-controlled preference/recovery path. Disabling server delivery cannot revoke already-running malicious JS; recovery may require a safe-mode page reload. That is distinct from ordinary benign view disable/cleanup.
- Package enablement/data schemas live on the host. Individual tab visibility/order and layout choice remain browser-local initially. Browser-host packages do not auto-load code discovered on a peer.

### 4.5 Agent-to-view document service

Do not have agents edit served HTML, the installed bundle, or the store files directly. Provide one small generic document primitive, independent of task relay.

Proposed commands:

```sh
wolfpack extension-data read agent-context/context --session <scope-session-uuid> --json
wolfpack extension-data publish agent-context/context \
  --session <scope-session-uuid> --file ./context.json \
  --if-revision <revision> --request-id <uuid> --json
```

- Scope v1 by `(owning installation, exact scope session UUID, extension ID, document ID)`. A child can publish to an explicitly supplied parent/lead scope. Do not invent a new effort model or use project names/reusable session names as storage keys.
- Require the exact scope UUID and validate it with the authoritative backend. The bundled skill never guesses the scope from terminal text or blindly treats `current-context`'s name as a stable ID. Initial acceptance supplies the scope UUID explicitly.
- Reuse verified `--machine` routing for supported data commands; no localhost fallback. A local UI contribution may display data from a selected verified peer that supports the same document API/schema; missing installation/support is explicit, and remote package bytes are never automatically executed.
- Reads can retain a document after its session exits. New writes require a live exact scope in v1. A recreated same-name session starts empty under its new UUID.
- Core validates JSON body size, schema version, nesting/string/item limits, declared document ownership, and static package schema. Resolve schemas from installed allowlisted files only; no executable validators or network `$ref` resolution. Select a pinned validator compatible with compiled distribution in phase 0, rather than inventing a schema language.
- Use bounded full-document replacement with compare-and-swap revision checks. Revision 0 means no document yet; successful writes increment monotonically. Conflicts return the current revision and require read/reconcile, not automatic blind overwrite.
- Persist accepted content and a bounded idempotency receipt atomically in the same record. Same request ID + same payload/base returns its original receipt; changed payload under the same retained ID fails. Document retention/receipt bounds and behavior after receipt eviction; no exactly-once claim beyond retained receipts.
- Serialize writes per document, use owner-private atomic file replacement, and surface corruption explicitly. Do not share the task-relay persistence/lifecycle implementation. Cap total documents/bytes; refuse with an actionable quota error rather than silently evicting data.
- Receipt includes scope, document ID, revision, server acceptance time, and payload digest. It proves **stored**, not **rendered**, not **verified**, and not that an agent acted on the content.
- The existing global auth policy remains the security boundary. Namespaced storage and exact-ID checks prevent collisions/misrouting, not malicious authenticated users. A supplied submitting-session ID is attribution, not cryptographic proof of authorship or tool execution.
- Example content: `schemaVersion`, `goal`, stable-ID plan items with explicit statuses, `decisions`, `blockers`, `nextSteps`. Render user/agent strings as text; if Markdown is later enabled it must be sanitized with raw HTML disabled.
- Generic browser `subscribe` starts with a read, then coalesced revision-aware polling (2 seconds initially), pauses hidden/offline, and refreshes on visibility/reconnect. One poll per active scope/document shared across subscribers; exponential backoff on failures. No terminal-output subscription, attach, or resize for context reads.
- This deliberately avoids SSE/WebSocket infrastructure in v1. Connected visible views should show an accepted revision within 5 seconds under the controlled test environment; hidden views should catch up on activation.

### 4.6 Bundled skill installation and behavior

Reference package layout:

```text
examples/extensions/agent-context/
  package.json
  src/ui.ts
  dist/ui.js                     # produced/published, not hand edited
  schemas/context.schema.json
  skills/wolfpack-agent-context/
    SKILL.md
    references/context-format.md
  README.md
```

- The skill is a normal Agent Skills-standard directory. No Pi runtime extension, task endpoint, or background helper is required.
- Explicit `--skills pi` installs only manifest-declared skills into an installer-owned location under Pi's supported skill discovery path. Track ownership and source digest; refuse collisions or overwriting user-modified files. Never alter unrelated skills or global Pi Tasks settings.
- Browser-package activation and Pi skill deployment report separate statuses. A partial skill failure is visible and retryable, not a falsely successful all-or-nothing install. Updates/removal clean only owned unchanged files; already-loaded Pi instructions require reload/new session to stop being present.
- Use stable, unique skill names. Package updates preserve ownership mappings and do not leave duplicate discovered copies. Disabling a context view does not silently disable the skill or erase data; package-wide disable makes publish fail explicitly.
- Existing Pi sessions require the normal `/reload` or a new session. Installer prints that requirement; never inject commands into a live agent automatically. No launch changes or task-worker readiness changes are required for this slice.
- Skill workflow: obtain the supplied exact scope ID; verify scope/project; read current revision; construct bounded JSON; publish with a fresh request ID and expected revision; report accepted revision or a concrete error. On conflict, re-read and reconcile without dropping another agent's updates.
- Skill content teaches the provenance boundary: summarize requested work, do not claim tests passed, do not fabricate evidence links, and do not publish secrets or raw transcripts. The browser does not execute the document as instructions.
- The acceptance test must show actual skill loading and CLI publication by a real agent, not just a fake harness printing the expected command. Absence of credentials/model/Pi is a disclosed blocker for that gate.

## 5. Implementation phases and review boundaries

### Phase 0 — Freeze the contract and resolve loader/storage spikes

Deliver: versioned manifest/SDK/document envelopes; complete lifecycle rules; exact CLI shapes and errors; trust/skill disclosure; minimal reference schema; runtime loader and schema-validator decisions verified in an isolated compiled-host/browser spike.

Explicitly settle: package retrieval/extraction tooling on supported installs, CSP Blob-module behavior, storage/receipt quotas and failure durability, pane/track bounds, and supported Pi skill path/version. Do not change user installations to run the spike without approval.

Exit: reviewer agrees that the slice supports independently installable tabs **and** grid recipes, and that agent publication is data-only. No unresolved auth or terminal-retention dependency is hidden behind a UI mock.

### Phase 1 — Host-owned shell and terminal layout adapter

Add focused modules, proposed `public/workspace-shell.ts`, `public/terminal-layout-registry.ts`, and `src/extensions/layout-contract.ts`. Integrate narrowly with `public/app-grid.ts`, `public/app.ts`, `public/index.html`, and `public/styles.css`.

Implement existing behavior as a built-in recipe first, then lead + stack and vertical fallback. Add context placement/collapse/fullscreen without changing broker protocol. Preserve controllers for geometry-only transitions; keep existing close/ended/displaced semantics explicit. Retain terminal buffers/selection across supported hide/restore paths without sending zero-sized geometry or creating hidden new attaches.

Exit: deterministic layout validation and real-broker/browser tests prove no geometry-only controller recreation, no focus theft, stable identities, valid ordered resize, keyboard access, and mobile recovery.

### Phase 2 — Context-view registry and runtime package loader

Add proposed `src/extensions/manifest.ts`, `public/extension-host.ts`, `public/context-view-registry.ts`, and `src/server/extension-routes.ts`. Wire the server through existing auth/routing; do not broaden arbitrary static file access.

Use an explicit local fixture package first. Implement lazy mount, visited-view retention, generation guards, user ordering, errors/fallback, enable/disable, safe mode, and the reviewed authenticated loader. Add SDK/types publication through the normal root/platform package pipeline without requiring consumers to clone Wolfpack.

Exit: two independent fixture packages can contribute views and layouts, preserve selection/state, and coexist without registration collisions or installation-time activation theft. A broken extension leaves built-in recovery controls available.

### Phase 3 — Versioned document service and CLI

Add proposed `src/extensions/document-contract.ts`, `src/extensions/document-store.ts`, `src/server/extension-data-routes.ts`, `src/cli/extensions.ts`, and `src/cli/extension-data.ts`. Add schema definitions in `src/control-api/schema.ts` and regenerate the published schema.

Implement authenticated read/publish, static schema validation, exact scope, revision/CAS/idempotency, bounded persistence, disable behavior, and shared browser polling. Extend supported machine-command routing explicitly and test failures without guessing endpoints.

Exit: concurrent publishers do not lose updates; cross-scope data cannot leak through caches; restart restores accepted data; malformed data cannot replace the last good revision; no task relay participates.

### Phase 4 — Install/update/rollback and bundled skills

Complete local-snapshot/npm installation, secure extraction, integrity/compatibility, registry transactions, explicit activation/rollback, uninstall retention, skill deployment ownership, and list/status output. Use existing `src/cli/pi-integration.ts` patterns without making the new feature install Pi Tasks.

Update release packaging and developer scaffolding as needed. npm packages contain prebuilt UI and static skill/schema files; neither development builds nor install scripts execute during installation. Do not publish to npm as part of implementation without separate release approval.

Exit: the same fixture tarball installs in a temporary home using a compiled Wolfpack artifact, outside the repository, with no global Bun compiler requirement; updates and rollback preserve supported data and user layout choices.

### Phase 5 — Agent Context reference extension + skill

Implement the independently packaged example with context data rendering, clear scope/revision/stale/provenance states, and a lead + stack recipe using only the public SDK. Bundle the skill and format reference. Include an explicit user-applied preset combining the context view and recipe.

The sample must not import `app-state`, broker internals, private server code, or rely on privileged built-in-only hooks. Show it next to a separate Notes fixture to prove composition, not just a hardcoded demo slot.

Exit: deterministic installation → CLI publication → browser update acceptance passes, and the real-agent test is ready for an explicitly approved model/tool environment.

### Phase 6 — Real-agent acceptance, independent review, and release documentation

Run the exact user story below. Document extension authoring, installation trust, skill discovery/reload, scope targeting, persistence/conflicts, layout limitations, safe mode, compiled artifact behavior, and explicit deferred features.

Update EDC routes through the owning context workflow when new source/example paths require mapping; do not hand-edit generated context or bundles. Existing `src/**`/`public/**` paths already route; proposed `examples/**` requires an explicit mapping/policy decision.

Exit: all required gates on the final revision, independent reviewer rerun of the new vertical slice and terminal preservation regression, and an evidence handoff with real counts/skips/artifact paths. Do not claim completion of the full Changes/Evidence UX mock.

## 6. Acceptance tests

### A. Deterministic end-to-end test — required in CI

Use isolated temporary homes/ports and the actual packaged extension, CLI, HTTP service, and browser loader. Test fixtures may supply terminal sessions but must not bypass installation or write directly into the store.

1. Install the package with the Pi adapter pointed at a disposable skill directory; verify manifest, digest, enabled contributions, skill contents, and ownership record.
2. Open two independent session scopes. Enable the tab and apply its layout explicitly; confirm neither installation nor a new member changes focus.
3. Publish revision 1 to scope A through `wolfpack extension-data publish`, then assert the browser's scope, content, and revision through accessible DOM.
4. Publish revision 2; within the controlled 5-second deadline it appears without page navigation or terminal controller replacement.
5. Scope B stays unchanged. Switch away/back and reload the browser: scope A restores revision 2 and saved UI state.
6. Switch tabs, hide/show context, change split placement and grid recipe, resize to mobile, then restore. Verify selected terminal, drafts, and opened-pane set remain correct.
7. Stop/restart only the isolated server. The persisted document returns; broker session UUIDs stay the same. Existing sockets may reconnect on server restart—do not incorrectly assert socket continuity across this step.
8. Disable/re-enable the contribution: no polling/subscription leak and data retained. Remove/reinstall package: retained data policy is honored; explicit purge is separate.

### B. Real-agent skill round trip — required before feature acceptance

Prerequisites: real Pi, approved model credentials/access and invocation budget, isolated Wolfpack/broker/home, installed sample skill, browser, and fixed exact scope session ID. This is a dedicated opt-in integration gate, not a model-dependent ordinary unit test.

1. Install the same package using the real skill adapter in a disposable Pi agent directory. Start a normal Pi session with a supported skill-discovery path; do not rely on task-worker mode or Pi Tasks.
2. Invoke the installed skill with the target scope UUID and a harmless fixed task: publish goal “Implement extension prototype,” one pending plan item, and one blocker.
3. Record structured Pi session/tool records showing the skill was loaded and the ordinary CLI publication executed successfully. Do not infer tool success from rendered terminal text or an agent's final message.
4. Independently read the document through the CLI/API and assert the browser rendered the same scope/revision/content. A publication receipt alone is not browser evidence.
5. Ask the agent via the skill to mark the plan item complete and change the next step. Assert a new accepted revision and corresponding browser update; keep focus in the terminal throughout.
6. Preserve private evidence: package integrity, skill digest, invocation/model identity, structured tool records, CLI receipts, browser assertions/trace, session identities, and cleanup verification. Redact secrets and do not publish transcripts automatically.
7. Missing prerequisites are **blocked/skipped, not passed**. A mock agent or direct test CLI call passes test A only and cannot satisfy B.

### C. Required negative and regression coverage

- Manifest/API incompatibility, duplicate ownership/IDs, invalid layout geometry, unknown/duplicate/missing panes, nonfinite sizes, excessive contribution counts, and recipe exceptions.
- Auth disabled/enabled modes, rejected credentials/origins, unauthenticated bundle/data reads, CSP behavior, service-worker cache exclusions, verified peer failures, and no token in URLs.
- Hostile archive paths/symlinks/hardlinks, excessive decompressed size/files, integrity mismatch, unsupported runtime imports, failed install/update, rollback, and user-modified skill ownership collisions.
- Invalid JSON/schema/oversize/depth, XSS payload rendered as inert text, stale revisions, same-request retry after dropped response/restart, changed payload under reused ID, and explicit receipt-eviction behavior.
- Concurrent writers, store corruption/write failure/quota exhaustion, schema-incompatible update, disabled document writes, removed/ended scope writes, and same-name session reuse.
- Late response after machine/session/tab switch, hidden polling pause, coalescing, disconnect/backoff/catch-up, old data shown as stale, and cleanup exactly once.
- Layout/split/fullscreen changes while typing or selecting terminal text; no duplicate PTY attach, no new take-control, no controller recreation merely for layout, valid resize/input order, mobile keyboard behavior, and restore focus.
- Context unavailable/empty/agent-authored states; no fabricated success badges or log anchors. Skill not installed/reloaded produces an actionable message rather than a claim that the agent used it.

## 7. Verification commands and evidence policy

Planning-only checks are separate from implementation validation. On the final implementation revision, use `run_check` with private full logs and preserve real failures/skips/timeouts. Do not cache by command or HEAD.

Focused checks during phases: new extension unit/integration suites, the new deterministic extension E2E, grid/delegation/lifecycle/reconnect/accessibility tests on desktop and mobile, and compiled package smoke coverage. Add proposed files such as `tests/unit/extension-manifest.test.ts`, `tests/unit/extension-documents.test.ts`, `tests/integration/extension-api.test.ts`, `tests/integration/extension-package-install.test.ts`, `tests/e2e/extensions.e2e.ts`, and `tests/e2e/extension-skill-roundtrip.e2e.ts`.

Final broad gate must preserve current CI behavior in `.github/workflows/test.yml`, including:

```sh
bun run check:context
bun run scripts/gen-assets.ts
# Compare generated assets/schema with the checked-in final revision after generation.
bun run typecheck
bun test tests/unit/ tests/snapshot/
# Explicit integration shard: every *.test.ts except auth-middleware.test.ts.
# Run auth-middleware.test.ts separately because JWT env/module state contaminates peers.
bun test tests/integration/auth-middleware.test.ts
bun run check:bundle-budgets
```

Also run the CI critical desktop/mobile Chromium and WebKit shards, the new extension/layout suites, compiled-install smoke tests, and current terminal-load budget checks. Ensure the WebKit testMatch/grep configuration actually includes the new tests; naming a spec is not coverage if project filters exclude it. Use real broker prerequisites for the terminal invariants; missing broker/browser/Pi prerequisites remain explicit. CI's pinned native build/broker tests and existing release checks must stay green even though no broker protocol changes are planned.

Generate schemas from `src/control-api/schema.ts`, browser bundles/assets from source, and package tarballs from the normal build pipeline. Never fix generated output manually. A compiled install test must not accidentally resolve SDK/source files from the checkout.

Record exact command/cwd, base/head and dirty state, duration, reliable pass/fail/skip counts, and private artifact references. Run the real-agent acceptance separately with model/network authorization; its result is required for the final user-facing claim.

## 8. Definition of done

- A separately packaged context view and layout install without rebuilding Wolfpack.
- A package can bundle a usable skill, with explicit consent, ownership-safe updates, and honest reload behavior.
- A real agent demonstrably uses that skill and the public CLI to update visible context twice.
- Data-only updates, tab switches, and layout changes preserve terminal operation and user focus.
- Revisions, persistence, scope isolation, conflicts, offline/stale behavior, safe mode, and cleanup are tested.
- The example uses only public extension interfaces and works from a compiled installation outside the repo.
- Deterministic CI, real-agent acceptance, terminal regressions, and independent review have recorded evidence; skips do not satisfy their corresponding claims.
- Full evidence capture, durable session-log anchors, and the complete mock remain explicitly out of scope rather than being simulated as finished features.
