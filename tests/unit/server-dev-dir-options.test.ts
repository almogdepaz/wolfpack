import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createProjectSettingsRoutes } from "../../src/server/project-settings-routes.ts";
import { resolveExistingProjectSelection } from "../../src/server/project-selection.ts";
import { validateProjectDir } from "../../src/server/validate-project-dir.ts";

test("default development root captures import while containment still reads current environment", () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-dev-default-"));
  const env: NodeJS.ProcessEnv = { ...process.env, WOLFPACK_DIR: root, WOLFPACK_DEV_DIR: join(root, "first") };
  delete env.WOLFPACK_TEST;
  try {
    const child = Bun.spawnSync([process.execPath, "-e", `
      const { DEV_DIR, isUnderDevDir } = await import(${JSON.stringify(new URL("../../src/server/dev-dir.ts", import.meta.url).href)});
      const first = process.env.WOLFPACK_DEV_DIR;
      process.env.WOLFPACK_DEV_DIR = first + "-later";
      console.log(JSON.stringify([DEV_DIR === first, isUnderDevDir(first), isUnderDevDir(first + "-later")]));
    `], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual([true, false, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit development root controls project selection, containment and route discovery", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-dev-option-")));
  const devDir = join(root, "dev");
  mkdirSync(join(devDir, "example"), { recursive: true });
  const context = createServerContext({ backend: new MockBackend(), config: null, devDir });
  const routes = createProjectSettingsRoutes(context);
  const server = createServer((req, res) => {
    void Promise.resolve(routes["GET /api/projects"]!(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  try {
    expect(resolveExistingProjectSelection({ project: "example" }, devDir)).toEqual({
      ok: true, value: { project: "example", projectDir: join(devDir, "example") },
    });
    expect(validateProjectDir(root, devDir)).toMatchObject({ ok: false, code: "not_dir" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: ["example"] });
  } finally {
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await context.close();
    rmSync(root, { recursive: true, force: true });
  }
});
