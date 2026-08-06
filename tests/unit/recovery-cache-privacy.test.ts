import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "../../public/app.ts"), "utf8");
const html = readFileSync(join(import.meta.dir, "../../public/index.html"), "utf8");

describe("terminal recovery privacy", () => {
  test("expires cached output and exposes opt-out and clear controls", () => {
    expect(app).toContain("Date.now() - savedAt > SNAPSHOT_TTL_MS");
    expect(app).toContain("if (!wpSettings.recoveryCache");
    expect(app).toContain("clearRecoverySnapshots()");
    expect(html).toContain('id="setting-recoveryCache"');
    expect(html).toContain('id="clear-recovery-cache-btn"');
    expect(html).toContain("Cached output may contain secrets");
  });
});
