# Agent Skills

Wolfpack skills are executable agent instructions stored as ordinary repository
files under `skills/`. Audit each requested `SKILL.md` before installing it.
The repository, not a compiled executable, is the source of truth.

Bundled skill:

- `wolfpack-tailnet-control` - top-level session creation, child spawning
  (same harness by default), and safe local/Tailscale session inspection/control workflows.

## Pi opt-in setup

`wolfpack setup` checks for `pi` on `PATH`. Pi users receive one default-no,
opt-in offer for the Wolfpack control skill plus Pi Tasks; users without Pi
receive no offer. Accepting copies the bundled control skill into Pi before it
runs Pi's package manager with this command:

```bash
pi install npm:@sgtbeatdown/wolfpack-tasks
```

The package was published as `npm:@sgtbeatdown/pi-tasks` before it gained
Claude Code support. When Pi still has the old package, setup offers a
default-no migration that runs `pi remove npm:@sgtbeatdown/pi-tasks` and then
the install command above, and `wolfpack doctor` reports the old package as a
warning with the same commands. The migration moves the old entry's resource
filters in Pi's `settings.json` (for example a `skills` filter for a local skill
overlay) to the new entry, and renames `skills/wolfpack-pi-task-delegation`
paths to `skills/wolfpack-task-delegation`. It holds Pi's settings lock
(`settings.json.lock`) while it re-reads the file and changes only that entry, so
a concurrent Pi settings write is kept. If the lock stays held for about one
second, another process takes the lock over before the write, or it cannot write
the entry, setup prints the entry to restore by hand. It removes the lock only
while the lock is still its own.

Wolfpack does not install the full `wolfpack-bridge` app inside Pi just to obtain
the control skill.

The packages and resources have distinct ownership:

| Owner | Resource | Responsibility |
| --- | --- | --- |
| Wolfpack | `wolfpack-tailnet-control` | Creates and controls visible Wolfpack sessions through the canonical CLI. |
| Pi Tasks extension | `agent_task_*` | Delivers assignments and stores structured task status/results; it does not spawn sessions. |
| Pi Tasks skill | `wolfpack-task-delegation` | Teaches Pi how to combine the session-control skill with task dispatch, completion, and parent-owned cleanup. |

`npm:@sgtbeatdown/wolfpack-tasks` contains both the extension and its matching
delegation skill, so those two stay version-aligned. Every participating Pi
session needs Pi Tasks loaded and a reachable local Wolfpack task gateway. The
server-owned task store is machine-global, and trusted Tailnet peer routing uses
stable broker session IDs rather than a project-local filesystem store. See
the [control API schema](generated/control-api.schema.json) for the canonical task gateway contract.

Declining changes nothing. If writing the control skill fails, setup removes the
newly created skill directory before advising a retry; if cleanup also fails, it
identifies the partial path for review and manual removal. Non-interactive setup
installs nothing and directs Pi users to rerun `wolfpack setup` interactively. Package extensions and skills
can execute commands with the user's permissions, so review them before opting
in. Start a fresh agent context afterward, or run `/reload` in an existing Pi
session.

## Claude task integration setup

`wolfpack setup` checks for `claude` on `PATH`. Claude users receive one
default-no, opt-in offer for the Claude task integration; users without Claude
receive no offer. The integration lets Wolfpack task mail reach Claude sessions
through the `wolfpack-tasks` Claude Code plugin and its channel. Accepting runs
these steps in order and stops at the first failure:

1. Check that `claude --version` is at least 2.1.319 and that Claude uses the
   first-party provider (`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`
   are unset).
2. Run `claude plugin marketplace add almogdepaz/wolfpack-tasks`, unless the
   marketplace is already known to Claude.
3. Run `claude plugin install wolfpack-tasks@wolfpack-tasks` (user scope),
   unless it is already installed.
