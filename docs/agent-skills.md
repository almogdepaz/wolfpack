# Agent Skills

Wolfpack skills are executable agent instructions stored as ordinary repository
files under `skills/`. Audit each requested `SKILL.md` before installing it.
The repository, not a compiled executable, is the source of truth.

Bundled skill:

- `wolfpack-tailnet-control` - top-level session creation, same-harness child
  spawning, and safe local/Tailscale session inspection/control workflows.

## Pi opt-in setup

`wolfpack setup` checks for `pi` on `PATH`. Pi users receive one default-no,
opt-in offer for the complete subagent integration; users without Pi receive no
offer. Accepting runs Pi's package manager with these commands in order:

```bash
pi install npm:wolfpack-bridge
pi install npm:@sgtbeatdown/pi-tasks
```

The packages and resources have distinct ownership:

| Owner | Resource | Responsibility |
| --- | --- | --- |
| Wolfpack | `wolfpack-tailnet-control` | Creates and controls visible Wolfpack sessions through the canonical CLI. |
| Pi Tasks extension | `agent_task_*` | Delivers assignments and stores structured task status/results; it does not spawn sessions. |
| Pi Tasks skill | `wolfpack-pi-task-delegation` | Teaches Pi how to combine the session-control skill with task dispatch, completion, and parent-owned cleanup. |

`npm:wolfpack-bridge` exposes the bundled Wolfpack skills to Pi.
`npm:@sgtbeatdown/pi-tasks` contains both the extension and its matching
delegation skill, so those two stay version-aligned. Every participating Pi
session needs Pi Tasks loaded. Its default filesystem task store also requires
parent and child sessions to use the same project directory; cross-repository or
multi-host task state needs a shared store.

Declining changes nothing. Non-interactive setup installs nothing and prints the
two commands only when Pi is detected. Package extensions and skills can execute
commands with the user's permissions, so review them before opting in. Start a
fresh agent context afterward, or run `/reload` in an existing Pi session.

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
wolfpack agent spawn <project> --name 200-implementation --plan .plans/000-task.md --notify-parent --json
```

Use `--name` to pick a short issue/role slug, `--plan` for plan work, and
`--prompt-file` for long bespoke instructions; avoid pasting full plans or repository policy into the launch command. The
control skill documents the tailnet/global auth boundary and references
canonical session-control and identity docs instead of duplicating those
contracts.

## Distribution boundary

The npm package includes `skills/` so users inspecting that package can read the
same repository files. Platform binary packages only contain executables;
platform binaries do not contain skills. After explicit opt-in, the setup wizard
delegates package installation to Pi instead of embedding skill payloads,
editing Pi settings, or overwriting skill directories. The cloned repository
remains the auditable source of truth for manual installation.
