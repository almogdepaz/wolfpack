# PR #384: behavior-preserving simplification plan

## Scope and review baseline

- PR: https://github.com/almogdepaz/wolfpack/pull/384
- Reviewed base: `998fdad7316f47889f7b84a0414999ffaa7ada0e`
- Reviewed head: `88c5c253e2e0350fc333ea32e4c97a168cf6a550`
- Review checkout: `/Users/almog/Dev/wolfpack`, branch `fix/drag-only-machine-ordering`, HEAD `d8fe1ad5f0d0654400314bb32a67885780b9a660`.
- PR source was inspected in an isolated archive at `/tmp/wolfpack-pr384-review.sUfUDH`; the checkout was not changed by the review.
- Current authorization: amend this plan, implement the six phases, verify, commit, push the PR branch, and deploy locally. Do not publish a release or restart the broker.
- Recommendations are maintainability/performance refactors, not proven merge-blocking bug findings.

The useful simplifications are primarily in orchestration, duplicated bookkeeping and repeated validation work. Security and lifecycle mechanisms should remain intact.

Before implementation, verify the current PR head and working-tree state. The paths and line anchors below refer to the reviewed head, not the unrelated checkout branch.

## Behavior that must not change

- Exact broker session UUIDs and installation identity remain authoritative.
- Scope replacement immediately aborts and disposes old mounted views and document resources.
- Registration remains inert until selection; failed mounts do not hide healthy views.
- Hidden views retain controllers, while polling follows actual visible consumers.
- Subscribers, pending one-shot readers and historical document interest remain distinct.
- Package disable/update/removal and safe mode remain effective.
- Snapshot tampering is detected; asynchronous authority boundaries are rechecked.
- Document CAS, retained idempotency receipts, quotas and canonical hashes remain unchanged.
- Acquisition bounds, archive validation and skill ownership/recovery remain intact.
- Geometry changes do not replace terminal controllers, reorder panes or steal focus.
- Existing manual/delegation geometry, mobile recovery, peek behavior and saved preferences remain observable equivalents.

## Phase 1 — remove unused bookkeeping

**Priority:** Low; safest first.

**Anchors:** `public/extension-host.ts:34`, `public/extension-host.ts:90–96`, `public/extension-host.ts:354–359`, `public/extension-host.ts:427–458`.

### Changes

- [x] Remove `viewPollerKeys` and its population, pruning and clearing code. It is maintained but does not drive lifecycle or visibility decisions.
- [x] Remove the unused `ViewOwner.unregister` field. Keep the unregister closure in the existing cleanup stack.
- [x] Consider a separate follow-up to group per-document polling state into one record rather than parallel maps; deferred to keep this change bounded.

### Acceptance

- Shared subscriptions retain correct reference counts, including reused listener functions.
- Releasing the last subscription does not cancel a pending one-shot reader.
- Releasing a visible owner does not keep a hidden same-key subscriber polling.
- Scope and package cleanup still run exactly once.

## Phase 2 — reuse bounded-file reading

**Priority:** Low for document-reader deduplication; separately verified hardening for runtime reads.

**Anchors:** `src/extensions/bounded-file.ts:4`, `src/extensions/document-contract.ts:257–287`, `src/extensions/runtime.ts:24`.

### Changes

- [x] Replace the document store's duplicated descriptor-based read loop with `readBoundedRegularFile()`.
- [x] Replace runtime's `lstat()` followed by pathname reading with the same helper. Treat this as bounded-read/descriptor race hardening, not strictly identical behavior; preserve domain error mapping and test unsafe files and growth/shrink rejection.
- [x] Keep small domain-specific wrappers for typed errors and byte limits.

### Acceptance

- Missing document records still return `null`.
- Corrupt or unsafe files still produce the appropriate domain error.
- Reads remain no-follow, regular-file-only and bounded on a single descriptor.
- Existing document/package byte limits and observed size-change rejection remain intact. The helper does not detect arbitrary same-size rewrites; package digest validation remains a separate integrity boundary.

## Phase 3 — eliminate repeated package-state reconstruction

**Priority:** Medium.

**Anchors:** `src/extensions/runtime.ts:33–47`, `src/extensions/runtime.ts:51–55`.

### Evidence

