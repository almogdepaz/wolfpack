# AGENTS.md

Universal entrypoint for any agent working in this repository.

## Start Here

1. **Architecture overview:** [`edc-context/index.md`](edc-context/index.md) — repo purpose, actor map, key flows, module map, global invariants, trust boundaries, blast-radius summary.
2. **Routing & policy contract (machine-readable):** [`edc-context/manifest.json`](edc-context/manifest.json) — module-to-path routing, schema version, runtime mode, coverage stats. Single source of truth for any tool that needs to know which file belongs to which module.
3. **Per-module deep context:** `edc-context/modules/<module>.md` — load on demand based on what you're touching.
4. **Reports:** `edc-context/reports/issues.md`, `edc-context/reports/complexity.md`.

## Runtime Mode

Current `policy.defaultMode`: **advisory** (read from `edc-context/manifest.json`). Hooks surface context as advice; they do not block tool calls.

## Notes

- Keep this file short. The real architecture lives in `edc-context/index.md`.
- Build/refresh context with `edc build` or `edc update`. Validate with `edc doctor`.
