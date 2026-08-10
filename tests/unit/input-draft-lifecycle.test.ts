import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "../../public/app.ts"), "utf8");

describe("truthful input lifecycle", () => {
  test("propagates WebSocket backpressure rejection to draft restoration", () => {
    expect(app).toContain("send(data: string | Blob | BufferSource): boolean");
    expect(app).toContain("if (!sendBounded(copy, copy.byteLength)) return false");
    expect(app).toContain("return state.terminalController.send(bytes)");
    expect(app).toContain("input.value = saved");
  });
});
