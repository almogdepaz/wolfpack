import { test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.OWNED_BUN_TEST_ACTOR;

test("owned Bun test actor", async () => {
  if (mode === "early") process.exit(23);
  if (mode === "signal") process.kill(process.pid, "SIGTERM");
  if (mode === "grandchild") {
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    writeFileSync(process.env.OWNED_BUN_TEST_MARKER!, String(child.pid));
    child.unref();
    process.exit(0);
  }
  if (mode === "server-grandchild") {
    const marker = process.env.OWNED_BUN_TEST_MARKER!;
    const code = `import { writeFileSync } from "node:fs"; const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned-server") }); writeFileSync(process.env.OWNED_BUN_TEST_MARKER, JSON.stringify({ child: process.pid, port: server.port }));`;
    const child = spawn(process.execPath, ["-e", code], { stdio: "ignore", env: process.env });
    const deadline = performance.now() + 1_000;
    while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(10);
    if (!existsSync(marker)) throw new Error("owned HTTP server did not bind");
    writeFileSync(marker, JSON.stringify({ root: process.pid, ...JSON.parse(readFileSync(marker, "utf8")) }));
    child.unref();
    process.exit(0);
  }
  if (mode === "inherited-grandchild" || mode === "inherited-stdio-grandchild" || mode === "stall-grandchild") {
    const child = spawn("/bin/sleep", ["60"], { stdio: mode === "inherited-stdio-grandchild" ? ["ignore", "inherit", "inherit"] : "ignore" });
    writeFileSync(process.env.OWNED_BUN_TEST_MARKER!, JSON.stringify({ root: process.pid, child: child.pid }));
    child.unref();
    if (mode !== "stall-grandchild") process.exit(0);
    await new Promise<void>(() => {});
  }
  if (mode === "stall") await new Promise<void>(() => {});
});
