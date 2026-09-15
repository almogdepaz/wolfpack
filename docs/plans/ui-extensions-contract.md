# UI extensions phase-0 contract gate

Status: **ready for independent contract review**. This artifact freezes phase-0
interfaces only; it does not wire extension code into the server, CLI, browser
workspace, or a user Pi installation.

## Frozen public contracts

- `src/extensions/manifest.ts` accepts package metadata only, never imports UI
  code. `wolfpack.manifestVersion` and `apiVersion` are both `1`; IDs are stable
  lowercase identifiers; UI/skill/schema paths are package-relative and cannot
  escape; document contribution IDs are unique. Package versions are exact.
- `src/extensions/sdk.ts` defines a DOM mount/unmount view boundary and a
  geometry-only layout registration boundary. The host owns terminal DOM,
  authentication, attachment, focus, resize, and lifecycle. A view gets an
  abort signal, read-only scope/selection/theme, namespaced UI storage, and
  document reads/subscriptions—not a token, filesystem, or terminal object.
  Lazy mount/hidden retention/scope disposal/generation guards/error cleanup
  rules are versioned there. Future host implementation must bound retained
  visited views and report fallback diagnostics.
- `src/extensions/layout-contract.ts` freezes a finite placement language:
  at most 64 existing panes and 12 rows/columns; finite positive track values;
  one non-overlapping placement for every known pane. It provides reusable
  equal-grid, lead-plus-stack, and vertical-stack recipes; recipes cannot drop,
  create, hide, reparent, or focus panes. Invalid results fall back to a
  previously valid/built-in host layout in phase 1.
- `src/extensions/document-contract.ts` freezes keys
  `(installationId, exact-session-UUID, extensionId, documentId)`, full-document
  CAS revisions, UUID request IDs, retained idempotency receipts, and explicit
  errors. Revision 0 means absent. A duplicate request ID returns its receipt
  only for identical payload digest and base revision; reuse with changed input
  fails. Receipt eviction after 128 receipts intentionally removes that
  idempotency guarantee. Receipts prove stored acceptance only, never rendering,
  agent authorship, execution, or verification.

## Document limits and durability

Documents are JSON only: max 64 KiB canonical payload, depth 16, 16 KiB/string,
1,000 object keys or array items, 256 documents and 16 MiB per installation.
The store uses one owner-private atomic record per document containing content
and retained receipts; it fsyncs the replacement file and best-effort parent
directory through the existing persistence primitive. A single server-owned
store serializes same-document writes. Corruption is surfaced as `STORE_CORRUPT`,
never silently reset; quota/write failures leave the prior record intact.
Future route wiring must call the authoritative live-scope check for writes;
reads may retain documents after session exit. Schema resolution is limited to
installed manifest allowlisted files and no network/dynamic `$ref` resolution.

`ajv@8.17.1` is pinned as the maintained static JSON Schema compiler. The phase
0 compiled-host smoke is intentionally isolated: `bun build --compile` imports
and runs this module below; no extension schema is evaluated in a browser. This
is compatible with the project Bun 1.4.2 compiled runtime and avoids an ad-hoc
schema language. The schema uses static draft-2020-12 syntax and rejects refs.
The minimal Agent Context v1 schema is
`examples/extensions/agent-context/schemas/context.schema.json`; strings are
data and must render as text, not HTML/Markdown.

## Authenticated browser loader decision

`public/extension-loader.ts` is a reusable, not-yet-integrated browser helper:
it fetches an allowlisted asset using the existing origin-scoped bearer helper,
checks its installed SHA-256, rejects bare/remote imports, imports the verified
bytes from a Blob URL, and revokes the URL. Native `import(url)` remains
unsuitable because it cannot attach the bearer header. There is no unauthenticated
fallback and no token in an URL.

The isolated Playwright spike (`extension-loader-spike.e2e.ts`) serves a compiled
copy of that helper with an authenticated asset and CSP:
`script-src 'self' 'nonce-…' blob:`. It must pass independently in Chromium and
WebKit before phase 2 changes the production HTML CSP. Chromium passed locally;
WebKit is currently **blocked**, not passed, because the pinned Playwright WebKit
executable is absent and this assignment cannot install browsers. It neither
changes the current production CSP nor service-worker caching. Phase 2 must make the narrow
reviewed production CSP addition (`blob:` only; no `unsafe-eval`) and mark
extension asset/document responses `Cache-Control: no-store`/outside SW caching.
A failing browser/CSP spike blocks loader integration rather than selecting an
unauthenticated import.

## Package fetch/extraction decision

Npm source syntax is exactly `npm:<name>@<semver>` (no range/tag). A compiled
install preflights a supported system `npm`; this is an explicit prerequisite,
not an assumption about a checkout or global Bun. It runs `npm pack --ignore-scripts
--json` into a private staging directory, validates registry SRI (`sha512` or
`sha256`), then uses pinned maintained `tar@7.4.3` to inspect every entry before
extracting. Archives must use `package/` paths and only regular files/directories;
links, devices, traversal, backslashes, archive >32 MiB, extraction >128 MiB,
or >4,000 files are refused. Extraction is into a fresh owner-private stage and
checks realpath containment. Activation/registry transactions are phase 4; no
package code or lifecycle script runs in this phase.

## Pi skill deployment decision

`src/extensions/pi-skill-deployment.ts` is a root-injected adapter, not setup
integration. The future explicit `extensions install --skills pi` owns the
consent prompt and passes Pi's supported `~/.pi/agent/skills` discovery root.
It installs only static manifest-declared skill directories, records extension
ownership/source digest/files in an installer-owned registry, rejects unowned
name collisions and user-modified owned files, and atomically swaps a new owned
directory. Browser activation and skill deployment must report separately;
partial skill failure is retryable and is not package-install success. Removal
may delete only unchanged owned files. Existing Pi sessions require their normal
`/reload` or a new session; no command is injected and no Pi Tasks/global config
is touched.

## Exact future CLI/data contract

```
wolfpack extension-data read agent-context/context --session <exact-uuid> --json
wolfpack extension-data publish agent-context/context --session <exact-uuid> \
  --file context.json --if-revision <nonnegative-int> --request-id <uuid> --json
```

`publish` returns the receipt fields above. `CONFLICT` returns the current
revision; callers read/reconcile instead of blind overwrite. `SCOPE_NOT_WRITABLE`
means a new write to the exact scope is not authorized/live. Package-wide disable
must reject publish explicitly; view disable never deletes data. Normal machine
routing/auth remains the authority and will be wired in phase 3—this contract
creates no private localhost endpoint.

## Phase-0 verification and blockers

Unit tests cover manifest ownership/path/version failures, three reusable layout
recipes plus invalid geometry, static-schema/CAS/restart/corruption behavior,
SRI/exact npm/archive inspection, and Pi ownership collision/modification.
The browser spike verifies authenticated Blob import under the reviewed CSP in
Chromium; the required WebKit rerun is blocked by the missing executable. The
compiled smoke verifies AJV import/validation from a compiled executable. Full
commands and private logs are recorded in the phase handoff at completion.

Not yet covered: actual production CSP change/asset routes/SW exclusion,
compiled npm availability on every target, real npm registry download,
installation activation, backend exact-session verification, a real Pi skill
round trip, browser terminal retention, and broker behavior. These are explicit
phase 1–6 gates, not passes from this artifact.
