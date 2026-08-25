/**
 * Playwright e2e test helpers — server lifecycle + mock tmux.
 *
 * Spawns the real wolfpack server via `bun tests/e2e/test-server.ts` as a
 * child process with tmux stubs. Playwright drives a real browser against it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestServer {
  port: number;
  baseUrl: string;
  /** Kill the server subprocess */
  close(): void;
}

export interface TestServerOptions {
  readonly home?: string;
}

// ── Server startup ───────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Start the wolfpack test server as a bun subprocess on a random port.
 *
 * Resolves once `READY:<port>` is printed to stdout.
 * Call `close()` in afterAll to tear down.
 */
export function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  return new Promise<TestServer>((resolve, reject) => {
    const child: ChildProcess = spawn(
      "bun",
      [join(ROOT, "tests", "e2e", "test-server.ts")],
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: options.home ?? process.env.HOME, WOLFPACK_TEST: "1" },
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

/** Wait for the app to be interactive (sessions view loaded). */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("body", { state: "visible" });
}

async function sessionAction(page: Page, action: "open-session" | "toggle-grid", session: string, machine?: string): Promise<Locator> {
  const candidates = page.locator(`[data-action="${action}"]`).filter({ visible: true });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const dataset = await candidate.evaluate((element) => {
      const { session: elementSession = "", machine: elementMachine = "" } = (element as HTMLElement).dataset;
      return { session: elementSession, machine: elementMachine };
    });
    if (dataset.session === session && (machine === undefined || dataset.machine === machine)) return candidate;
  }
  throw new Error(`visible ${action} control not found for session ${JSON.stringify(session)}`);
}

async function drawerSessionAction(page: Page, session: string, machine?: string): Promise<Locator> {
  const expectedValue = machine ? `${machine}|${session}` : session;
  const candidates = page.locator("#session-drawer .drawer-item").filter({ visible: true });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const value = await candidate.evaluate((element) => (element as HTMLElement).dataset.val || "");
    if (value === expectedValue) return candidate;
  }
  throw new Error(`visible drawer control not found for session ${JSON.stringify(session)}`);
}

/** Open a session through a real keyboard- or pointer-accessible UI control. */
export async function openSessionFromUi(page: Page, session: string, machine?: string): Promise<void> {
  const terminalChip = page.locator("#session-chip").filter({ visible: true });
  if (await terminalChip.count()) {
    const currentSession = (await page.locator("#chip-label").textContent().catch(() => ""))?.trim();
    if (currentSession && currentSession !== session) {
      await terminalChip.first().click();
      await (await drawerSessionAction(page, session, machine)).click();
      return;
    }
  }

  await (await sessionAction(page, "open-session", session, machine)).press("Enter");
}

/** Add or remove a session through its real grid toggle. */
export async function toggleSessionGridFromUi(page: Page, session: string, machine?: string): Promise<void> {
  await (await sessionAction(page, "toggle-grid", session, machine)).click();
}

/** Open settings through whichever real settings control is visible. */
export async function openSettingsFromUi(page: Page): Promise<void> {
  await page.locator("#sidebar-settings-btn, #expanded-settings-btn, #gear-btn").filter({ visible: true }).first().click();
}

/** Open the new-session/project picker through a real visible UI control. */
export async function openProjectPickerFromUi(page: Page, machine?: string): Promise<void> {
  const candidates = page.locator('[data-action="new-session"]').filter({ visible: true });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const candidateMachine = await candidate.evaluate((element) => (element as HTMLElement).dataset.machine || "");
    if (machine === undefined || candidateMachine === machine) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`visible new-session control not found for machine ${JSON.stringify(machine ?? "")}`);
}

/** Read grid sessions from rendered grid-cell DOM. */
export async function gridSessionNames(page: Page): Promise<string[]> {
  return page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) =>
    cells.map((cell) => (cell as HTMLElement).dataset.session ?? ""),
  );
}

/** Read otherwise canvas-only terminal text through the sole browser test hook. */
export async function terminalTail(container: Locator, maxLines: number): Promise<string> {
  return container.evaluate((element, lines) => {
    const testWindow = window as unknown as {
      readonly __wolfpackTest: { serializeTerminalTail(container: HTMLElement, maxLines: number): string };
    };
    return testWindow.__wolfpackTest.serializeTerminalTail(element as HTMLElement, lines);
  }, maxLines);
}
