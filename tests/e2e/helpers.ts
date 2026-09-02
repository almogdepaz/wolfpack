/**
 * Playwright e2e test helpers — server lifecycle + mock tmux.
 *
 * Spawns the real wolfpack server via `bun tests/e2e/test-server.ts` as a
 * child process with tmux stubs. Playwright drives a real browser against it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  createOwnedTestServerHome,
  removeOwnedTestServerHome,
} from "./test-server-home";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestServer {
  port: number;
  baseUrl: string;
  readonly processId: number;
  /** Stop the server subprocess after its temporary home is cleaned up. */
  close(): Promise<void>;
}

export interface TestServerOptions {
  readonly home?: string;
  readonly ignoreSigterm?: boolean;
}

// ── Server startup ───────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..", "..");
const BOOTSTRAP_OWNED_ISOLATED_HOME_ARG = "--bootstrap-owned-isolated-e2e-home";
const SHUTDOWN_GRACE_MS = 1_000;
const PROCESS_EXIT_POLL_MS = 10;

/**
 * Start the wolfpack test server as a bun subprocess on a random port.
 *
 * Resolves once `READY:<port>` is printed to stdout.
 * Call `close()` in afterAll to tear down.
 */
export function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  return new Promise<TestServer>((resolve, reject) => {
    const isolatedHome = createOwnedTestServerHome();
    const removeIsolatedHome = (): void => {
      process.off("exit", removeIsolatedHome);
      removeOwnedTestServerHome(isolatedHome);
    };
    process.on("exit", removeIsolatedHome);
    const child: ChildProcess = spawn(
      "bun",
      [
        join(ROOT, "tests", "e2e", "test-server.ts"),
        BOOTSTRAP_OWNED_ISOLATED_HOME_ARG,
        isolatedHome.path,
        isolatedHome.token,
      ],
      {
        cwd: ROOT,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: options.home ?? isolatedHome.path,
          WOLFPACK_TEST: "1",
          WOLFPACK_E2E_IGNORE_SIGTERM: options.ignoreSigterm ? "1" : undefined,
        },
      },
    );
    const killChildProcessGroup = (signal: NodeJS.Signals): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already be gone; fall back to the direct child.
        }
      }
      child.kill(signal);
    };
    const processGroupExists = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitForProcessGroupExit = async (): Promise<void> => {
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      while (processGroupExists()) {
        if (Date.now() >= deadline) {
          throw new Error(`test server process group did not exit: ${child.pid ?? "unknown"}`);
        }
        await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, PROCESS_EXIT_POLL_MS));
      }
    };
    const childExit = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.once("error", () => resolveExit());
    });
    const stopChildProcessGroup = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        killChildProcessGroup("SIGTERM");
        const exitedGracefully = await Promise.race([
          childExit.then(() => true),
          new Promise<false>((resolveGrace) => setTimeout(() => resolveGrace(false), SHUTDOWN_GRACE_MS)),
        ]);
        if (!exitedGracefully) {
          killChildProcessGroup("SIGKILL");
          const exitedAfterKill = await Promise.race([
            childExit.then(() => true),
            new Promise<false>((resolveKill) => setTimeout(() => resolveKill(false), SHUTDOWN_GRACE_MS)),
          ]);
          if (!exitedAfterKill) throw new Error(`test server did not exit after SIGKILL: ${child.pid ?? "unknown"}`);
        }
      }
      if (processGroupExists()) killChildProcessGroup("SIGKILL");
      await waitForProcessGroupExit();
    };

    const timeout = setTimeout(() => {
      void stopChildProcessGroup().finally(removeIsolatedHome);
      reject(new Error("test server did not start within 10s"));
    }, 10_000);

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        const port = Number(match[1]);
        let closePromise: Promise<void> | null = null;
        resolve({
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          processId: child.pid ?? -1,
          close() {
            if (closePromise) return closePromise;
            closePromise = stopChildProcessGroup().finally(removeIsolatedHome);
            return closePromise;
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

async function findVisibleDatasetControl(
  candidates: Locator,
  matches: (dataset: Readonly<Record<string, string | undefined>>) => boolean,
  description: string,
): Promise<Locator> {
  let match: Locator | null = null;
  await expect.poll(async () => {
    match = null;
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const dataset = await candidate.evaluate((element) => ({ ...(element as HTMLElement).dataset }));
      if (matches(dataset)) {
        match = candidate;
        return true;
      }
    }
    return false;
  }, { message: `waiting for ${description}` }).toBe(true);
  if (!match) throw new Error(`${description} disappeared after becoming visible`);
  return match;
}

function cssAttributeValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")
    .replaceAll("\f", "\\c ")}"`;
}

async function sessionAction(page: Page, action: "open-session" | "toggle-grid", session: string, machine?: string): Promise<Locator> {
  const machineSelector = machine === undefined ? "" : `[data-machine=${cssAttributeValue(machine)}]`;
  const candidate = page.locator(
    `[data-action=${cssAttributeValue(action)}][data-session=${cssAttributeValue(session)}]${machineSelector}`,
  ).filter({ visible: true }).first();
  await expect(candidate, `waiting for visible ${action} control for session ${JSON.stringify(session)}`).toBeVisible();
  return candidate;
}

async function drawerSessionAction(page: Page, session: string, machine?: string): Promise<Locator> {
  const expectedValue = machine ? `${machine}|${session}` : session;
  const candidate = page.locator(
    `#session-drawer .drawer-item[data-val=${cssAttributeValue(expectedValue)}]`,
  ).filter({ visible: true }).first();
  await expect(candidate, `waiting for visible drawer control for session ${JSON.stringify(session)}`).toBeVisible();
  return candidate;
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
  const candidate = await findVisibleDatasetControl(
    candidates,
    (dataset) => machine === undefined || dataset.machine === machine,
    `visible new-session control for machine ${JSON.stringify(machine ?? "")}`,
  );
  await candidate.click();
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
