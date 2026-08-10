import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "../../public/app.ts"), "utf8");

describe("dashboard refresh cancellation", () => {
  test("aborts forced superseding loads and composes peer deadlines", () => {
    expect(app).toContain('sessionRefreshAbort?.abort(new DOMException("superseded", "AbortError"))');
    expect(app).toContain("AbortSignal.any([refreshSignal, AbortSignal.timeout(timeoutMs)])");
    expect(app).toContain("state.loadSessionsEpoch += 1");
  });
});
