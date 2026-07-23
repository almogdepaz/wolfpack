import { describe, expect, test } from "bun:test";
import { filterProjectNames } from "../../public/project-picker.ts";

describe("filterProjectNames", () => {
  const projects = ["loom", "LoopTools", "catalog", "LOOKOUT"];

  test("matches project-name prefixes case-insensitively", () => {
    expect(filterProjectNames(projects, "loo")).toEqual(["loom", "LoopTools", "LOOKOUT"]);
  });

  test("does not match substrings after the start of the project name", () => {
    expect(filterProjectNames(projects, "log")).toEqual([]);
  });

  test("restores all projects for empty or whitespace-only input", () => {
    expect(filterProjectNames(projects, "")).toEqual(projects);
    expect(filterProjectNames(projects, "   ")).toEqual(projects);
  });
});
