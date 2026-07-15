# Agent Skills

Wolfpack ships optional agent skills in `skills/`. They are plain directories
that users can copy or symlink into the skill path for their agent.

Bundled skills:

- `wolfpack-plan` - plan-file task header conventions Ralph can parse.
- `wolfpack-ralph` - Ralph response-file contract, notifications, and sandbox
  caveats.
- `wolfpack-tailnet-control` - same-harness sub-agent creation plus safe
  local/Tailscale session inspection and explicitly authorized control workflows.

The npm package includes `skills/` so `bunx wolfpack-bridge` and installed
packages expose the same skill text as the repository. Platform binary packages
only contain executables.

For shared skill directories, prefer symlinking each desired Wolfpack skill
directory into the agent-specific skill root. Updating Wolfpack then updates
the source skill content without hardcoded local paths. If your agent copies
skills instead of symlinking, refresh the copied directories after upgrading
Wolfpack.

The control skill intentionally references `README.md`, related skills, and
`docs/broker-protocol.md` only for the server-broker wire contract. It does not
treat broker protocol docs as the browser `/ws/pty` attach/take-control contract.
Keep the referenced docs authoritative for their own API/auth boundaries rather
than duplicating protocol details in skill text.