- `get()` validates the entire registry, hashing current and previous snapshots.
- `declarations()` reads each schema twice and compiles all document validators, including during catalog and asset requests.
- `setEnabled()`, `remove()` and `rollback()` obtain a registry and then call `get()`, rebuilding the same validated state.

### Changes

- [x] Pass one validated registry snapshot through each synchronous operation instead of recursively reloading it.
- [x] Read each schema's bytes once when resolving its declaration.
- [x] Separate declaration metadata from validator compilation so unrelated catalog/asset work does not compile all schemas.
- [x] If introducing validator reuse, key it by verified schema bytes and bound retention; do not trust a permanent cache solely because a registry declares a digest.

### Acceptance

- Snapshot-tampering regressions still fail closed.
- Update, rollback, disable, removal and purge behavior remain unchanged.
- Asynchronous boundaries still recheck current package/session authority rather than retaining an obsolete operation snapshot.
- Add focused assertions or instrumentation for registry validation and schema-compilation counts; do not infer performance improvement solely from smaller source.

## Phase 4 — separate scope reconciliation from catalog acquisition

**Priority:** Medium.

**Anchors:** `public/extension-host.ts:138–190`, `public/app.ts:5645–5649`, scope-change dispatch sites in `public/app.ts` and `public/app-grid.ts`.

### Evidence

`refresh()` combines scope teardown, catalog fetching, package reconciliation and rendering. Navigation can emit multiple scope-change events for one transition. Generations reject obsolete results but do not cancel their catalog acquisition.

### Changes

- [x] Separate immediate scope reconciliation from catalog acquisition/reconciliation.
- [x] Coalesce duplicate requests for one logical transition.
- [x] Cancel obsolete catalog acquisition while retaining generation/identity guards against transports that ignore cancellation.
- [x] Preserve catalog revalidation semantics for discovering disabled or updated packages.

### Acceptance

- Old scope resources are released before the next asynchronous catalog boundary.
- Obsolete responses cannot mount views or register packages in the new scope.
- Safe mode remains inert before fetch/import.
- Installed terminal-layout preferences survive ordinary scope changes and temporary catalog failure.
- Explicit disable/removal still removes the corresponding registrations.
- Add a regression asserting that duplicate transition events do not cause duplicate catalog acquisition.

**Coalescing boundary:** Immediately reconcile scope on every refresh, but share catalog acquisition for duplicate refreshes of the same scope until the response body has been read and parsed (not merely until headers arrive). Abort acquisition on scope replacement/disposal/safe mode; retain generation guards. After catalog parsing, another refresh always revalidates, even if an earlier bundle import is still pending: package disable/update must still be able to supersede that import. Keep ordinary focus revalidation. Recheck unavailable/safe-mode state even when the session UUID is unchanged.

## Phase 5 — use one host terminal-geometry authority

**Priority:** Medium.

**Anchors:** `public/app-grid.ts:233–264`, `public/styles.css:1873–1878`, `public/styles.css:1911–1922`, `public/terminal-layout-registry.ts`.

### Evidence

CSS determines default grid appearance while `existingGridGeometry()` separately reconstructs it for keyboard navigation. The SDK also provides a generic equal-grid helper with different geometry.

### Changes

- [x] Introduce one host geometry calculation used by both rendering and keyboard navigation.
- [x] Preserve explicit manual and delegation variants.
- [x] Retain the SDK's generic helper as a public composition utility; it need not become the host default.
- [x] Preserve host-specific track sizing and overflow separately from SDK relative track geometry. Delegation grids of five or more visible panes retain `minmax(220px, 1fr)` rows and scrolling; do not route this through the generic `minmax(0, ...fr)` renderer without an explicit host sizing policy.
- [x] Remove redundant CSS cardinality definitions only after equivalent rendered behavior is verified.

### Acceptance

- Preserve existing three- and five-pane manual arrangements and delegation arrangements.
- Keyboard movement follows the actual rendered geometry.
- Narrow/mobile recovery does not overwrite desktop preferences.
- Collapsed panes remain excluded from active geometry without destroying controllers.
- Geometry updates retain stable terminal nodes, focus and pane order.
- Run relevant real-browser/real-broker layout regressions, not only geometry unit tests. Include short-height delegation grids with five or more panes and assert minimum row height and scrolling.

## Phase 6 — derive widget presentation once per render

**Priority:** Medium; larger refactor, last.

**Anchors:** `public/widget-panels.ts:165`, `public/widget-panels.ts:326–438`.

