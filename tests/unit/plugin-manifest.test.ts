import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPluginManifests, validatePluginManifest } from "../../src/plugin-manifest.ts";

function tmpRoot(name: string): string {
  const dir = join(tmpdir(), `wolfpack-plugin-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function manifest(id: string, displayName = id): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    displayName,
    capabilities: {
      commands: [{ id: "open", label: "Open", command: "shell" }],
      links: [{ id: "docs", label: "Docs", url: "https://example.com/docs" }],
    },
  }, null, 2);
}

describe("validatePluginManifest", () => {
  test("accepts a strict v1 manifest", () => {
    const result = validatePluginManifest(JSON.parse(manifest("example.tools", "Example Tools")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.capabilities.commands[0].command).toBe("shell");
    }
  });

  test("rejects unknown fields and browser script execution", () => {
    const result = validatePluginManifest({
      schemaVersion: 1,
      id: "bad.plugin",
      displayName: "Bad",
      browserScript: "alert(1)",
      capabilities: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("unknown fields: browserScript");
  });

  test("rejects invalid command characters", () => {
    const result = validatePluginManifest({
      schemaVersion: 1,
      id: "bad.command",
      displayName: "Bad",
      capabilities: { commands: [{ id: "bad", label: "Bad", command: "rm -rf /; echo pwn" }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("invalid characters");
  });
});

describe("discoverPluginManifests", () => {
  test("discovers config and project manifests with trust labels", () => {
    const root = tmpRoot("trust");
    try {
      const devDir = join(root, "dev");
      const userDir = join(root, "plugins");
      const projectDir = join(devDir, "app", ".wolfpack", "plugins");
      mkdirSync(userDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(userDir, "user.json"), manifest("user.plugin", "User Plugin"));
      writeFileSync(join(projectDir, "project.json"), manifest("project.plugin", "Project Plugin"));

      const result = discoverPluginManifests({ devDir, configPluginDirs: [userDir] });
      expect(result.plugins.map(plugin => plugin.id).sort()).toEqual(["project.plugin", "user.plugin"]);
      expect(result.plugins.find(plugin => plugin.id === "user.plugin")?.source.trust).toBe("user-installed");
      expect(result.plugins.find(plugin => plugin.id === "project.plugin")?.source.trust).toBe("project");
      expect(result.boundaries.forbidden).toContain("arbitrary browser script execution");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("project manifests take precedence over config manifests", () => {
    const root = tmpRoot("precedence");
    try {
      const devDir = join(root, "dev");
      const userDir = join(root, "plugins");
      const projectDir = join(devDir, "app", ".wolfpack", "plugins");
      mkdirSync(userDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(userDir, "user.json"), manifest("same.plugin", "User Copy"));
      writeFileSync(join(projectDir, "project.json"), manifest("same.plugin", "Project Copy"));

      const result = discoverPluginManifests({ devDir, configPluginDirs: [userDir] });
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0].displayName).toBe("Project Copy");
      expect(result.plugins[0].source.kind).toBe("project");
      expect(result.errors.some(error => error.code === "duplicate")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces invalid manifests without crashing", () => {
    const root = tmpRoot("invalid");
    try {
      const devDir = join(root, "dev");
      const userDir = join(root, "plugins");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "valid.json"), manifest("valid.plugin"));
      writeFileSync(join(userDir, "invalid.json"), "{nope");

      const result = discoverPluginManifests({ devDir, configPluginDirs: [userDir] });
      expect(result.plugins.map(plugin => plugin.id)).toEqual(["valid.plugin"]);
      expect(result.errors.some(error => error.code === "parse_error")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects manifest symlink traversal", () => {
    const root = tmpRoot("traversal");
    try {
      const devDir = join(root, "dev");
      const userDir = join(root, "plugins");
      const outside = join(root, "outside.json");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(outside, manifest("outside.plugin"));
      symlinkSync(outside, join(userDir, "outside.json"));

      const result = discoverPluginManifests({ devDir, configPluginDirs: [userDir] });
      expect(result.plugins).toHaveLength(0);
      expect(result.errors.some(error => error.code === "invalid_path")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
