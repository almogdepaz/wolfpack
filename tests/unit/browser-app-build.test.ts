import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as appBuilder from "../../scripts/bundle-app.ts";

const output = join(import.meta.dirname, "../../public/app.bundle.js");

test("canonical app builder supplies owned browser fixtures without writing public files", async () => {
  const before = readFileSync(output, "utf8");
  const modifiedBefore = statSync(output, { bigint: true }).mtimeNs;
  const build: unknown = Reflect.get(appBuilder, "buildAppBundle");
  expect(build).toBeTypeOf("function");
  if (typeof build !== "function") throw new Error("canonical app builder is not exported");
  expect(await build()).toBe(before);
  expect(readFileSync(output, "utf8")).toBe(before);
  expect(statSync(output, { bigint: true }).mtimeNs).toBe(modifiedBefore);
}, 15000);
