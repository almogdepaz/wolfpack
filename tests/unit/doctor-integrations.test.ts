import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPiTasksPackage } from "../../src/cli/doctor-integrations.ts";

const roots: string[] = [];

function agentWithPackages(packages: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-doctor-integrations-"));
  roots.push(root);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ packages }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("doctor Pi Tasks package check", () => {
  test("warns about the legacy package with the migration commands", () => {
    const [result] = checkPiTasksPackage(agentWithPackages([{ source: "npm:@sgtbeatdown/pi-tasks@0.1.17" }]));
    expect(result).toMatchObject({ group: "Integrations", status: "warn" });
    expect(result?.detail).toContain("npm:@sgtbeatdown/pi-tasks@0.1.17");
    expect(result?.fixHint).toBe("pi remove npm:@sgtbeatdown/pi-tasks && pi install npm:@sgtbeatdown/wolfpack-tasks");
    expect(result?.fix).toBeUndefined();
  });

  test("reports nothing when the legacy package is absent", () => {
    expect(checkPiTasksPackage(agentWithPackages(["npm:@sgtbeatdown/wolfpack-tasks"]))).toEqual([]);
  });
});
