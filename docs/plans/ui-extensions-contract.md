# UI extensions phase-0 contract gate

Status: **phase-0 blocked; coordinator correcting remaining review findings**.
This artifact records intended phase-0 interfaces and explicit implementation gaps; it does not wire extension code into the server, CLI, browser
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
  at most 12 existing panes and 12 rows/columns; finite positive track values;
  one non-overlapping placement for every known pane. Runtime validation rejects
  malformed/sparse inputs with typed errors and returns detached geometry, not
  plugin-owned mutable objects. It provides reusable
  equal-grid, lead-plus-stack, and vertical-stack recipes; recipes cannot drop,
  create, hide, reparent, or focus panes. Invalid results fall back to a
  previously valid/built-in host layout in phase 1.
- `src/extensions/document-contract.ts` freezes keys
  `(installationId, exact-session-UUID, extensionId, documentId)` with canonical
  lowercase UUIDs and no extra key fields, full-document
  CAS revisions, UUID request IDs, retained idempotency receipts, and explicit
  errors. Revision 0 means absent. A duplicate request ID returns its receipt
  only for identical payload digest, base revision and schema version; reuse with changed input
  fails. Receipt eviction after 128 receipts intentionally removes that
  idempotency guarantee. Receipts prove stored acceptance only, never rendering,
  agent authorship, execution, or verification.

## Document limits and durability

Documents are JSON only: max 64 KiB canonical payload, depth 16, 16 KiB/string,
1,000 object keys or array items, 16,384 total JSON value nodes, 256 documents and
16 MiB per installation root. Plain JSON is checked before serialization: cycles,
accessors, non-JSON values and excessive work/bytes are refused. Persisted records
have a separate 1-MiB physical cap, read through a no-follow bounded descriptor.
Record identity, canonical payload digest and the exact contiguous window of up
to 128 receipts are checked on reads and retries. Receipts require matching scope,
positive bounded versions/revisions, unique request IDs and canonical timestamps.

The store uses one owner-private atomic record per document containing content
and retained receipts; it fsyncs the replacement file and best-effort parent
directory through the existing persistence primitive. A single server-owned
store serializes same-document writes and snapshots request values before any
await. Authoritative live-scope hooks may be asynchronous and are awaited under
the document lock; quota accounting and file replacement then run synchronously.
Cross-process writers are not supported by this foundation. Corruption is
`STORE_CORRUPT`, never silently reset. A failed pre-commit check leaves the prior
record intact; if a response is lost after commit, retrying the same retained
operation returns its receipt even after scope exit or a schema upgrade.
Future routes must supply the authoritative live-scope check and installed-schema
resolution; the helper alone is not backend authorization. Reads may retain
documents after session exit.

`ajv@8.17.1` is pinned as the maintained static JSON Schema compiler. The phase
0 compiled-host smoke is intentionally isolated: `bun build --compile` imports
and runs this module below; no extension schema is evaluated in a browser. This
is compatible with the project Bun 1.4.2 compiled runtime and avoids an ad-hoc
schema language. Static draft-2020-12 object and boolean schemas are supported.
The policy walks actual subschema positions (including `$defs`), not instance
property names or `const`/`enum`/`default`/`examples` data. Refs, anchors, regex/format
and async validators are refused. Installed schemas are capped at 64 KiB, 4,096
JSON nodes, 48 JSON levels, 256 subschema nodes, 16 subschema levels and 16 branches
per combinator. A conservative 2,000,000-unit schema/document work budget accounts
for literal nodes and quadratic `uniqueItems`; it is admission control, not a
wall-clock JavaScript sandbox. AJV remains the semantic validator. The minimal
Agent Context v1 schema is
`examples/extensions/agent-context/schemas/context.schema.json`; strings are
data and must render as text, not HTML/Markdown.

## Authenticated browser loader decision

