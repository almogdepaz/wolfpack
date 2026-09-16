# Frontend extension-host completion evidence

Status: **partial frontend candidate; not approval or final-gate closure.**

- Assignment/base/prepared commit: `4f943d175e3368fe60b093333d5cc35034b259a9`
- Initial candidate commit: `de067398b46fc804de6ee5c2a82ac37ab3d1bb8b`; current follow-up is recorded below after commit.
- Worktree/branch: `/Users/almog/Dev/wolfpack-ui-extensions-workspace` / `feat/ui-extensions-frontend-completion`

## Implemented and exercised

- Catalog JSON is structurally validated before it supplies host installation, package, asset, document, or storage identities. Mixed host installation identities and duplicate extension IDs fail before any bundle load.
- Package fingerprints include immutable package and UI asset identity, so a changed catalog asset cannot be treated as an unchanged loaded module.
- Per-document polling is associated with subscribing view IDs. A hidden view pauses only its own document key even when a different view remains visible; scope replacement clears package/poller resources after registry abort/disposal. Scope resolution and document envelopes now require canonical exact broker UUIDs and bounded revision identity before browser state uses them.
- Added a real broker/browser acceptance (`tests/e2e/extensions-frontend.e2e.ts`). It compiles the public CLI into an owned temp root; installs Agent Context (with its ordinary skill), Notes, and two independently installed self-contained generic packages whose local contribution ID is deliberately the same; starts an authenticated real-broker server; publishes revision 1 and 2 through the compiled CLI; validates authenticated Blob-loaded qualified views and five-second data refresh while retaining the terminal canvas. The WebKit project inclusion is explicit.

## Red/green evidence

- Existing focused baseline before edits: 9 pass / 0 fail / 0 skip, workflow run `854f5845-57cc-4faa-95dd-91675d830cb2`.
- Behavioral red after adding tests against unchanged host: 1 pass / 2 fail. The failures were hidden-view polling continued (`Expected 1, Received 2`) and mixed-installation catalog loaded 2 bundles. Run `ae0c983c-a4e2-4cd6-b34e-1cab7efbbf00`.
- Focused green/typecheck: 12 pass / 0 fail / 0 skip plus typecheck/context, run `bdd7a9f3-ccc1-4e28-81f4-428f2797b6c5`. Exact-UUID/envelope follow-up typecheck + focused 12-pass run: `c73766eb-8935-4263-8b8a-9ba8534ceaa6`.
- Browser acceptance used locally generated assets from this candidate, then restored `src/public-assets.ts` as required. Desktop Chromium pass: `ee52afb3-a238-4c22-9de1-aa5aa14110d8` (10.067s). Mobile WebKit pass: `beee2eca-1ef1-4f78-aa54-7beffd630cb7` (10.799s). Both use the authorized private broker binary and browser caches. A first test execution failed because Playwright workers are Node processes and the fixture used `Bun.spawnSync`; corrected to `node:child_process` (`7a1495ce-7de0-4549-bfc8-d57efffb104c`). A second assertion failure was a strict unscoped `h2` locator; corrected to the Agent Context wrapper (`bc1992a7-c616-4110-b98c-28406ea5dead`). Neither failure is hidden.
- Parent workspace retention probe also passed against the generated candidate: `f4c850f4-5175-485a-a39d-9a097ef60e43`.

## Still open / not claimed

This is not the requested complete frontend boundary. It does **not** close comprehensive stale import/registration races, all disable/remove/update/reinstall error permutations, all scope/surface switch flows, XSS/invalid schema/CAS browser negatives, safe-mode request absence, or the entire required integration/auth/unit/snapshot/budget gate. The generated shared asset was deliberately restored and budget measurement/cap approval has not occurred. No provider/model invocation was performed; that remains an explicit future opt-in boundary.
