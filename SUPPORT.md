# Support and reporting

Choose the route that matches what you need:

- For setup or runtime recovery, start with [troubleshooting](docs/troubleshooting.md).
- For open-ended questions and usage help, use [GitHub Discussions](https://github.com/almogdepaz/wolfpack/discussions).
- For a reproducible defect, open the [bug-report form](https://github.com/almogdepaz/wolfpack/issues/new?template=bug-report.yml).
- For a product proposal, use the [feature-request form](https://github.com/almogdepaz/wolfpack/issues/new?template=feature-request.yml).
- For a suspected vulnerability, use a [private GitHub security advisory](https://github.com/almogdepaz/wolfpack/security/advisories/new), never a public issue or discussion.

## Optional diagnostic capture

Diagnostic evidence is optional. The existing machine-readable command is:

```bash
wolfpack doctor --json > wolfpack-doctor.json
```

`doctor --json` prints JSON and exits nonzero when one or more checks fail. To retain both the JSON file and that status in a POSIX shell:

```sh
doctor_status=0
wolfpack doctor --json > wolfpack-doctor.json || doctor_status=$?
printf 'wolfpack doctor exit status: %s\n' "$doctor_status"
```

The stable report evidence is top-level `ok`; `counts` with `pass`, `fail`, and `warn`; and `checks` entries with `group`, `name`, `status`, `detail`, and optional `fixHint`.

Before sharing anything publicly, inspect and redact the file. Check detail can expose host-specific, home, or project paths; Tailnet hostnames and private URLs; and recent service-log excerpts. Do not share secrets or tokens, raw config files, terminal transcripts or session content, repository or project names, private machine or network identifiers, or unrelated logs. Share only the smallest sanitized excerpt needed to reproduce the defect.
