# Contributing

## Dev Setup

Requires [Bun](https://bun.sh/) (v1.2+) and a [Rust toolchain](https://rustup.rs/) for the broker.
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
bun test tests/unit/plan-parsing.test.ts  # single file
bunx playwright test                      # e2e (uses test-server harness)
```

Layout:

- `tests/unit/` — pure-logic tests (plan parsing, ralph log parsing, escaping, validation, grid logic, broker codec, etc.)
- `tests/integration/` — API routes, broker backend, ralph loop endpoints, WS dispatch
- `tests/snapshot/` — launchd plist and systemd unit generation
- `tests/e2e/` — Playwright end-to-end (`test:e2e` / `test:e2e:headed`)

The Rust broker has its own tests under `broker/tests/` — run with `cargo test` from `broker/`.

## Asset Pipeline

Frontend files live in `public/`. The server doesn't serve from disk — everything is embedded into the binary:

1. Edit files in `public/` (HTML, TS, CSS, manifest, etc.)
2. Run `bun run scripts/gen-assets.ts` — bundles `public/app.ts` and ghostty-web, then embeds every file from `public/` into `src/public-assets.ts` (binary → base64, text → string)
3. **Do NOT edit `src/public-assets.ts` manually** — it's auto-generated

## Building Release Binaries

```bash
bun run scripts/build.ts
```

Produces `wolfpack` for linux-x64, linux-arm64, darwin-x64, darwin-arm64 plus per-platform npm package directories in `dist/`. Also stages `wolfpack-broker` per platform — in CI it expects pre-built broker binaries under `dist/broker/<target>/`; locally it falls back to a host-arch-only `cargo build --release`.

Before local release-style builds that compile the broker, run:

```bash
scripts/setup-zig-0.16.0.sh
bun run scripts/build-ghostty-vt.ts --target "$(rustc -vV | awk '/host:/ {print $2}')"
```

Without the verified Ghostty VT bundle, Cargo fails closed instead of downloading or selecting native code during `build.rs`.

## PR Conventions

- Branch off `main`
- Tests must pass (`bun test`)
- Keep PRs focused — one feature or fix per PR
- Match existing style; no large unrelated refactors mixed in

## Migrating Old Plan Files

If you have a Ralph plan file from before the `## N. Title` header convention:

```bash
wolfpack migrate-plan PLAN.md
```

This rewrites the file in place.
