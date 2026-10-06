import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function ready(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("compiled fixture did not become ready")), 5_000);
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error("compiled fixture exited before readiness"));
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4096) { finish(new Error("compiled fixture readiness exceeded bound")); return; }
      if (!output.includes("\n")) return;
      try {
        const value = JSON.parse(output.slice(0, output.indexOf("\n"))) as { port?: unknown };
        if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("invalid fixture port");
        finish(undefined, value.port);
      } catch { finish(new Error("invalid compiled fixture readiness")); }
    };
    function finish(error?: Error, port?: number) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(port!);
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
  try { child.kill("SIGTERM"); await exited; }
  finally { clearTimeout(kill); }
}

test("compiled host loads authenticated runtime bundles outside the source checkout", async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-compiled-loader-")));
  const emptyCwd = join(root, "empty-cwd");
  const runtimePackage = join(root, "installed-package");
  mkdirSync(emptyCwd); mkdirSync(runtimePackage);
  let child: ChildProcessWithoutNullStreams | undefined;
  const writeBundle = (value: string) => {
    const source = `export const result = ${JSON.stringify(value)};\n`;
    writeFileSync(join(runtimePackage, "bundle.js"), source);
    writeFileSync(join(runtimePackage, "inventory.json"), JSON.stringify({ sha256: createHash("sha256").update(source).digest("hex") }));
  };
  try {
    execFileSync("bun", ["build", join(sourceRoot, "public", "extension-loader.ts"), "--outfile", join(root, "loader.js"), "--target=browser", "--format=esm"], { stdio: "pipe", timeout: 15_000 });
    writeFileSync(join(root, "entry.ts"), [
      'import loader from "./loader.js" with { type: "text" };',
      `import { startCompiledExtensionFixture } from ${JSON.stringify(join(sourceRoot, "tests", "spikes", "extension-compiled-host.ts"))};`,
      "startCompiledExtensionFixture(loader, process.argv[2]!);",
    ].join("\n"));
    const executable = join(root, "compiled-host");
    execFileSync("bun", ["build", "--compile", join(root, "entry.ts"), "--outfile", executable], { stdio: "pipe", timeout: 15_000 });
    writeBundle("runtime-v1");
    child = spawn(executable, [runtimePackage], { cwd: emptyCwd, stdio: "pipe" });
    // The verification runner retains complete test stderr in its private log.
    child.stderr.pipe(process.stderr, { end: false });
    const port = await ready(child);
    const origin = `http://127.0.0.1:${port}`;
    await page.goto(origin);
    await expect(page.locator("output")).toHaveText("runtime-v1");
    const first = await (await page.request.get(`${origin}/metrics`)).json();
    expect(first).toMatchObject({ requests: 1, authorized: 1, cwd: emptyCwd });

    await page.goto(`${origin}?mode=missing`);
    await expect(page.locator("output")).toHaveText("FETCH_FAILED");
    const beforeSafe = await (await page.request.get(`${origin}/metrics`)).json();
    await page.goto(`${origin}?mode=safe`);
    await expect(page.locator("output")).toHaveText("SAFE_MODE");
    expect((await (await page.request.get(`${origin}/metrics`)).json()).requests).toBe(beforeSafe.requests);
    await page.goto(`${origin}?mode=digest`);
    await expect(page.locator("output")).toHaveText("INTEGRITY_MISMATCH");

    // Explicit package-code replacement in this fixture proves runtime assets
    // are not accidentally embedded at native compile time. It is not the
    // later Agent Context skill/data-publication acceptance story.
    writeBundle("runtime-v2");
    await page.goto(origin);
    await expect(page.locator("output")).toHaveText("runtime-v2");
    expect(page.url()).not.toContain("compiled-fixture-token");
  } finally {
    if (child) await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});
