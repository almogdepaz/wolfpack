# installation and first success

Wolfpack runs selected agent commands with your local user permissions. Install it only on machines and Tailnets you control.

## choose an install path

### curl installer: persistent CLI

Use curl when you want `wolfpack` available on your `PATH`. Before running it, review [what the installer does](#what-the-installer-does), or use the [manual/audited path](#manualaudited-install) instead.

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
```

To install one explicitly selected GitHub release instead, keep the bootstrap source, checksum list, server, and broker on the same tag:

```bash
WOLFPACK_RELEASE_TAG='v1.6.20-rc.1'
curl -fsSL "https://raw.githubusercontent.com/almogdepaz/wolfpack/${WOLFPACK_RELEASE_TAG}/install.sh" \
  | WOLFPACK_RELEASE_TAG="${WOLFPACK_RELEASE_TAG}" bash
```

`WOLFPACK_RELEASE_TAG` is an opt-in: the installer validates it as a semantic release tag before downloads or installed-state changes, then uses that tag for all three release asset URLs. Use only a tag you have selected and reviewed. The checksum list establishes consistency within that release but is distributed with the binaries; use the [manual/audited path](#manualaudited-install) for independent inspection and optional provenance verification.

The installer downloads and verifies the matching `wolfpack` and `wolfpack-broker` releases, then immediately launches setup. After setup, if you accepted the login service, open the printed URL. If you declined the login service, run `wolfpack`, then open the printed URL. In either case, run `wolfpack doctor` to verify the installation.

On later runs, `wolfpack` stages the current server binary and runs `setup --defer-service-restart`, which verifies and persists configuration without activating the server. After setup succeeds for an existing configured service, the script invokes `wolfpack service restart --server-only` once. That final restart neither prompts for nor restarts a running broker, though starting the server can start a missing required broker.

### Bunx or npm: no persistent CLI

Use a package runner when you do not want a global `wolfpack` command. Pin `@latest` so the runner does not reuse an older cached release:

```bash
bunx wolfpack-bridge@latest
# or
npx --yes wolfpack-bridge@latest
```

These commands resolve the same matching prebuilt `wolfpack` and `wolfpack-broker` pair and run the same setup wizard, but do **not** add `wolfpack` to your `PATH`. Repeat the runner prefix for every later command.

## What the installer does

The normal curl command retrieves the [bootstrap installer source](https://github.com/almogdepaz/wolfpack/blob/main/install.sh) from raw `main`; that script then retrieves binaries and the [release checksum asset](https://github.com/almogdepaz/wolfpack/releases/latest/download/checksums-sha256.txt) from the latest GitHub Release on the [Wolfpack releases page](https://github.com/almogdepaz/wolfpack/releases). The normal bootstrap source and release assets therefore have different network/version boundaries. The tagged `WOLFPACK_RELEASE_TAG` opt-in above keeps those sources on the same tag, but still executes downloaded bootstrap code and trusts a checksum list co-distributed with the binaries. Use the pinned manual path below when you need to inspect one immutable release tag before running downloaded code.

In execution order, the installer:

1. requires Bash and accepts only macOS or Linux on x64 or arm64;
2. creates a private staging directory under `~/.wolfpack/bin`, then downloads the matching `wolfpack`, `wolfpack-broker`, and `checksums-sha256.txt` release assets there;
3. rejects failed or empty downloads and unavailable SHA-256 tooling, selects each binary's exact filename from the checksum list, and verifies both binaries before replacement; ordinary exits and failures run the EXIT cleanup trap;
4. on macOS, clears downloaded quarantine/provenance attributes and applies an ad-hoc local signature to both staged binaries before replacement—this permits local execution but is **not** Wolfpack publisher identity verification;
5. after both checks pass, moves each staged file into `~/.wolfpack/bin` on the same filesystem, so each managed path is replaced atomically; and
6. leaves unrelated `wolfpack` commands or symlinks unchanged, attempts its managed PATH symlink, and runs the exact managed binary's setup. On an already configured upgrade, deferred setup is followed by one `wolfpack service restart --server-only`; restart failure makes the installer fail. A running broker and its sessions are preserved, but server start can start a missing required broker.

On a clean install, `exec "$MANAGED_BINARY" setup` replaces Bash, so its EXIT trap does not run and a private `.install.*` directory can remain under `~/.wolfpack/bin`. On a configured upgrade, setup returns control to Bash before the server-only restart, and the EXIT trap removes the staging directory when the installer exits. Any retained clean-install directory contains the public release checksum list and neither moved binary; remove it only after confirming no installer is active.

Direct setup can refresh the installed server descriptor or request an immediate server-only restart when descriptor settings or remote-access policy change. During a configured installer upgrade, restart deferral writes descriptor changes without activation and leaves one final server-only restart to the installer. An already installed login service is preserved without another installation prompt, so the upgrade does not reinstall or restart a running broker; starting the server can start a missing required broker. On a clean install without a service, accepting login-service installation starts both the server and broker. While active sessions matter, run the upgrade from an external terminal and verify sessions and service state afterward.

Release checksums detect corruption or a mismatch between downloaded bytes and listed filenames, but the checksum list is distributed with the same release. The [release workflow source](https://github.com/almogdepaz/wolfpack/blob/main/.github/workflows/release.yml) also creates GitHub build-provenance attestations for the release assets. Verifying those attestations adds a separate workflow/repository identity signal; it does not audit the source for correctness or prove that a binary is safe. See GitHub CLI's [`gh attestation verify` documentation](https://cli.github.com/manual/gh_attestation_verify).

## Manual/audited install

Use this path when you want a pinned release rather than the mutable raw-`main` bootstrap and latest-release selection. It requires `curl`, `awk`, standard POSIX shell utilities, and either `shasum` on macOS or `sha256sum` on Linux. Run the blocks in order in the same shell. Replace `vX.Y.Z` with an explicit release tag; the placeholder deliberately fails validation.

First, derive a supported target, create a private temporary directory, and download the exact binary pair, checksum list, pinned installer source, and pinned release workflow without executing downloaded code:

```sh
set -eu
umask 077

VERSION='vX.Y.Z'
SEMVER_CORE_IDENTIFIER='(0|[1-9][0-9]*)'
SEMVER_PRERELEASE_IDENTIFIER='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER_BUILD_IDENTIFIER='[0-9A-Za-z-]+'
SEMVER_RELEASE_TAG_PATTERN="^v${SEMVER_CORE_IDENTIFIER}\.${SEMVER_CORE_IDENTIFIER}\.${SEMVER_CORE_IDENTIFIER}(-${SEMVER_PRERELEASE_IDENTIFIER}(\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(\+${SEMVER_BUILD_IDENTIFIER}(\.${SEMVER_BUILD_IDENTIFIER})*)?$"
if ! printf '%s\n' "$VERSION" | grep -Eq "$SEMVER_RELEASE_TAG_PATTERN"; then
  echo "Set VERSION to an explicit semantic release tag such as v1.6.20-rc.1" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) echo "Unsupported OS" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac

