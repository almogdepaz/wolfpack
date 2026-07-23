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
wolfpack session create <project> --harness pi --plan .plans/000-task.md --json
```

For a same-harness child of the current agent:

```bash
wolfpack agent spawn <project> --plan .plans/000-task.md --notify-parent --json
```

Use `--plan` for plan work and `--prompt-file` for long bespoke instructions;
avoid pasting full plans or repository policy into the launch command. The
control skill documents the tailnet/global auth boundary and references
canonical session-control and identity docs instead of duplicating those
contracts.

## Pi `/hunk` extension

The npm package declares `extensions/hunk.ts` as a Pi extension. After installing
Wolfpack as a Pi package, `/reload` in Pi makes `/hunk` available.

`/hunk` is zero-model-turn glue: it requires Pi to be running inside a Wolfpack
session with `WOLFPACK_PROJECT_DIR` and `WOLFPACK_SESSION_NAME`, checks that the
host has `hunk` on `PATH`, runs `wolfpack session create <project> --harness
shell --grid --json`, then sends `exec hunk diff --watch` to the returned stable
session id. Exiting Hunk exits that Wolfpack shell session.

Hunk is an external prerequisite and is not installed by Wolfpack. Pi, Wolfpack,
and Hunk must run on the same host. If session creation succeeds but command
send fails, the extension reports the surviving Wolfpack session name/id and
leaves cleanup to the user.

## Distribution boundary

The npm package includes `skills/` and `extensions/` so users inspecting that
package can read the same repository files. Platform binary packages only
contain executables, and platform binaries do not install skills or extensions.
This is intentional: there is no binary-embedded skill payload, skill installer,
network download, or automatic overwrite of a user's skill directories. The
cloned repository remains the auditable source of truth.
