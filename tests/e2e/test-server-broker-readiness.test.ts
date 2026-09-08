import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const TEST_SERVER = join(ROOT, "tests", "e2e", "test-server-broker.ts");
const CHILD_TIMEOUT_MS = 10_000;
const TAILSCALE_STATUS = JSON.stringify({
  Self: { ID: "n-broker-readiness", HostName: "broker-readiness", DNSName: "broker-readiness.example.ts.net." },
  Peer: {},
});

test("broker test server does not announce readiness when its broker is unreachable", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "wolfpack-broker-readiness-"));
  const devDir = join(sandbox, "dev");
  let child: Bun.Subprocess<"pipe", "pipe", "inherit"> | undefined;
  let exited: Promise<number> | undefined;

  try {
    mkdirSync(devDir);
    child = Bun.spawn([process.execPath, TEST_SERVER], {
      cwd: sandbox,
      env: {
        PATH: process.env.PATH ?? "",
        SHELL: process.env.SHELL ?? "/bin/sh",
        HOME: sandbox,
        TMPDIR: sandbox,
        WOLFPACK_TEST: "1",
        WOLFPACK_BROKER_SOCKET: join(sandbox, "missing.sock"),
        WOLFPACK_PORT: "0",
        WOLFPACK_DEV_DIR: devDir,
        WOLFPACK_SETTINGS_PATH: join(sandbox, "settings.json"),
        WOLFPACK_MACHINE_ID_PATH: join(sandbox, "machine-id"),
        WOLFPACK_TAILSCALE_STATUS_JSON: TAILSCALE_STATUS,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    exited = child.exited;

    const [exitCode, stdout] = await Promise.all([exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(1);
    expect(child.signalCode).toBeNull();
    expect(stdout).not.toContain("READY:");
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (exited) await exited;
    rmSync(sandbox, { recursive: true, force: true });
  }
}, { timeout: 12_000 });
