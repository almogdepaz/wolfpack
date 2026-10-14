import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnedBunTest, type OwnedBunTestResult } from "./run-owned-bun-test.ts";

const MARKER = ".notification-test-owner";

/** Must run before dynamic production imports in a state-mutating fixture. */
export function assertNotificationFixtureHome(): void {
  const home = process.env.WOLFPACK_NOTIFICATION_FIXTURE_HOME;
  const token = process.env.WOLFPACK_NOTIFICATION_FIXTURE_TOKEN;
  if (!home || !token || home !== process.env.HOME || home !== homedir() || process.env.WOLFPACK_TEST !== "1") {
    throw new Error("notification fixture requires an owned isolated HOME before production imports");
  }
  if (readFileSync(join(home, MARKER), "utf8") !== token) throw new Error("notification fixture HOME ownership mismatch");
}

export function prepareNotificationFixtureHome(home: string) {
  const token = randomUUID();
  writeFileSync(join(home, MARKER), token, { flag: "wx", mode: 0o600 });
  return {
    HOME: home,
    WOLFPACK_TEST: "1",
    WOLFPACK_NOTIFICATION_FIXTURE_HOME: home,
    WOLFPACK_NOTIFICATION_FIXTURE_TOKEN: token,
  };
}

export function forwardNotificationTestResult(
  result: OwnedBunTestResult,
  stdout: (text: string) => unknown = text => process.stdout.write(text),
  stderr: (text: string) => unknown = text => process.stderr.write(text),
): void {
  stdout(result.stdout);
  stderr(result.stderr);
  if (result.cleanupDiagnostics.length > 0) {
    stderr(JSON.stringify({ level: "warn", component: "notification-fixture", cleanupDiagnostics: result.cleanupDiagnostics }) + "\n");
  }
}

export async function runNotificationFixture(name: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-notification-fixture-"));
  const env = prepareNotificationFixtureHome(home);
  let completed = false;
  try {
    const result = await runOwnedBunTest(join(import.meta.dir, name), 15_000, {
      ...process.env,
      ...env,
      WOLFPACK_NOTIFICATION_TEST_OWNED_GROUP: "1",
      WOLFPACK_DEV_DIR: join(home, "Dev"),
      WOLFPACK_SETTINGS_PATH: join(home, "bridge-settings.json"),
      WOLFPACK_MACHINE_ID_PATH: join(home, "machine-id"),
      WOLFPACK_TAILSCALE_STATUS_JSON: "{}",
    }, { inheritOwnerGroup: process.env.WOLFPACK_NOTIFICATION_TEST_OWNED_GROUP === "1" });
    // Preserve complete fixture diagnostics and assertion counts in check logs.
    forwardNotificationTestResult(result);
    completed = true;
  } catch (error) {
    throw new Error(`notification fixture ${name} failed (retained HOME=${home})`, { cause: error });
  } finally {
    // Failed checks retain their owned files for diagnosis, including uncertain cleanup.
    if (completed) rmSync(home, { recursive: true, force: true });
  }
}
