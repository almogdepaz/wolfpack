# UI extensions phase-0 contract gate

Status: **phase-0 contracts and isolated feasibility independently APPROVED at `41d7f3a69144f14c24434af2a91fe2dccf6b5bb9`**. The acquisition blocker and prior finding groups are closed; production integration and real-agent acceptance remain later gates.
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

The selected mechanism is now native Bun Fetch, **not an external npm process**.
`fetchExactNpmPackage()` is asynchronous and retrieves exact `npm:<name>@<semver>`
version metadata, checks package identity and required canonical SHA-512/SHA-256
SRI, then streams the tarball directly into one exclusive 0600 file. A shared
30-second request/body deadline covers metadata and download; metadata is capped
at 256 KiB and tarball writes at 32 MiB. Overrides only reduce these bounds. Each
chunk is checked before writing; npm cannot fill a cache or staging disk first
because no npm process/cache exists. Staging requires an existing current-owner
0700 non-symlink directory and creates a fresh private child per acquisition.
Timeouts return `NPM_FETCH_TIMEOUT`; failed downloads are aborted/cancelled and
partial stages removed without waiting for uncooperative cancellation. Cleanup
failure reports the owned `cleanupDirectory`. Limits are per acquisition, not a
package-manager-wide quota or a hostile-filesystem/synchronous-I/O sandbox.

This deliberately supports anonymous HTTPS registry origins, defaulting to
`https://registry.npmjs.org/`, with same-origin tarballs and no redirects. Explicit
loopback HTTP origins support offline tests. npmrc credentials, authenticated
registries, and cross-origin CDN mirrors are not implemented or inferred. There
is no system npm version preflight/prerequisite anymore. The compiled executable
supplies its own Fetch runtime: the expanded native smoke executes the actual
helper from empty CWD against a local registry, verifies/extracts its package,
rejects oversize acquisition, and checks that poisoned npm and package lifecycle
script markers never ran. No real registry call is claimed by this local gate.

`archive-snapshot.ts` takes one bounded no-follow regular-file snapshot
before its first await. Registry callers must forward the returned SRI to
`extractVerifiedNpmTarball(..., { integrity })`; omitting SRI is structural
validation for explicitly trusted local input, not registry authentication.
Pinned maintained `tar@7.4.3` decodes headers/PAX and regular file bytes. A separate
backpressured gzip stream counts all expanded tar bytes, including padding and
bytes after EOF, and is destroyed on failure. Nested compression is refused.
Limits (only reducible): 32 MiB source, 128 MiB payload and expanded tar,
4,000 files, 8,000 entries/directory inventory, 16 KiB per metadata entry,
64 KiB aggregate metadata, and a 5-second in-memory inspection deadline.
These are format/work budgets, not a process-RSS or hostile-filesystem sandbox.

Only `package/` regular files and zero-sized directories are accepted. Relative
paths use a portable ASCII subset, max 256 characters, eight components and
128 characters/component. Traversal, backslashes, device names, trailing dots,
case/component aliases, duplicate entries and file/directory conflicts fail.
Extraction revalidates the captured inventory and its content digests, then
writes those exact private buffers with exclusive 0600 files/0700 directories.
It never reopens the archive or uses a second pathname hash. It verifies written
bytes, ignores archived ownership/modes, and removes partial stages on failure;
a failed cleanup returns a typed error with `cleanupDirectory`. The injected
filesystem callbacks are trusted synchronous test/host I/O, never package code.
Package activation and crash recovery remain phase-4 responsibilities. Canonical
SemVer validation is now shared by manifest/npm source parsing, preserving legal
prerelease/build metadata but rejecting prefixes, whitespace and invalid versions.
Missing/mismatched SRI retains its actionable `INTEGRITY_MISMATCH` classification. Activation/registry transactions are phase 4; no package code or
lifecycle script runs in this phase.

## Pi skill deployment decision

`src/extensions/pi-skill-deployment.ts` is a root-injected adapter, not setup
integration. The future explicit `extensions install --skills pi` owns the
consent prompt and passes Pi's supported `~/.pi/agent/skills` discovery root.
It installs only static manifest-declared skill directories, records extension
ownership/source digest/files in a validated bounded 0600 registry. Portable
paths follow the same ASCII/length/component policy as archives. A complete
owned-tree comparison refuses missing/edited files, changed modes, hard links,
symlinks, untracked files and extra empty directories on update or removal.
`removeBundledPiSkills` explicitly removes only unchanged matching-owned trees;
a smaller replacement manifest never implicitly deletes a skill.

Pinned `yaml@2.8.2` parses bounded YAML 1.2 frontmatter, including reordered keys,
quoted/folded/literal text and CRLF. Duplicate keys, aliases and malformed YAML
fail; the standard lowercase name must match the declared directory (max 64
characters), and description must be nonblank and at most 1,024 characters.
Inventory bounds are 256 files, 256 KiB/file, 1 MiB/skill; frontmatter is 16 KiB
with bounded JSON depth/nodes. Batches have at most 32 unique skill names; the
registry permits 128 skills and 8 MiB physical data. Hashes are computed by the
host and registry owner/path/digest coherence is validated, never silently reset.

A root directory lock serializes cooperating writers. Transactions are per skill,
not all-or-nothing batches. Staging, old bytes and a before/after journal live
outside the discovery root. Failed writes/swaps restore the old tree before
cleanup; registry commit is read back, including when a writer throws after
committing. A failed rollback retains recovery files, throws `RECOVERY_REQUIRED`
with `recoveryDirectory`, and leaves the root locked. Post-commit cleanup trouble
or observed edits to parked bytes return success with a workspace requiring
inspection, not blind deletion. No automatic stale-lock recovery or full
power-loss recovery is claimed; arbitrary concurrent user filesystem mutation is
not prevented by an installer lock. Discovery collisions are checked only in the
injected root; symlinks/uninspectable candidates fail closed, not a scan of all
Pi global/project/CLI sources. Host/test filesystem callbacks are trusted,
synchronous I/O, never part of the package interface.

Browser activation and skill deployment report separately. Existing Pi sessions require their normal
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

## Phase-0 verification and remaining integration gates

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

`extension-foundation-compiled-smoke.ts` now executes schema validation, document
persistence, SemVer, YAML skill install/update/remove, and actual tar
inspection/extraction outside the checkout, including quota rejection and
pathname replacement after snapshot capture, plus actual offline registry
acquisition, its byte cap/cleanup, and absence of npm/script execution.
`extension-compiled-host.e2e.ts`
starts a native Bun-compiled isolated host from an empty CWD. Its embedded browser
loader reads runtime package assets behind a rejecting bearer fixture under the
reviewed Blob CSP; Chromium and WebKit cover missing auth, safe mode, digest
rejection, and explicit runtime package replacement. This host is not the
production Wolfpack router/auth/CSP/SW implementation. Exact source/run results
are in the handoff and closure matrix; these are feasibility proofs, not the
real-agent data-publication acceptance story. Trusted same-thread bundle
code remains trusted: restrictions are packaging compatibility controls, not a
sandbox or a JavaScript security scanner.

Not yet covered: actual production CSP change/asset routes/SW exclusion, package
activation/crash lifecycle and cross-process package-registry locks, real npm registry download,
backend exact-session verification, a real Pi skill round trip, browser terminal
retention, and broker behavior. Geometry-only retention is a Phase-1 obligation;
current collapse/suspend behavior does dispose controllers. These are explicit
phase 1–6 gates, not passes from this artifact.