TARGET="$OS-$ARCH"
SERVER_ASSET="wolfpack-$TARGET"
BROKER_ASSET="wolfpack-broker-$TARGET"
CHECKSUM_FILE="checksums-sha256.txt"
SELECTED_CHECKSUMS="selected-checksums-sha256.txt"
RELEASE_BASE_URL="https://github.com/almogdepaz/wolfpack/releases/download/$VERSION"
SOURCE_BASE_URL="https://raw.githubusercontent.com/almogdepaz/wolfpack/$VERSION"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wolfpack-audit.XXXXXX")"
cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
cd "$STAGING_DIR"

curl --fail --location --proto '=https' --tlsv1.2 --output "$SERVER_ASSET" "$RELEASE_BASE_URL/$SERVER_ASSET"
curl --fail --location --proto '=https' --tlsv1.2 --output "$BROKER_ASSET" "$RELEASE_BASE_URL/$BROKER_ASSET"
curl --fail --location --proto '=https' --tlsv1.2 --output "$CHECKSUM_FILE" "$RELEASE_BASE_URL/$CHECKSUM_FILE"
curl --fail --location --proto '=https' --tlsv1.2 --output install.sh "$SOURCE_BASE_URL/install.sh"
curl --fail --location --proto '=https' --tlsv1.2 --output release.yml "$SOURCE_BASE_URL/.github/workflows/release.yml"

test -s "$SERVER_ASSET"
test -s "$BROKER_ASSET"
test -s "$CHECKSUM_FILE"

if ! awk -v server="$SERVER_ASSET" -v broker="$BROKER_ASSET" '
  function valid(hash) { return length(hash) == 64 && hash !~ /[^0-9a-fA-F]/ }
  $2 == server { server_count++; if (NF == 2 && valid($1)) server_line = $0 }
  $2 == broker { broker_count++; if (NF == 2 && valid($1)) broker_line = $0 }
  END {
    if (server_count != 1 || broker_count != 1 || server_line == "" || broker_line == "") exit 1
    print server_line
    print broker_line
  }
' "$CHECKSUM_FILE" > "$SELECTED_CHECKSUMS"; then
  echo "Missing, duplicate, or malformed exact checksum entry" >&2
  exit 1
fi

case "$OS" in
  darwin)
    command -v shasum >/dev/null 2>&1 || { echo "shasum is required" >&2; exit 1; }
    shasum -a 256 --check "$SELECTED_CHECKSUMS"
    ;;
  linux)
    command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
    sha256sum --check "$SELECTED_CHECKSUMS"
    ;;
