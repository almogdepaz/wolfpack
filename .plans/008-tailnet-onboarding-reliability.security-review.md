# security review report

## what changed

- target: Tailnet onboarding reliability
- baseline: `main` at `762d997`
- files reviewed: 4 production/documentation files and 1 focused test file
- security-relevant files: `src/cli/setup.ts`, `src/cli/tailscale-remote-setup.ts`
- context loaded: `edc-context/index.md`, `edc-context/manifest.json`, `edc-context/modules/wolfpack.md`, EDC security-review methodology

## findings

### no security findings

No exploitable security regression was found in the reviewed scope.

Checked:
- subprocess boundary: the new Tailscale helper receives only fixed argument arrays (`status --self --json`, `serve --bg <validated configured port>`, and `serve status --json`); the hostname is parsed after command execution and never reaches a shell command;
- sensitive state mutation: `tailscaleHostname` is set only after structured `serve status --json` validation identifies an HTTPS route to the configured loopback port; failed setup retains an existing config and does not emit a remote QR;
- trust boundary: no HTTP route or browser code can invoke Tailscale; loopback binding, origin policy, and JWT behavior are untouched;
- secret exposure: remote URLs/QRs contain only the configured HTTPS hostname, not credentials or bearer tokens;
- history: inspected original Tailscale setup introduction and prior `tailscale serve` history; no removed authentication or validation was reintroduced.

Limitations:
- no Tailscale binary or signed-in Tailnet exists in this development environment, so actual `serve status --json` output and phone reachability were not executed here;
- the review is limited to this diff and does not audit Tailscale itself.

## security test confidence

- structured status parsing and mismatched backend rejection: covered by `tests/unit/tailscale-remote-setup.test.ts`.
- browser/subprocess reachability: preserved by code inspection; no new route exists.
- real Tailnet phone path: manual release verification remains required.

## blast radius

- entrypoint: `wolfpack setup`.
- touched boundary: local CLI → Tailscale subprocess → private config/terminal QR output.
- unaffected: broker PTY authority, WebSocket/session authorization, browser origin policy, JWT validation.

## historical context

- `3260eac` introduced the Tailscale setup flow.
- `c9b8a4c` previously improved external-call error reporting. This diff retains explicit failure output rather than silently accepting an exit code.

## recommendation

conditional — code-level trust-boundary review found no blocker. Require the planned signed-in Tailnet phone scan before merge because the local environment cannot verify Tailscale’s external configuration/runtime contract.
