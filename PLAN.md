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
- [x] verify all node APIs used work in bun (`node:http`, `node:fs`, `node:child_process`, `node:os`, `node:readline`, `node:util`)
- [x] verify `qrcode-terminal` npm package works under bun
- [x] verify `import.meta.dirname` behavior in bun compile mode
- [x] check `execFileSync`, `execFile` (promisified) behavior

#### audit results
All 6 node: modules (`node:http`, `node:fs`, `node:child_process`, `node:os`, `node:readline`, `node:util`) are supported in bun ≥1.2. Also `node:fs/promises` (dynamic import in serve.ts:490) works fine.

**qrcode-terminal**: pure JS, zero node-specific APIs. will bundle cleanly with bun. no vendoring needed.

**import.meta.dirname**: CONFIRMED RISK. in `bun build --compile`, `import.meta.dirname` returns `/$bunfs/root/` (virtual embedded FS), NOT the real directory. this is by design (oven-sh/bun#8476, closed as "not planned"). workaround: use `process.execPath` for binary location, or `process.cwd()` for working dir. current usages that need fixing:
- `serve.ts:48` — `PUBLIC_DIR = join(import.meta.dirname, "public")` → replaced by embedded assets (phase 1.2)
- `serve.ts:51` — `SETTINGS_PATH = join(import.meta.dirname, "bridge-settings.json")` → use `~/.wolfpack/bridge-settings.json` or similar
- `cli.ts:421-422` — plist generation refs tsx/serve.ts → replaced by `process.execPath` (phase 1.4)
- `cli.ts:463-464` — systemd unit refs tsx/serve.ts → replaced by `process.execPath` (phase 1.4)

**execFileSync / execFile (promisified)**: fully supported in bun. `promisify(execFile)` works. the `test -x` pattern used for tmux/shell resolution (serve.ts:28-44) is fine.

### 1.2 embed public/ assets
- [x] create `public-assets.ts` — build-time generated module that exports all files from `public/` as a `Map<string, string|Buffer>`
- [x] write `scripts/gen-assets.ts` to scan `public/` and generate the module (each file imported as text/bytes)
- [x] the generated module looks like:
  ```ts
  export const assets = new Map<string, { content: string | Uint8Array; mime: string }>([
    ["index.html", { content: "...", mime: "text/html; charset=utf-8" }],
    ["manifest.json", { content: "...", mime: "application/manifest+json" }],
    // ...
  ]);
  ```

### 1.3 refactor serve.ts
- [x] replace `readFileSync(join(PUBLIC_DIR, ...))` with lookups from embedded assets map
- [x] `serveFile()` reads from map instead of disk
- [x] manifest.json route: parse from embedded template, mutate at runtime (same as now)
- [x] remove `PUBLIC_DIR` constant
- [x] remove `import.meta.dirname` usage for public dir resolution (keep for other paths if needed)

### 1.4 refactor cli.ts service generation
- [x] launchd plist: `ProgramArguments` should point to the binary itself (`wolfpack`), not `tsx serve.ts`
- [x] systemd unit: `ExecStart` should point to the binary itself
- [x] remove all references to `tsx`, `node_modules`, `process.execPath` in service generation
- [x] binary path: use `process.execPath` (in bun compile this is the binary itself)
- [x] remove `checkNodeVersion()` from setup — no longer needed
- [x] remove node from missing deps check

### 1.5 qr.ts
- [x] inline or vendor `qrcode-terminal` if it causes bun issues, otherwise leave as-is (bun bundles npm deps automatically)

#### qr.ts results
Tested `qrcode-terminal` under both `bun` runtime and `bun build --compile`. Works perfectly in both cases — pure JS, 12 modules bundled, QR output renders correctly from compiled binary. No vendoring or inlining needed; leaving as-is.

---

## phase 2: build pipeline

### 2.1 build script (`scripts/build.ts`)
- [x] run `scripts/gen-assets.ts` first to generate embedded assets
- [x] compile for all 4 targets:
  ```
  bun build --compile --target=bun-linux-x64 cli.ts --outfile dist/wolfpack-linux-x64
  bun build --compile --target=bun-linux-arm64 cli.ts --outfile dist/wolfpack-linux-arm64
  bun build --compile --target=bun-darwin-x64 cli.ts --outfile dist/wolfpack-darwin-x64
  bun build --compile --target=bun-darwin-arm64 cli.ts --outfile dist/wolfpack-darwin-arm64
  ```
- [x] output to `dist/`
- [x] add `dist/` to `.gitignore`

### 2.2 github actions (`.github/workflows/release.yml`)
- [x] trigger on tag push (`v*`)
- [x] install bun
- [x] run build script
- [x] create github release with tag name
- [x] upload all 4 binaries as release assets
- [x] (optional) attach sha256 checksums

---

## phase 3: installer update

### 3.1 rewrite `install.sh`
- [x] detect OS + arch (`uname -s`, `uname -m`)
- [x] map to binary name (`wolfpack-linux-x64`, `wolfpack-darwin-arm64`, etc.)
- [x] download from `https://github.com/almogdepaz/wolfpack/releases/latest/download/<binary>`
- [x] install to `~/.wolfpack/bin/wolfpack` (or `/usr/local/bin/wolfpack`)
- [x] `chmod +x`
- [x] add to PATH if needed (or symlink to /usr/local/bin)
- [x] still check for tmux + tailscale (those remain system deps)
- [x] remove all node/npm/git-clone logic
- [x] run `wolfpack setup` at end

---

## phase 4: cleanup

### 4.1 remove node-specific files
- [x] remove `package-lock.json`
- [x] simplify `package.json` to just metadata (or remove entirely, use bunfig.toml)
- [x] remove `tsx` dependency references
- [x] add `bunfig.toml` if needed (not needed — bun defaults work fine)

### 4.2 generated file management
- [x] `public-assets.ts` is gitignored (generated at build time)
- [x] decision: gitignore — build script runs gen-assets as step 1, no need to commit

### 4.3 dev workflow
- [x] developers still need bun installed to build/run
- [x] `bun run cli.ts` for dev (works without compile) — verified
- [x] `bun run scripts/build.ts` to produce binaries — verified, all 4 targets build
- [ ] document in README (→ phase 4.4)

### 4.4 update README
- [x] new install instructions (curl one-liner downloads binary)
- [x] remove node prereq
- [x] add "building from source" section for contributors

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
