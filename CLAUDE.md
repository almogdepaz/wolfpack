# CLAUDE.md

Wolfpack is a PWA mobile command center for tmux-based AI agent sessions. Local HTTP/WebSocket server (via Tailscale HTTPS) lets you control dev sessions from your phone.

## Architecture

```
src/
  cli/          # CLI entry point — setup, config, service management
  server/       # HTTP + WebSocket server, tmux bridge, ralph orchestration
  *.ts          # shared modules (auth, validation, terminal, worktree, etc.)
public/         # PWA frontend (served as embedded assets in binary)
scripts/        # build, publish, asset generation, client lib bundling
tests/
  unit/         # fast, no server needed
  integration/  # spins up server, tests API + WS
  e2e/          # playwright browser tests
  snapshot/     # plist/systemd snapshot tests
```

## Commands

```bash
bun install                                # install deps
bun test                                   # run all tests (928 tests across 34 files)
bun test tests/unit/                       # unit tests only
bun test tests/unit/plan-parsing.test.ts   # single test file
bun test:e2e                               # playwright e2e tests
bun test:e2e:headed                        # e2e with visible browser
bun run scripts/gen-assets.ts              # regenerate embedded assets from public/
bun run scripts/build.ts                   # full build (assets + 4 platform binaries + npm packages)
bun run scripts/publish.ts                 # publish all 5 npm packages (--dry-run supported)
```

## Deploy

**ALWAYS deploy via compiled binary.** The service runs `~/.wolfpack/bin/wolfpack` (NOT `bun cli.ts`). Source edits have NO effect until rebuild + copy + restart:

```bash
bun run scripts/build.ts                                         # rebuild
cp dist/wolfpack-darwin-arm64 ~/.wolfpack/bin/wolfpack            # deploy
codesign -f -s - ~/.wolfpack/bin/wolfpack                        # re-sign (macOS kills unsigned binaries)
launchctl kickstart -k gui/$(id -u)/com.wolfpack.server          # restart
```

Or use the convenience script: `scripts/deploy-local.sh`

## Embedded Assets

`src/public-assets.ts` is auto-generated — it embeds all bundled frontend files into the binary. **After editing any file in `public/`**, regenerate and commit it:

```bash
bun run scripts/gen-assets.ts
git add src/public-assets.ts
```

CI checks this: it regenerates assets then runs `git diff --exit-code src/public-assets.ts`. If the committed file is stale, CI fails.

## CI/CD

- `.github/workflows/test.yml` — `bun test` on PR/push to main
- `.github/workflows/release.yml` — builds 4 binaries on `v*` tags, creates GitHub release
- **gotcha**: auth integration tests run in a separate step because JWT env vars contaminate bun's shared module cache
