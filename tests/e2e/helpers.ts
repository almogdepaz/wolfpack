/**
 * Playwright e2e test helpers — server lifecycle + mock tmux.
 *
 * Spawns the real wolfpack server via `bun tests/e2e/test-server.ts` as a
 * child process with tmux stubs. Playwright drives a real browser against it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestServer {
  port: number;
  baseUrl: string;
  /** Kill the server subprocess */
  close(): void;
}

// ── Server startup ───────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Start the wolfpack test server as a bun subprocess on a random port.
 *
 * Resolves once `READY:<port>` is printed to stdout.
 * Call `close()` in afterAll to tear down.
 */
export function startTestServer(): Promise<TestServer> {
  return new Promise<TestServer>((resolve, reject) => {
    const child: ChildProcess = spawn(
      "bun",
      [join(ROOT, "tests", "e2e", "test-server.ts")],
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, WOLFPACK_TEST: "1" },
      },
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("test server did not start within 10s"));
    }, 10_000);

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        const port = Number(match[1]);
        resolve({
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          close() {
            child.kill("SIGTERM");
          },
        });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Forward server stderr for debugging (filtered in test-server.ts)
      const msg = chunk.toString().trim();
      if (msg) process.stderr.write(`[test-server] ${msg}\n`);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      // If it exits before READY, that's a failure
      if (!stdout.includes("READY:")) {
        clearTimeout(timeout);
        reject(new Error(`test server exited with code ${code} before ready`));
      }
    });
  });
}

// ── Viewport presets ─────────────────────────────────────────────────────────

export const VIEWPORTS = {
  "iphone-se": { width: 375, height: 667 },
  "iphone-14": { width: 390, height: 844 },
  desktop: { width: 1280, height: 720 },
} as const;

// ── Common test utilities ────────────────────────────────────────────────────

/** Wait for the app to be interactive (sessions view loaded) */
export async function waitForApp(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("body", { state: "visible" });
}