### Evidence

`render()` mixes selection repair, visibility callbacks, geometry notifications, chrome movement, focus restoration and tab reconciliation. Repeated `area()` calls rebuild available-panel mappings.

### Changes

- [x] Derive a presentation snapshot once per render: membership, resolved areas, active tabs, visibility, collapse and peek state.
- [x] Apply DOM updates from that snapshot while keeping lifecycle and focus side effects explicit.
- [x] Stabilize callback-driven state before consuming the presentation snapshot. `onAreasChange` synchronously calls the workspace shell, which can call `setPresentation` and change the focused area while nested rendering is suppressed. Invalidate/recompute a stale snapshot or derive it after reconciliation callbacks; do not apply pre-callback visibility.
- [x] Keep persisted selection separate from mounted/active selection.
- [x] Keep mobile selection and peek state ephemeral rather than persisting them.

### Acceptance

- Failed mounts remain transactional and leave healthy tabs visible.
- Content nodes remain retained; only host chrome moves where currently required.
- Hover suppression, collapse-to-peek, pinning and restoration remain equivalent.
- Keyboard tab movement and focus restoration remain accessible.
- Native panels remain outside SDK registration and retained-view limits.
- Browser coverage includes desktop/mobile presentation, docking, focus, and collapse/restore flows.
- Add a regression for moving/removing the focused area during context full-view: callback-driven focus changes must affect visibility in the same completed render.

## Implementation outcome

All six bounded phases are implemented. Install-time schema validation remains eager; the validator cache retains at most 32 entries and every public operation still validates current snapshot bytes. Permanent count, file-race, pending-body lifecycle, reentrant presentation and real-broker/browser regressions are included. Generated assets were refreshed before browser verification.

See [implementation verification](pr-384-simplification-verification.md) for exact receipts and limitations. The broad local unit/snapshot gate is **not green**: three packaging-fixture timeouts occurred, and both affected fixture families also fail on the untouched PR baseline. No timeout, assertion or budget was relaxed.

## Verification strategy

Run focused checks after each phase, followed by the repository's required broad gate on the final implementation revision. Preserve existing assertions, budgets and timeouts. Independent baseline comparisons and reviewer reruns are not redundant.

The review ran this focused baseline against the isolated PR archive:

```sh
bun test \
  tests/unit/extension-host.test.ts \
  tests/unit/extension-document-polling.test.ts \
  tests/unit/context-view-registry.test.ts \
  tests/unit/extension-loader.test.ts \
  tests/unit/extension-scope.test.ts \
  tests/unit/widget-layout.test.ts \
  tests/unit/workspace-layout.test.ts \
  tests/unit/workspace-docking.test.ts \
  tests/unit/widget-visibility.test.ts \
  tests/unit/extension-layout-contract.test.ts
```

Receipt:

- Cwd: `/private/tmp/wolfpack-pr384-review.sUfUDH`.
- Source: archive of exact reviewed PR head; archive has no Git metadata.
- Exit: `0`; duration: `4.415s`.
- Reported: **124 passes, 0 failures, 0 skips**, across 10 files.
- One expected warning from the throwing-layout fallback regression.
- Run ID: `aa2c2bfe-c091-43e7-a473-e8587decd405`.
- Private artifacts: `/Users/almog/.pi/agent/workflow-runs/aa2c2bfe-c091-43e7-a473-e8587decd405/` (`output.log`, `result.json`).
- Full server/native/browser suites were not independently rerun during this review.
- GitHub test and broker checks were passing when inspected; that is external evidence, not a substitute for final-revision verification.

For implementation, add runtime/document integrity checks for phases 2–3 and relevant browser/broker suites for phases 4–6. Run typechecks and the required broad gate using the project's current verification instructions. Record failures, skips, warnings and unavailable prerequisites explicitly.

## Non-goals

- Removing exact-session identity checks, CAS/idempotency, ownership validation or recovery journals.
- Weakening acquisition/archive/schema/document resource bounds.
- Replacing retained controllers with remount-on-layout behavior.
- Deleting saved preference compatibility simply because current UI paths no longer write those values.
- Introducing a generic plugin framework or another layer of managers to achieve these refactors.
- Release publication, tagging, broker restart or dependency installation. Local server-only deployment is now explicitly authorized after verification and push; preserve broker PID and exact session identities.