`public/extension-loader.ts` is a reusable, not-yet-integrated browser helper:
it fetches an allowlisted asset using the existing origin-scoped bearer helper,
checks its installed SHA-256, imports the verified bytes from a Blob URL, and
revokes the URL. Packages must build self-contained ESM bundles; this helper does
not scan JavaScript or enforce transitive-import isolation. Native `import(url)` remains
unsuitable because it cannot attach the bearer header. There is no unauthenticated
fallback and no token in an URL. Acquisition and digest verification share a
5-second deadline and 1-MiB source cap, reducible but not enlargeable by callers.
Rejected responses and timed-out readers are cancelled without waiting for an
uncooperative transport. These bounds do not terminate trusted JavaScript
execution: module evaluation, including top-level await, cannot be cancelled.

The isolated Playwright spike (`extension-loader-spike.e2e.ts`) serves a compiled
copy of that helper with an authenticated asset and CSP:
`script-src 'self' 'nonce-…' blob:`. It must pass independently in Chromium and
WebKit before phase 2 changes the production HTML CSP. Chromium passed locally;
WebKit passes the bounded fixture from the coordinator-provided private browser cache.
This is feasibility evidence only, not production route/auth integration. It neither
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
checks realpath containment. **Open phase-0 blockers:** inspection still needs
prompt expansion-abort; extraction must consume the identical immutable verified
bytes and reapply the inventory filter. Existing double pathname hashing does not
satisfy that contract. Portable filename handling also needs closure. Canonical
SemVer validation is now shared by manifest/npm source parsing, preserving legal
prerelease/build metadata but rejecting prefixes, whitespace and invalid versions.
Missing/mismatched SRI retains its actionable `INTEGRITY_MISMATCH` classification. Activation/registry transactions are phase 4; no package code or
lifecycle script runs in this phase.

## Pi skill deployment decision

`src/extensions/pi-skill-deployment.ts` is a root-injected adapter, not setup
integration. The future explicit `extensions install --skills pi` owns the
consent prompt and passes Pi's supported `~/.pi/agent/skills` discovery root.
It installs only static manifest-declared skill directories, records extension
ownership/source digest/files in an installer-owned registry, rejects unowned
name collisions and user-modified owned files. User-added files now cause an
update refusal rather than deletion. **Open phase-0 blockers:** canonical tree
paths, validated registries/frontmatter, ownership-safe removal, and recovery of
the old directory on every swap/registry failure. The current adapter is not yet
failure-atomic and does not implement removal. Browser activation and skill
deployment must report separately; partial skill failure is not package-install
success. The required removal contract permits deleting only unchanged owned
files. Existing Pi sessions require their normal
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
Independent Chromium and WebKit runs passed at `0f4c4e3`; WebKit uses the private
cache named in the phase handoff. The browser fixture covers real bearer rejection,
safe-mode-before-fetch, digest rejection and successful Blob import; it is not
coverage for every loader branch. The coordinator's separate loader unit suite
exercises URL authority, credential rejection, HTTP/MIME/redirect failures,
invalid/reducible/hard resource bounds, stalled headers/body, stream cleanup and
typed errors. Its first run had 11 passes/27 failures; fixes must retain those
regressions. Exact run IDs/results live in the phase handoff and closure matrix.

The existing compiled smoke proves AJV/SemVer dependency use outside a checkout,
not archive extraction or an actual compiled browser asset host. Those two
phase-0 feasibility proofs remain open. The browser spike is a Node-host fixture,
not production server auth/CSP/SW evidence. Trusted same-thread bundle
code remains trusted: restrictions are packaging compatibility controls, not a
sandbox or a JavaScript security scanner.

Not yet covered: actual production CSP change/asset routes/SW exclusion, package
activation/crash lifecycle and cross-process locks, real npm registry download,
backend exact-session verification, a real Pi skill round trip, browser terminal
retention, and broker behavior. Geometry-only retention is a Phase-1 obligation;
current collapse/suspend behavior does dispose controllers. These are explicit
phase 1–6 gates, not passes from this artifact.
