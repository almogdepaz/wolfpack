# Agent Skills

Wolfpack skills are executable agent instructions stored as ordinary repository
files under `skills/`. Audit each requested `SKILL.md` before installing it.
The repository, not a compiled executable, is the source of truth.

Bundled skills:

- `wolfpack-plan` - plan-file task header conventions Ralph can parse.
- `wolfpack-ralph` - Ralph response-file contract, notifications, and sandbox
  caveats.
- `wolfpack-tailnet-control` - top-level session creation, same-harness child
  spawning, and safe local/Tailscale session inspection/control workflows.

## Clone or update the auditable source

Use a dedicated clone. Updating is fast-forward-only so this workflow does not
silently create a merge:

```bash
REPO="$HOME/src/wolfpack"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --ff-only
else
  git clone https://github.com/almogdepaz/wolfpack "$REPO"
fi
```

Before installing the control skill, review its complete instruction file:

```bash
less "$REPO/skills/wolfpack-tailnet-control/SKILL.md"
```

Skills can direct an agent to run commands. Do not skip this audit merely
because the source came from the Wolfpack repository.

## Install one reviewed skill

Supported global roots relevant to Wolfpack are:

- Pi global: `~/.pi/agent/skills/`
- shared Agent Skills root supported by Pi: `~/.agents/skills/`
- Claude global where used: `~/.claude/skills/`

For shared skill directories, prefer symlinking each desired Wolfpack skill so
a later reviewed `git pull --ff-only` updates the installed source. Choose one
root; this example uses Pi global:

```bash
REPO="$HOME/src/wolfpack"
SOURCE="$REPO/skills/wolfpack-tailnet-control"
DEST_ROOT="$HOME/.pi/agent/skills"
DEST="$DEST_ROOT/wolfpack-tailnet-control"

[ -d "$SOURCE" ] || {
  printf 'skill source not found: %s\n' "$SOURCE" >&2
  exit 1
}
mkdir -p "$DEST_ROOT"
[ ! -e "$DEST" ] && [ ! -L "$DEST" ] || {
  printf 'refusing to replace existing skill: %s\n' "$DEST" >&2
  exit 1
}
ln -s "$SOURCE" "$DEST"
```

To target the shared Pi-compatible root or Claude global root, set `DEST_ROOT`
to `$HOME/.agents/skills` or `$HOME/.claude/skills` before running the same
existence checks. Never force the link or overwrite an existing destination.

Copying is an alternative for agents or environments that cannot follow
symlinks. It uses the same fail-closed destination check:

```bash
REPO="$HOME/src/wolfpack"
SOURCE="$REPO/skills/wolfpack-tailnet-control"
DEST_ROOT="$HOME/.pi/agent/skills"
DEST="$DEST_ROOT/wolfpack-tailnet-control"

[ -d "$SOURCE" ] || {
  printf 'skill source not found: %s\n' "$SOURCE" >&2
  exit 1
}
mkdir -p "$DEST_ROOT"
[ ! -e "$DEST" ] && [ ! -L "$DEST" ] || {
  printf 'refusing to replace existing skill: %s\n' "$DEST" >&2
  exit 1
}
cp -R "$SOURCE" "$DEST"
```

A copied skill must be refreshed manually after reviewing repository updates.
In either case, start a fresh agent context so skill descriptions are rescanned.

## Invoke the control skill

For a top-level project session:

```bash
wolfpack session create <project> --harness pi --prompt '<instruction>' --json
```

For a same-harness child of the current agent:

```bash
wolfpack agent spawn <project> --prompt '<instruction>' --json
```

Keep `<instruction>` short and point at the repository plan rather than
repeating it. The control skill documents the tailnet/global auth boundary and
references canonical session-control and identity docs instead of duplicating
those contracts.

## Distribution boundary

The npm package includes `skills/` so users inspecting that package can read the
same repository files. Platform binary packages only contain executables, and
platform binaries do not install skills. This is intentional: there is no
binary-embedded skill payload, skill installer, network download, or automatic
overwrite of a user's skill directories. The cloned repository remains the
auditable source of truth.