4. After an explicit confirmation, write the machine-wide managed-settings
   drop-in `wolfpack.json` with `sudo mkdir -p` and `sudo install -m 0644`, unless
   the file already has the expected content. The directory is
   `/Library/Application Support/ClaudeCode/managed-settings.d` on macOS and
   `/etc/claude-code/managed-settings.d` on Linux. The drop-in sets
   `channelsEnabled: true` and `allowedChannelPlugins` to the `wolfpack-tasks`
   plugin only. That allowlist replaces any lower-precedence allowlist, and the
   highest-precedence managed source that sets `allowedChannelPlugins` wins, so
   another managed source can block the channel.
5. Save `claudeTaskIntegration: true` in `~/.wolfpack/config.json`.

Wolfpack treats the integration as on only while the flag is set and the
drop-in is current. If the drop-in is later removed or changed, new Claude
sessions launch without the channel and Claude task-worker requests fail until
setup repairs it.

On a failure, setup prints the failed command and a retry hint, and leaves the
flag off. Wolfpack writes only `wolfpack.json` and never edits other managed
settings. Re-running setup while the integration is on offers to disable it; if
you keep it, setup verifies every step again and repairs only what is missing.
Disabling clears the flag and prints, but does not run, the commands that remove
the drop-in (`sudo rm`) and the plugin (`claude plugin uninstall`).
Non-interactive setup changes nothing and directs Claude users to rerun
`wolfpack setup` interactively. While the flag is on, Wolfpack launches the stock
`claude` command with `--channels plugin:wolfpack-tasks@wolfpack-tasks`; see
[Claude task workers](session-control.md#claude-task-workers).

`wolfpack doctor` shows one line while the flag is off. While it is on, doctor
runs only `claude --version` and reads files; `--fix` never runs these
commands. It fails an old Claude version, a third-party provider, a missing
user-scope plugin, and a missing or wrong drop-in. It warns when
`managed-settings.json` or another drop-in sets `channelsEnabled: false` or an
`allowedChannelPlugins` list without the plugin, and names that file. Doctor
does not inspect MDM or server-managed settings. It also reads the plugin's
status files in `~/.wolfpack/wolfpack-tasks/claude/` and warns, with the session
and the reason, about each live Claude session whose wake stalled after its
status checks ran out, that has a current nudge error, or that uses fallback
wake instead of the channel. A nudge error stops counting once the session
calls its inbox after that nudge (or, for a failed status check, after the
pointer it retried). It warns about status files it cannot read. A channel
session counts as delivered only after a pointer or inbox call; before that,
doctor reports it as "channel configured, unverified".

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

## Manual installation required for non-Pi harnesses

`wolfpack setup` installs the control skill only for Pi after explicit opt-in.
If you use Claude, Codex, Gemini, Cursor, or another Agent Skills-capable
harness, manually add `wolfpack-tailnet-control` to that harness's global skill
root before expecting the agent to control Wolfpack sessions.

Known global roots relevant to Wolfpack are:

- Pi global: `~/.pi/agent/skills/`
- shared Agent Skills root supported by Pi: `~/.agents/skills/`
- Claude global: `~/.claude/skills/`
- another Agent Skills-capable harness: use the global skill root documented by that harness

For shared skill directories, prefer symlinking each desired Wolfpack skill so
a later reviewed `git pull --ff-only` updates the installed source. Choose the
root for the harness that needs session control; this example uses Pi global:

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
existence checks. For another harness, set it to that harness's documented root.
Never force the link or overwrite an existing destination.

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

For a child of the current agent (same harness by default; add `--harness claude` or another supported agent harness to override):

```bash
wolfpack agent spawn <project> --name 200-implementation --plan .plans/000-task.md --notify-parent --json
```

Use `--name` to pick a short issue/role slug, `--plan` for plan work, and
`--prompt-file` for long bespoke instructions; avoid pasting full plans or repository policy into the launch command. The
control skill documents the tailnet/global auth boundary and references
canonical session-control and identity docs instead of duplicating those
contracts.

## Distribution boundary

The npm package includes `skills/` for inspection, but it is the Wolfpack
application package and Wolfpack does not install it inside Pi. The released CLI
bundles the control skill and copies it into Pi only after explicit opt-in.
Platform binaries do not expose skills as files. Setup edits Pi settings only to
move the old Pi Tasks entry's resource filters during the migration above, and
does not overwrite skill directories. The cloned repository remains the auditable
source of truth for manual installation.
