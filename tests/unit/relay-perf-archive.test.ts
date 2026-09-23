import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive } from "../../scripts/relay-perf/archive.ts";

const source = process.env.PI_TASKS_SOURCE;
test.skipIf(!source)("archive fixture reloads real persisted Pi entries, without manufacturing active state", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-perf-history-"));
  try {
    const empty = await createArchive(source!, join(root, "empty"), 0);
    const seeded = await createArchive(source!, join(root, "seeded"), 1_000);
    expect(empty.info.entries).toBe(1);
    expect(seeded.info.entries).toBe(1_001);
    expect(seeded.info.bytes).toBeGreaterThan(empty.info.bytes);
    expect(seeded.info.sdkSha256).toHaveLength(64);
    expect(seeded.entries()).toBe(1_001);
    expect(seeded.writes).toEqual([]);
    await expect(createArchive(source!, root, -1)).rejects.toThrow("invalid archive count");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
