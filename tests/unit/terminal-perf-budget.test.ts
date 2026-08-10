import { describe, expect, test } from "bun:test";
import { perfBudgetFailures } from "../../scripts/terminal-load-perf";

function metric(p95: number | null) { return { count: p95 === null ? 0 : 1, p50: p95, p95, min: p95, max: p95 }; }
function summary(overrides: Record<string, number> = {}) {
  return {
    runs: 3,
    pageConsoleErrorsTotal: overrides.errors || 0,
    page: { cardVisibleMs: metric(overrides.cold || 100), secondPrewarmReadyMs: metric(100), longTaskCount: metric(overrides.tasks || 0), longTaskTotalMs: metric(overrides.taskMs || 0), jsHeapUsedBytes: metric(overrides.heap || 1_000), backingStorageBytes: metric(1_000) },
    single: { setupToRevealMs: metric(overrides.warm || 100), ghosttyCreationMs: metric(10), prewarmHits: { hits: 1, total: 1 } },
    grid: { setupToRevealMs: metric(100), ghosttyCreationMs: metric(10), wsServerMs: metric(10), prefillDoneToRevealMs: metric(10), prewarmHits: { hits: 1, total: 1 } },
  };
}

describe("terminal performance budgets", () => {
  test("passes bounded desktop data and reports every regression class", () => {
    expect(perfBudgetFailures(summary() as any, "desktop")).toEqual([]);
    const failures = perfBudgetFailures(summary({ cold: 4000, warm: 4000, heap: 999_000_000, tasks: 20, taskMs: 2000, errors: 1 }) as any, "desktop");
    expect(failures).toHaveLength(6);
  });
});