esac
```

Both exact filenames must report `OK`. At this point you can delete `$STAGING_DIR` and stop without changing the managed installation. Before continuing, inspect `install.sh`, `release.yml`, `checksums-sha256.txt`, the two selected checksum lines, and the verified binary metadata in that directory. The canonical online sources are the [installer](https://github.com/almogdepaz/wolfpack/blob/main/install.sh), [release workflow](https://github.com/almogdepaz/wolfpack/blob/main/.github/workflows/release.yml), [release page](https://github.com/almogdepaz/wolfpack/releases), and [checksum asset](https://github.com/almogdepaz/wolfpack/releases/latest/download/checksums-sha256.txt); the downloaded copies above are pinned to `$VERSION`.

Optional provenance verification requires the GitHub CLI and network access. Run it on both still-unmodified release binaries:

```sh
gh attestation verify "$SERVER_ASSET" --repo almogdepaz/wolfpack
gh attestation verify "$BROKER_ASSET" --repo almogdepaz/wolfpack
```

A successful result verifies the attestation's GitHub workflow/repository identity and artifact digest. It does not independently audit source correctness, runtime behavior, or safety, and it is separate from the ad-hoc macOS signature.

Only after both checksum checks, any optional attestation checks, and your inspection succeed, install the pair and run setup from the exact managed path:

```sh
chmod +x "$SERVER_ASSET" "$BROKER_ASSET"
if [ "$OS" = "darwin" ]; then
  xattr -cr "$SERVER_ASSET" 2>/dev/null || true
  xattr -cr "$BROKER_ASSET" 2>/dev/null || true
  codesign --sign - --force "$SERVER_ASSET"
  codesign --sign - --force "$BROKER_ASSET"
fi

INSTALL_DIR="$HOME/.wolfpack/bin"
mkdir -p "$INSTALL_DIR"
mv -f "$SERVER_ASSET" "$INSTALL_DIR/wolfpack"
mv -f "$BROKER_ASSET" "$INSTALL_DIR/wolfpack-broker"
"$INSTALL_DIR/wolfpack" setup

rm -rf "$STAGING_DIR"
trap - EXIT HUP INT TERM
```

The file replacement itself does not create a PATH symlink or restart an existing service. On an upgrade, deferred setup preserves an already installed login service and writes descriptor changes without activation; the final server-only restart does not reinstall or restart a running broker, though it can start a missing required broker. The moves overwrite the managed server/broker pair and there is no automatic rollback, so stop before them or retain your own backup if inspection fails. While active sessions matter, run these steps from an external terminal and verify sessions and service state afterward. `~/.wolfpack/bin/wolfpack uninstall --yes` removes Wolfpack-managed files while preserving unrelated commands; see [uninstall](#uninstall).

## setup choices

Setup asks you to choose or confirm:

- the default projects directory used by the project catalog and name-based session creation;
- the Wolfpack port;
- Tailscale sign-in and private HTTPS remote access, when available;
- optional Pi integration, when Pi is detected; and
- whether Wolfpack should start automatically at login.

On first setup, Wolfpack enables `shell` and supported agent CLIs detected on `PATH`; it does not overwrite existing agent settings. The configured projects directory remains the default catalog and creation root. Existing directories elsewhere on the server can be opened later with the browser's **Open existing directory** field or CLI `--project-dir`; Wolfpack does not enumerate the filesystem or create arbitrary external directories. Tailscale is used for private phone and remote access. Without it, setup continues with local-only access.

## what success looks like

A successful setup prints a local URL. When Tailscale is signed in and `tailscale serve` is verified, it also prints a private Tailnet HTTPS URL and QR code. Open the local URL on the host machine, or scan only the verified remote QR code from a trusted Tailnet device.

Run the matching diagnosis command after setup:

| install path | diagnosis |
| --- | --- |
| curl | `wolfpack doctor` |
| Bunx | `bunx wolfpack-bridge@latest doctor` |
| npm/npx | `npx --yes wolfpack-bridge@latest doctor` |

`doctor` checks the server, broker, binaries, JWT configuration, Tailscale, and common service problems. Resolve any reported failures; see [troubleshooting](troubleshooting.md) for recovery steps.

## service and platform behavior

The installer supports macOS arm64/x64 and Linux x64/arm64. The bundled broker includes its Ghostty VT engine; release installs do not require Zig, Ghostty, or extra system libraries.

On macOS, Wolfpack can install a login service. On Linux, managed services use `systemd --user`; persistence after reboot needs `sudo loginctl enable-linger $USER`. Automatic Tailscale installation on Linux requires `apt`; otherwise install Tailscale yourself. You can always run Wolfpack in the foreground instead of installing a service.

Use `wolfpack service status` after a curl installation to inspect the managed service. Package-runner users should use the matching Bunx or npm prefix.

## uninstall

Uninstall removes Wolfpack-managed files and the installer-created `/usr/local/bin/wolfpack` symlink, but never an unrelated command with the same name:

| install path | uninstall |
| --- | --- |
| curl | `wolfpack uninstall --yes` |
| Bunx | `bunx wolfpack-bridge@latest uninstall --yes` |
| npm/npx | `npx --yes wolfpack-bridge@latest uninstall --yes` |

## security and trust

Wolfpack has no inter-session authorization layer. Anyone who can access its Tailnet/global endpoint can list and control visible sessions, and those sessions execute commands as the local user in selected project directories. Treat Wolfpack access as shell access to that machine.

Keep Wolfpack private to a trusted Tailnet. If other people share the Tailnet, use Tailscale device/user ACLs and consider optional JWT authentication. Wolfpack has no hosted relay or managed account; Tailscale normally provides remote HTTPS access.

For architecture and terminal ownership details, see the [README](../README.md). For failures after installation, use [troubleshooting](troubleshooting.md).
