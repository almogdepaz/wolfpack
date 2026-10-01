# Changes widget

A small, read-only Git status view. It uses host data, not an agent-authored document or bundled skill.

- Branch (including unborn branches and detached HEAD).
- Collapsible staged, unstaged and untracked groups, with counts, filename-first rows and muted directory context. Full literal paths remain available to assistive technology and in path tooltips; status letters have full accessible labels.
- Unique changed-file count: a partially staged file appears in both groups but counts once in the summary. Refresh preserves disclosure state/focus and unchanged groups.
- Automatic checks every five seconds after the previous read finishes, only while the widget and page are visible. Reopening the widget, returning to the browser/tab, or selecting a new session refreshes immediately. Concurrent triggers share the in-flight read; no Git hooks, terminal-output dependency or filesystem watcher is needed.
- Manual Refresh remains available. Its quiet busy indicator respects reduced motion; the footer shows the last successful check without repeatedly announcing polling to screen readers.
- Clean/non-repository/error states. Failed refreshes explicitly label previously displayed data as stale.
- Collapse retains the widget; hiding, disposal and scope replacement abort requests. Empty desktop scopes have no widget rail.

## Build and install

From the Wolfpack checkout:

```sh
bun run scripts/build-extension-sdk.ts
bun run scripts/build-extension-samples.ts
```

Install only into an explicitly chosen/authorized Wolfpack installation:

```sh
wolfpack extensions install /absolute/path/to/examples/extensions/changes --trust-browser-code
```

Installation is a snapshot, not a live source link. Rebuild and use the public extension-update command for later changes. This example requires a host providing `context.project.gitStatus(signal?)`; it declares no documents, skills or terminal layouts. Building/testing does not install it into the operator's live workspace.

## Scope and boundaries

The host API accepts only the selected local session UUID and installed extension ID. The server resolves the live session's launch project directory from broker facts, rechecks liveness/project/package identity after Git, and returns an identity-bound envelope. It does not follow later `cd` commands inside the terminal. Remote sessions remain unavailable; no local-data fallback or remote Git command is attempted.

Git is invoked with fixed argv and no shell. Inherited Git overrides and global/system configuration are excluded; optional index writes, fsmonitor, hooks and configured clean/process filters are disabled. Submodule working-tree traversal and rename detection are disabled (renames normally appear as added/deleted). Untracked directories are summarized, as with ordinary `git status`.

Each read has a two-second subprocess deadline and 256 KiB output bound. At most two reads run concurrently per route service. A result includes at most 200 changed records; truncation is explicit and never reported as clean. Output-limit/timeouts produce unavailable status rather than misleading partial/empty results. Polling is serial and stops while hidden. Host and widget both reject late obsolete responses.

This is a narrow trusted-host operation, not a sandbox against a concurrently malicious local process or filesystem. Existing extension browser-code trust and HTTP authentication still apply. There is no stage/commit/discard/file-write/diff action, arbitrary path, Git argument, shell input, token or terminal object in the SDK method.
