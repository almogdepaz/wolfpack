# bun compile migration plan

> goal: distribute wolfpack as a single binary per platform. no node/npm required for end users.

## decisions
- **assets**: embedded in binary (single file distribution)
- **platforms**: linux-x64, linux-arm64, darwin-x64, darwin-arm64
- **CI**: github actions, triggered on tag push
- **legacy**: fully replaced, no node/npm fallback

---

## phase 1: bun compatibility + asset embedding

### 1.1 audit bun compat
- [ ] verify all node APIs used work in bun (`node:http`, `node:fs`, `node:child_process`, `node:os`, `node:readline`, `node:util`)
- [ ] verify `qrcode-terminal` npm package works under bun
- [ ] verify `import.meta.dirname` behavior in bun compile mode
- [ ] check `execFileSync`, `execFile` (promisified) behavior

### 1.2 embed public/ assets
- [ ] create `public-assets.ts` — build-time generated module that exports all files from `public/` as a `Map<string, string|Buffer>`
- [ ] write `scripts/gen-assets.ts` to scan `public/` and generate the module (each file imported as text/bytes)
- [ ] the generated module looks like:
  ```ts
  export const assets = new Map<string, { content: string | Uint8Array; mime: string }>([
    ["index.html", { content: "...", mime: "text/html; charset=utf-8" }],
    ["manifest.json", { content: "...", mime: "application/manifest+json" }],
    // ...
  ]);
  ```

### 1.3 refactor serve.ts
- [ ] replace `readFileSync(join(PUBLIC_DIR, ...))` with lookups from embedded assets map
- [ ] `serveFile()` reads from map instead of disk
- [ ] manifest.json route: parse from embedded template, mutate at runtime (same as now)
- [ ] remove `PUBLIC_DIR` constant
- [ ] remove `import.meta.dirname` usage for public dir resolution (keep for other paths if needed)

### 1.4 refactor cli.ts service generation
- [ ] launchd plist: `ProgramArguments` should point to the binary itself (`wolfpack`), not `tsx serve.ts`
- [ ] systemd unit: `ExecStart` should point to the binary itself
- [ ] remove all references to `tsx`, `node_modules`, `process.execPath` in service generation
- [ ] binary path: use `process.execPath` (in bun compile this is the binary itself)
- [ ] remove `checkNodeVersion()` from setup — no longer needed
- [ ] remove node from missing deps check

### 1.5 qr.ts
- [ ] inline or vendor `qrcode-terminal` if it causes bun issues, otherwise leave as-is (bun bundles npm deps automatically)

---

## phase 2: build pipeline

### 2.1 build script (`scripts/build.ts`)
- [ ] run `scripts/gen-assets.ts` first to generate embedded assets
- [ ] compile for all 4 targets:
  ```
  bun build --compile --target=bun-linux-x64 cli.ts --outfile dist/wolfpack-linux-x64
  bun build --compile --target=bun-linux-arm64 cli.ts --outfile dist/wolfpack-linux-arm64
  bun build --compile --target=bun-darwin-x64 cli.ts --outfile dist/wolfpack-darwin-x64
  bun build --compile --target=bun-darwin-arm64 cli.ts --outfile dist/wolfpack-darwin-arm64
  ```
- [ ] output to `dist/`
- [ ] add `dist/` to `.gitignore`

### 2.2 github actions (`.github/workflows/release.yml`)
- [ ] trigger on tag push (`v*`)
- [ ] install bun
- [ ] run build script
- [ ] create github release with tag name
- [ ] upload all 4 binaries as release assets
- [ ] (optional) attach sha256 checksums

---

## phase 3: installer update

### 3.1 rewrite `install.sh`
- [ ] detect OS + arch (`uname -s`, `uname -m`)
- [ ] map to binary name (`wolfpack-linux-x64`, `wolfpack-darwin-arm64`, etc.)
- [ ] download from `https://github.com/almogdepaz/wolfpack/releases/latest/download/<binary>`
- [ ] install to `~/.wolfpack/bin/wolfpack` (or `/usr/local/bin/wolfpack`)
- [ ] `chmod +x`
- [ ] add to PATH if needed (or symlink to /usr/local/bin)
- [ ] still check for tmux + tailscale (those remain system deps)
- [ ] remove all node/npm/git-clone logic
- [ ] run `wolfpack setup` at end

---

## phase 4: cleanup

### 4.1 remove node-specific files
- [ ] remove `package-lock.json`
- [ ] simplify `package.json` to just metadata (or remove entirely, use bunfig.toml)
- [ ] remove `tsx` dependency references
- [ ] add `bunfig.toml` if needed

### 4.2 generated file management
- [ ] `public-assets.ts` should be gitignored (generated at build time)
- [ ] OR committed for dev convenience — TBD

### 4.3 dev workflow
- [ ] developers still need bun installed to build/run
- [ ] `bun run cli.ts` for dev (works without compile)
- [ ] `bun run scripts/build.ts` to produce binaries
- [ ] document in README

### 4.4 update README
- [ ] new install instructions (curl one-liner downloads binary)
- [ ] remove node prereq
- [ ] add "building from source" section for contributors

---

## files touched
| file | action |
|---|---|
| `serve.ts` | refactor static file serving to use embedded assets |
| `cli.ts` | remove node checks, fix service generation paths |
| `qr.ts` | possibly vendor dep |
| `scripts/gen-assets.ts` | NEW — generates asset bundle |
| `scripts/build.ts` | NEW — orchestrates build for all targets |
| `public-assets.ts` | NEW (generated) — embedded assets map |
| `install.sh` | rewrite — download binary instead of git clone |
| `.github/workflows/release.yml` | NEW — CI build + release |
| `.gitignore` | add dist/, public-assets.ts |
| `package.json` | simplify or remove |
| `package-lock.json` | remove |
| `README.md` | update install instructions |

## risks
- bun compile `import.meta.dirname` might not behave as expected — need to test early
- `qrcode-terminal` might have issues bundling — fallback: vendor it
- embedded assets increase binary size (public/ dir size matters)
- cross-compilation in CI: bun handles this natively, but arm64 builds should be tested
