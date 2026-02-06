#!/usr/bin/env bun
/**
 * Bun compatibility audit for wolfpack.
 * Tests all node APIs used across cli.ts, serve.ts, qr.ts.
 */

let pass = 0;
let fail = 0;

function ok(label: string) {
  pass++;
  console.log(`  ✓ ${label}`);
}
function bad(label: string, err: unknown) {
  fail++;
  console.error(`  ✗ ${label}: ${err}`);
}

// ── node:http ──
console.log("\n── node:http ──");
try {
  const { createServer } = await import("node:http");
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => srv.listen(0, resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  // test actual request
  const resp = await fetch(`http://localhost:${port}/`);
  const body = await resp.text();
  if (body !== "ok") throw new Error(`unexpected body: ${body}`);
  srv.close();
  ok("createServer + listen + request round-trip");
} catch (e) {
  bad("node:http", e);
}

// ── node:fs ──
console.log("\n── node:fs ──");
try {
  const {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
  } = await import("node:fs");

  const tmpDir = "/tmp/wolfpack-bun-test";
  mkdirSync(tmpDir, { recursive: true });
  ok("mkdirSync");

  writeFileSync(`${tmpDir}/test.txt`, "hello bun");
  ok("writeFileSync");

  const content = readFileSync(`${tmpDir}/test.txt`, "utf-8");
  if (content !== "hello bun") throw new Error("readFileSync mismatch");
  ok("readFileSync");

  if (!existsSync(`${tmpDir}/test.txt`)) throw new Error("existsSync false");
  ok("existsSync");

  const entries = readdirSync(tmpDir);
  if (!entries.includes("test.txt")) throw new Error("readdirSync missing file");
  ok("readdirSync");

  const st = statSync(`${tmpDir}/test.txt`);
  if (!st.isFile()) throw new Error("statSync.isFile() false");
  ok("statSync");

  unlinkSync(`${tmpDir}/test.txt`);
  if (existsSync(`${tmpDir}/test.txt`)) throw new Error("unlinkSync failed");
  ok("unlinkSync");
} catch (e) {
  bad("node:fs", e);
}

// ── node:fs/promises (dynamic import, as used in serve.ts) ──
console.log("\n── node:fs/promises ──");
try {
  const tmpDir = "/tmp/wolfpack-bun-test";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${tmpDir}/test2.txt`, "async test");
  const fsp = await import("node:fs/promises");
  const st = await fsp.stat(`${tmpDir}/test2.txt`);
  if (!st.isFile()) throw new Error("fs/promises stat failed");
  ok("dynamic import + stat");
  await fsp.unlink(`${tmpDir}/test2.txt`);
} catch (e) {
  bad("node:fs/promises", e);
}

// ── node:path ──
console.log("\n── node:path ──");
try {
  const { join, basename } = await import("node:path");
  const p = join("/foo", "bar", "baz.txt");
  if (p !== "/foo/bar/baz.txt") throw new Error(`join: ${p}`);
  ok("join");
  const b = basename("/foo/bar/baz.txt");
  if (b !== "baz.txt") throw new Error(`basename: ${b}`);
  ok("basename");
} catch (e) {
  bad("node:path", e);
}

// ── node:os ──
console.log("\n── node:os ──");
try {
  const { platform, hostname } = await import("node:os");
  const plat = platform();
  if (!["darwin", "linux", "win32"].includes(plat))
    throw new Error(`platform: ${plat}`);
  ok(`platform() = "${plat}"`);
  const h = hostname();
  if (typeof h !== "string" || h.length === 0)
    throw new Error(`hostname empty`);
  ok(`hostname() = "${h}"`);
} catch (e) {
  bad("node:os", e);
}

// ── node:child_process ──
console.log("\n── node:child_process ──");
try {
  const { execSync, execFileSync, execFile } = await import(
    "node:child_process"
  );

  // execSync
  const out1 = execSync("echo hello", { encoding: "utf-8" }).trim();
  if (out1 !== "hello") throw new Error(`execSync: "${out1}"`);
  ok("execSync");

  // execSync with stdio: 'ignore'
  execSync("true", { stdio: "ignore" });
  ok('execSync (stdio: "ignore")');

  // execFileSync
  execFileSync("test", ["-x", "/bin/sh"]);
  ok("execFileSync");

  // execFile (callback)
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec("echo", ["bun test"]);
  if (stdout.trim() !== "bun test")
    throw new Error(`execFile: "${stdout.trim()}"`);
  ok("execFile (promisified)");
} catch (e) {
  bad("node:child_process", e);
}

// ── node:readline ──
console.log("\n── node:readline ──");
try {
  const readline = await import("node:readline");
  // Just verify the module loads and createInterface exists
  if (typeof readline.createInterface !== "function")
    throw new Error("createInterface not a function");
  ok("createInterface exists");
} catch (e) {
  bad("node:readline", e);
}

// ── node:util ──
console.log("\n── node:util ──");
try {
  const { promisify } = await import("node:util");
  if (typeof promisify !== "function")
    throw new Error("promisify not a function");
  ok("promisify");
} catch (e) {
  bad("node:util", e);
}

// ── import.meta.dirname ──
console.log("\n── import.meta.dirname ──");
try {
  const d = import.meta.dirname;
  if (typeof d !== "string" || d.length === 0)
    throw new Error(`dirname: ${d}`);
  ok(`import.meta.dirname = "${d}"`);
} catch (e) {
  bad("import.meta.dirname", e);
}

// ── qrcode-terminal ──
console.log("\n── qrcode-terminal ──");
try {
  const qr = await import("qrcode-terminal");
  const mod = qr.default ?? qr;
  await new Promise<void>((resolve, reject) => {
    mod.generate("https://example.com", { small: true }, (code: string) => {
      if (typeof code !== "string" || code.length === 0) {
        reject(new Error("empty QR output"));
        return;
      }
      ok(`qrcode-terminal generates ${code.split("\\n").length} lines`);
      resolve();
    });
  });
} catch (e) {
  bad("qrcode-terminal", e);
}

// ── process globals ──
console.log("\n── process globals ──");
try {
  if (typeof process.execPath !== "string" || !process.execPath)
    throw new Error("no execPath");
  ok(`process.execPath = "${process.execPath}"`);

  if (typeof process.env.HOME !== "string")
    throw new Error("no HOME");
  ok(`process.env.HOME = "${process.env.HOME}"`);

  if (!Array.isArray(process.argv))
    throw new Error("argv not array");
  ok("process.argv is array");
} catch (e) {
  bad("process globals", e);
}

// ── Summary ──
console.log(`\n${"═".repeat(40)}`);
console.log(`  PASS: ${pass}  FAIL: ${fail}`);
if (fail > 0) {
  console.log("  ⚠ Some tests failed — review above.");
  process.exit(1);
} else {
  console.log("  All node APIs verified compatible with bun.");
}
