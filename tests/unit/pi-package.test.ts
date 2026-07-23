import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import pkg from "../../package.json";

interface PackEntry {
  readonly files?: ReadonlyArray<{ readonly path: string }>;
}

describe("Pi package manifest", () => {
  test("declares the Hunk extension without adding a runtime Pi dependency", () => {
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi).toEqual(expect.objectContaining({
      extensions: ["./extensions/hunk.ts"],
      skills: ["./skills"],
    }));
    expect(pkg.dependencies).not.toHaveProperty("@earendil-works/pi-coding-agent");
    expect(pkg).not.toHaveProperty("peerDependencies");
  });

  test("npm package dry-run includes the Hunk extension", () => {
    const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(pack.status).toBe(0);
    const [entry] = JSON.parse(pack.stdout) as PackEntry[];
    const paths = new Set(entry?.files?.map((file) => file.path) ?? []);
    expect(paths.has("extensions/hunk.ts")).toBe(true);
    expect(paths.has("docs/session-control.md")).toBe(true);
    expect(paths.has("docs/agent-skills.md")).toBe(true);
  });
});
