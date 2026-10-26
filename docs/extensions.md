# extension data and view context

extensions declare binary storage separately from JSON documents:

```json
{"wolfpack":{"manifestVersion":1,"apiVersion":1,"id":"stage","skills":[],"documents":[],"blobs":{"maxBlobBytes":65536}}}
```

`maxBlobBytes` is an integer from 1 to 1048576. omit `blobs` to disable the channel. the authenticated catalog returns `blobs: null` or `{ maxBlobBytes }`.

```sh
wolfpack extension-data put-blob stage --session <exact-live-local-uuid> --file program.wasm --json
wolfpack extension-data delete-blob stage --session <exact-live-local-uuid> --digest <lowercase-sha256> --json
wolfpack --machine <verified-target> extension-data put-blob stage --session <uuid-on-target> --file program.wasm --json
```

put computes SHA-256 locally and refuses files above the installed declaration before upload. output is `{ digest, bytes, created }`. identical puts are idempotent. blobs belong to an installation and extension, not a session; writes/deletes require a live exact local session UUID. each installation+extension has at most 64 blobs and 16 MiB, without eviction. soft removal retains owned blobs like documents; purge deletes them. reinstalling the same owned extension after removal retains its same-installation blobs (and, like documents, preserves the disabled state until enabled). safe mode and disabled extensions deny blob access.

HTTP: `PUT` and `DELETE /api/extensions/blobs/<extensionId>/<sha256>?session=<uuid>`; `GET` uses the same path without query parameters. PUT requires `application/octet-stream` and verifies the digest. GET returns raw bytes, `Content-Type: application/octet-stream`, `Cache-Control: no-store`, and `X-Wolfpack-Blob-Digest`. missing content uses `ASSET_NOT_FOUND` (404). corrupt content is never served; re-put repairs a corrupt regular digest file atomically and delete removes it without reading its contents. writes fsync the private file and directory before success. purge tolerates stray/crash temporary entries without following component symlinks; cleanup failures after registry removal report an explicit recovery path and diagnostic.

oversized uploads return HTTP 413 and close the connection. the shared HTTP reader stops buffering; the blob route pauses the upload and destroys the request after the response finishes, rather than destroying the socket before 413 can be sent. uploads are not drained indefinitely.

views declaring the channel receive `context.blobs.read(digest, signal?)`, returning a verified `Uint8Array`. reads are bounded and uncached; stale scope or digest mismatch rejects. for a selected-machine scope the local server proxies the read (`GET /api/extensions/peer/<machine>/blobs/<ext>/<digest>`), re-verifies the digest and bounds it by the peer's declared `maxBlobBytes`.

`context.project.gitStatus(signal?)` and `context.project.gitDiff(signal?)` read the scoped session's server-owned project; callers supply no paths or git arguments. `gitDiff` returns `{ state: "not-repository" }` or `{ state: "ready", staged, unstaged, untracked?, truncated }`: unified diffs of tracked files, plus `untracked`: each untracked, non-ignored file across the repository diffed as a new file (`git diff --no-index /dev/null <path>`), with external diff, textconv, filters, renames, color and relative paths disabled. `staged` and `unstaged` are each capped at 96 KiB of serialized JSON and `untracked` at 48 KiB, cut at a line boundary; at most 32 untracked regular files of up to 128 KiB each are diffed, and symlinks, directories (including nested repositories), unreadable, oversized or further files are skipped. `truncated` reports any cut or skip. hosts older than this field omit `untracked`. stale scope or identity mismatch rejects; for a selected-machine scope the local server proxies the read (`GET /api/extensions/peer/<machine>/project/git-diff/<ext>`) and re-validates the response.

`context.terminal?.compose(text)` replaces the selected terminal input draft, dispatches its normal input handling and focuses it; **it never sends**. text must be a string of at most 4096 UTF-8 bytes. stale scopes and mismatched/open-grid terminals throw. the host exposes this optional capability for a selected context when app integration is available; because a selected grid context need not be the open single terminal, callers must handle rejection.

`context.theme` is a frozen mount-time snapshot of nonempty, trimmed CSS properties. keys retain their `--` prefix. the allowlist is:

`--bg-base --bg-deep --bg-surface --bg-elevated --bg-inset --bg-hover --border --border-subtle --border-strong --accent --accent-muted --text-primary --text-secondary --text-muted --text-dim --danger --warning --font-ui --font-mono --radius-sm --radius-md --radius-lg`

these APIs expose no terminal DOM, credentials, send action or server filesystem paths.
