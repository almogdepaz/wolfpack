import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", "test.yml"), "utf8");

test("CI provisions its required Playwright browsers before the complete integration shard", () => {
  const provision = workflow.indexOf("- name: Install critical Playwright browsers");
  const integration = workflow.indexOf("- name: Run every integration test except auth in one explicit shard");
  const auth = workflow.indexOf("- name: Run auth tests (isolated");
  expect(provision).toBeGreaterThanOrEqual(0);
  expect(integration).toBeGreaterThanOrEqual(0);
  expect(auth).toBeGreaterThan(integration);
  expect(provision).toBeLessThan(integration);
  expect((workflow.match(/bunx playwright install --with-deps chromium webkit/g) ?? []).length).toBe(1);
  expect(workflow).toContain("find tests/integration -name '*.test.ts' ! -name 'auth-middleware.test.ts'");
});
