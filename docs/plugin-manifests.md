# Plugin Manifests

Wolfpack plugins are data manifests. Version 1 does not load third-party code, run browser scripts, or execute plugin actions during discovery.

## Boundaries

- Bundled manifests are trusted as `bundled`.
- Manifests in `~/.wolfpack/plugins` or configured `pluginDirs` are labeled `user-installed`.
- Manifests in `<project>/.wolfpack/plugins` are labeled `project`.
- Project manifests override user-installed manifests with the same id. User-installed manifests override bundled manifests.
- Manifest paths must be regular `.json` files directly under an approved plugin root. Symlinks and paths resolving outside the root are rejected.
- Unknown fields are validation errors.

## Configured User Plugin Roots

Wolfpack always checks `~/.wolfpack/plugins`. Add more user-installed roots in
`~/.wolfpack/config.json`:

```json
{
  "devDir": "/Users/you/Dev",
  "port": 18790,
  "pluginDirs": ["/Users/you/.wolfpack-extra/plugins"]
}
```

For one-off runs or service environments, set `WOLFPACK_PLUGIN_DIRS` to a
colon-separated list:

```bash
WOLFPACK_PLUGIN_DIRS="$HOME/.wolfpack-extra/plugins:/opt/wolfpack/plugins"
```

## Version 1 Schema

```json
{
  "schemaVersion": 1,
  "id": "example.tools",
  "displayName": "Example Tools",
  "description": "Optional short description",
  "homepage": "https://example.com",
  "capabilities": {
    "commands": [
      { "id": "shell", "label": "Open shell", "command": "shell" }
    ],
    "links": [
      { "id": "docs", "label": "Docs", "url": "https://example.com/docs" }
    ],
    "statusProviders": [
      { "id": "status", "label": "Status", "command": "git status --short" }
    ],
    "ralphPresets": [
      { "id": "plan", "label": "Plan", "planFile": ".plans/example.md", "agent": "codex" }
    ],
    "uiActions": [
      { "id": "copy", "label": "Copy command", "kind": "copy-command", "target": "git status --short" }
    ]
  }
}
```

`commands`, `statusProviders`, `ralphPresets`, and `uiActions` are exposed as metadata only. Future execution must stay server-validated and require explicit user confirmation.
