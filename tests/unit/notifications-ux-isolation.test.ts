import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnedBunTest } from "./fixtures/run-owned-bun-test.ts";
import { forwardNotificationTestResult, prepareNotificationFixtureHome } from "./fixtures/run-notification-test.ts";

function snapshot(path: string) {
  const stat = statSync(path, { bigint: true });
  return { bytes: readFileSync(path), inode: stat.ino, mtime: stat.mtimeNs };
}

test("notification suites preserve a synthetic parent HOME and parent process state", async () => {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-notifications-parent-"));
  const dir = join(home, ".wolfpack");
  mkdirSync(dir);
  const subscriptions = join(dir, "push-subscriptions.json");
  const config = join(dir, "config.json");
  // Valid sentinels expose rewrites without introducing real push recipients.
  writeFileSync(subscriptions, "[]\n");
  writeFileSync(config, JSON.stringify({ devDir: join(home, "projects"), port: 18798 }) + "\n");
  for (const path of [subscriptions, config]) utimesSync(path, 1, 1);
  const before = [snapshot(subscriptions), snapshot(config)];
  let failure: unknown;
  try {
    try {
      const result = await runOwnedBunTest(join(import.meta.dir, "fixtures", "notifications-parent-home.fixture.ts"), 30_000, {
        ...process.env, ...prepareNotificationFixtureHome(home), WOLFPACK_NOTIFICATION_TEST_OWNED_GROUP: "1",
      });
      forwardNotificationTestResult(result);
    } catch (error) { failure = error; }
    // Inspect the sentinel even when the child fails; do not hide its diagnostics.
    expect([snapshot(subscriptions), snapshot(config)], failure instanceof Error ? failure.message : undefined).toEqual(before);
    if (failure !== undefined) throw failure;
    expect(readFileSync(subscriptions, "utf8")).toBe("[]\n");
    expect(readdirSync(dir).sort()).toEqual(["config.json", "push-subscriptions.json"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 35_000);

test("unowned notification fixtures reject before accessing a synthetic HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-notifications-unowned-"));
  const dir = join(home, ".wolfpack");
  mkdirSync(dir);
  const sentinel = join(dir, "sentinel");
  writeFileSync(sentinel, "do not touch");
  const before = snapshot(sentinel);
  try {
    for (const fixture of ["push-test-route.fixture.ts", "notifications-ux-relay.fixture.ts", "peer-notification-observer.fixture.ts", "notifications-parent-home.fixture.ts"]) {
      await expect(runOwnedBunTest(join(import.meta.dir, "fixtures", fixture), 5_000, {
        ...process.env, HOME: home,
        WOLFPACK_NOTIFICATION_FIXTURE_HOME: undefined,
        WOLFPACK_NOTIFICATION_FIXTURE_TOKEN: undefined,
      })).rejects.toThrow("notification fixture requires an owned isolated HOME before production imports");
    }
    expect(snapshot(sentinel)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["sentinel"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
