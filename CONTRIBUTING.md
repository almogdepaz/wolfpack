# Contributing

## Dev Setup

Requires [Bun](https://bun.sh/) (stable v1.4.2+, with CI/release builds pinned to v1.4.2) and a [Rust toolchain](https://rustup.rs/) for the broker.
Source builds of `wolfpack-broker` also need Wolfpack's pinned Zig toolchain to prebuild the verified Ghostty VT static archive. Release installs already include this in the prebuilt broker binary; users installing releases do not need Zig or Ghostty installed.

```bash
git clone https://github.com/almogdepaz/wolfpack.git
cd wolfpack
bun install
scripts/setup-zig-0.16.0.sh
bun run scripts/build-ghostty-vt.ts --target "$(rustc -vV | awk '/host:/ {print $2}')"  # host Ghostty VT bundle
bun run scripts/gen-assets.ts                             # generate embedded assets (required once)
cargo build --release --manifest-path broker/Cargo.toml   # build the broker
bun run src/cli/index.ts                                  # start the server locally
```

For an end-to-end local install (build + service install + restart) on macOS, use `scripts/deploy-local.sh`. It is macOS-only; release installs and managed services support Linux, but this source-deployment script does not. Use `--broker=yes` for broker/native/Ghostty VT changes; `--broker=no` intentionally preserves the running broker and will not validate those changes.

## Testing

```bash
bun test                                  # all bun tests
bun test tests/unit/                      # unit tests only
bun test tests/unit/validation.test.ts    # single file
bunx playwright test                      # e2e (uses test-server harness)
```

Layout:

- `tests/unit/` — pure-logic tests (escaping, validation, grid logic, broker codec, agent status, push crypto, CLI parsing, etc.)
- `tests/integration/` — API routes, broker backend, WS dispatch, task gateway and relay, extensions, installation startup
- `tests/snapshot/` — launchd plist and systemd unit generation
- `tests/e2e/` — Playwright end-to-end (`test:e2e` / `test:e2e:headed`)

The Rust broker has its own tests under `broker/tests/` — run with `cargo test` from `broker/`.

The broker refuses a group- or other-writable socket parent, so tests must create every directory that holds a broker socket with mode `0700` (`mkdtempSync` already does; `mkdirSync` and `tempfile::tempdir()` inherit the umask).

## Asset Pipeline

Frontend files live in `public/`. The server doesn't serve from disk — everything is embedded into the binary:

1. Edit files in `public/` (HTML, TS, CSS, manifest, etc.)
2. Run `bun run scripts/gen-assets.ts` — bundles `public/app.ts` and ghostty-web, then embeds every file from `public/` into `src/public-assets.ts` (binary → base64, text → string)
3. **Do NOT edit `src/public-assets.ts` manually** — it's auto-generated

## Site and demo media

The homepage in `site/` is static HTML with content-hashed filenames (`<stem>.<first 16 hex of sha256>.<ext>`). Demo media is recorded from synthetic fixture sessions, never from real ones.

- **Hashed site files.** After adding or editing anything in `site/assets/`, `site/*.css` or `site/*.js`, run `bun run site:assets`: it renames new or edited files to their content hash, removes stale siblings and rewrites the references in `site/index.html`. `bun run site:check` verifies names, hashes, references and that no site or docs media would be git-ignored. Hashed files are referenced from `site/index.html` only; the stylesheet must not `url()` a hashed asset (inline `data:` URLs are fine), because the script does not rewrite CSS. A new stem also needs an entry in `RENDER_ASSET_SPECS` in `tests/unit/homepage-quality.test.ts`.
- **Tools.** Encoding needs ffmpeg ≥ 6 with libx264, libwebp, `xfade` and `subtitles`, found only through `WOLFPACK_FFMPEG` (ffprobe must sit next to it). A static build unpacked under `~/.local/opt/` works without root, for example `export WOLFPACK_FFMPEG=~/.local/opt/ffmpeg/ffmpeg`. Recording uses the Playwright Chromium already installed for e2e tests. The optional promo voiceover uses the upstream standalone piper release and a voice model, found the same strict way through `WOLFPACK_PIPER` and `WOLFPACK_PIPER_VOICE`.
- **Record.** `bun run demo:record [--scene desktop|mobile|cli|cards|all] [--dry]` boots two fixture servers (`scripts/demo/fixture-server.ts`, machines "Workstation" and "MacBook") with an isolated temporary HOME on random loopback ports, then drives the real app in headless Chromium. The MacBook is a second fixture instance bridged in as a verified tailnet peer, including its terminal websocket. `--dry` writes checkpoint screenshots only; otherwise screencast frames land in `.demo-out/<scene>/` (git-ignored). Recording refuses to start with less than 4 GB free.
- **Encode.** `bun run demo:encode [--target <name>|all] [--keep-frames]` cuts the frames between recorder checkpoints into the site loops, README GIFs and per-scene promo sources, enforces each target's duration and size budget, writes `.demo-out/encode.json` and then deletes the frames. A plain `demo:encode` also builds the promo long cut in `.demo-out/promo/` (captions burned in, sidecar `.vtt`, 1280×720 social cut, poster; it renders caption overlays in Chromium and adds about two minutes); `--voiceover` and `--music <file>` add a soundtrack mixed to −18 LUFS. Frames are only deleted once every target reading them, the promo included, was encoded in that run; `--install` copies site, README and docs outputs into place and re-hashes `site/`. `--list` prints the targets.
- **Fixtures.** Sessions, machines and reactions to typed input live in `scripts/demo/fixtures/sessions.json`; terminal content lives in `scripts/demo/fixtures/transcripts/*.ans` (format documented in `scripts/demo/fixtures.ts`). Use fictional projects, files and `*.example.ts.net` hosts only. Cards for titles, the CLI and install steps are HTML in `scripts/demo/cards/`.
- **Privacy gate.** The recorder checks the page HTML at every checkpoint and at screencast start/stop against this machine's hostname, username, home directory and Tailscale names, plus `--forbid a,b`. Run `bun scripts/demo/privacy-gate.ts [--forbid a,b] <paths…>` over any text you are about to commit (site, docs, captions).

## Building Binaries

```bash
WOLFPACK_BUILD_MODE=local bun run scripts/build.ts
```

Local mode builds all four `wolfpack` binaries plus a fresh host broker under `dist/local/<target>`; it emits no platform npm packages. `package-all` requires four pre-staged, proven release brokers under `dist/broker/<target>` and emits the platform packages.

**Tailnet release gate:** Before a Tailnet release, complete physical-device release checks; physical-device evidence is required, and automated checks do not substitute for it.

Before local release-style builds that compile the broker, run:

```bash
scripts/setup-zig-0.16.0.sh
bun run scripts/build-ghostty-vt.ts --target "$(rustc -vV | awk '/host:/ {print $2}')"
```

Without the verified Ghostty VT bundle, Cargo fails closed instead of downloading or selecting native code during `build.rs`.

## Support and reporting

- Setup or runtime recovery: [troubleshooting](docs/troubleshooting.md).
- Questions and usage help: [GitHub Discussions](https://github.com/almogdepaz/wolfpack/discussions).
- Reproducible defects: [bug-report form](https://github.com/almogdepaz/wolfpack/issues/new?template=bug-report.yml).
- Product proposals: [feature-request form](https://github.com/almogdepaz/wolfpack/issues/new?template=feature-request.yml).
- Suspected vulnerabilities: [private security reporting](SECURITY.md), never a public issue or discussion.

## PR Conventions

- Branch off `main`
- Tests must pass (`bun test`)
- Keep PRs focused — one feature or fix per PR
- Match existing style; no large unrelated refactors mixed in
