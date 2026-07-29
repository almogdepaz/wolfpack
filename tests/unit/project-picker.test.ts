import { describe, expect, test } from "bun:test";
import { filterProjectNames, rankProjectNames } from "../../public/project-picker.ts";

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

describe("rankProjectNames", () => {
  test("promotes recent projects and bounds the visible result set", () => {
    const projects = Array.from({ length: 20 }, (_, index) => `project-${index}`);

    const ranked = rankProjectNames(projects, "", ["project-15", "project-2"], 12);

    expect(ranked).toHaveLength(12);
    expect(ranked.slice(0, 3)).toEqual(["project-15", "project-2", "project-0"]);
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  test("ranks an exact match before recent prefix matches", () => {
    expect(rankProjectNames(
      ["wolf-tools", "wolf", "wolfpack"],
      "wolf",
      ["wolfpack", "wolf-tools"],
    )).toEqual(["wolf", "wolfpack", "wolf-tools"]);
  });
});
