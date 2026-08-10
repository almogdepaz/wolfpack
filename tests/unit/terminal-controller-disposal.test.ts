import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "../../public/app.ts"), "utf8");
const grid = readFileSync(join(import.meta.dir, "../../public/app-grid.ts"), "utf8");

describe("terminal controller disposal contract", () => {
  test("single-terminal teardown disposes before clearing its reference", () => {
    expect(app).toMatch(/terminalController\.dispose\(\); state\.terminalController = null/);
  });

  test("grid removal, suspension and exit dispose controllers", () => {
    expect(grid).toContain("removed.controller?.dispose()");
    expect(grid).toMatch(/export function suspendGridMode\(\)[\s\S]*?gs\.controller\) gs\.controller\.dispose\(\)/);
    expect(grid).toMatch(/export function exitGridMode\(skipRestore\?\)[\s\S]*?gs\.controller\) gs\.controller\.dispose\(\)/);
    expect(grid).toMatch(/suspendDelegationGridTerminals[\s\S]*?session\.controller\?\.dispose\(\)/);
  });
});
