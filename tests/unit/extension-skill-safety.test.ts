import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as deployment from "../../src/extensions/pi-skill-deployment.ts";
import { writePrivateJsonFile } from "../../src/server/persistence.ts";
import { canonicalJson } from "../../src/canonical-json.ts";

const name = "wolfpack-agent-context";
const extensionId = "agent-context";
const registryFile = ".wolfpack-extension-skill-ownership.json";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "wolfpack-skill-safety-")); roots.push(base);
  const skillsRoot = join(base, "skills"); mkdirSync(skillsRoot, { mode: 0o700 });
  return { base, skillsRoot, destination: join(skillsRoot, name), registry: join(skillsRoot, registryFile) };
}
function skill(body = "v1", header = `name: ${name}\ndescription: publish context`) {
  return { name, files: [{ path: "SKILL.md", content: `---\n${header}\n---\n${body}\n` }] };
}
interface Operations {
  rename?: (from: string, to: string) => void;
  writeRegistry?: (file: string, value: unknown) => void;
  writeFile?: (file: string, content: string) => void;
  removeTree?: (path: string) => void;
}
function deploy(skillsRoot: string, value = skill(), operations?: Operations) {
  const options = { skillsRoot, extensionId, skills: [value], operations };
  return deployment.deployBundledPiSkills(options);
}
function remove(skillsRoot: string, operations?: Operations) {
  const fn = (deployment as unknown as {
    removeBundledPiSkills?: (options: { skillsRoot: string; extensionId: string; names: string[]; operations?: Operations }) => readonly { status: string; name: string; cleanupDirectory?: string }[];
  }).removeBundledPiSkills;
  expect(typeof fn).toBe("function");
  return fn!({ skillsRoot, extensionId, names: [name], operations });
}
function installed() {
  const result = fixture();
  expect(deploy(result.skillsRoot)[0]?.status).toBe("installed");
  return { ...result, before: readFileSync(result.registry, "utf8"), content: readFileSync(join(result.destination, "SKILL.md"), "utf8") };
}

describe("static skill inventory and standard frontmatter", () => {
  test.each([
    `description: 'publish: structured context'\nname: ${name}`,
    `name: ${name}\ndescription: >-\n  Publish context with a\n  standard folded YAML value.`,
    `name: ${name}\ndescription: |\n  Publish context.\n  Use when requested.\nmetadata:\n  author: example`,
  ])("accepts standard YAML frontmatter independent of key order", (header) => {
    expect(deploy(fixture().skillsRoot, skill("body", header))[0]?.status).toBe("installed");
  });
  test("accepts CRLF frontmatter without changing package bytes", () => {
    const f = fixture(); const value = skill(); value.files[0]!.content = value.files[0]!.content.replaceAll("\n", "\r\n");
    expect(deploy(f.skillsRoot, value)[0]?.status).toBe("installed");
    expect(readFileSync(join(f.destination, "SKILL.md"), "utf8")).toBe(value.files[0]!.content);
  });
  test.each([
    `name: another-name\ndescription: publish`,
    `name: ${name}\ndescription: 42`,
    `name: ${name}\ndescription: []`,
    `name: ${name}\ndescription: '   '`,
    `name: ${name}\ndescription: ${"x".repeat(1025)}`,
    `name: ${name}\ndescription: publish\nname: different`,
    `name: ${name}\ndescription: [unterminated`,
    `name: ${name}\ndescription: &text publish\nmetadata:\n  value: *text`,
  ])("refuses invalid, ambiguous or aliased frontmatter without activation", (header) => {
    const f = fixture();
    expect(deploy(f.skillsRoot, skill("body", header))[0]?.status).toBe("write_failed");
    expect(existsSync(f.destination)).toBe(false);
  });
  test.each(["references//x", "references/./x", "references/../x", "references/x.", "references/CON.txt", "/absolute", "a\\b", "a/".repeat(9) + "file"])("rejects nonportable/aliased path %s", (path) => {
    const f = fixture(); const value = skill(); value.files.push({ path, content: "reference" });
    expect(deploy(f.skillsRoot, value)[0]?.status).toBe("write_failed");
    expect(existsSync(f.destination)).toBe(false);
  });
  test.each([
    ["references/a", "references/A"], ["References/a", "references/b"],
    ["references", "references/a"], ["references/a", "references"],
  ])("rejects case and file/directory collisions: %s vs %s", (first, second) => {
    const f = fixture(); const value = skill();
    value.files.push({ path: first, content: "a" }, { path: second, content: "b" });
    expect(deploy(f.skillsRoot, value)[0]?.status).toBe("write_failed");
    expect(existsSync(f.destination)).toBe(false);
  });
  test("bounds inventory bytes before writing any staged file", () => {
    const f = fixture(); const value = skill(); value.files.push({ path: "large.txt", content: "x".repeat(2 * 1024 * 1024) });
    expect(deploy(f.skillsRoot, value)[0]?.status).toBe("write_failed");
    expect(existsSync(f.destination)).toBe(false);
  });
  test("rejects duplicate skill names in a batch before activation", () => {
    const f = fixture();
    expect(() => deployment.deployBundledPiSkills({ skillsRoot: f.skillsRoot, extensionId, skills: [skill(), skill("different")] })).toThrow();
    expect(existsSync(f.destination)).toBe(false);
  });
});

describe("complete ownership checks and removal", () => {
  test("clean update and removal commit matching registry state", () => {
    const f = installed();
    expect(deploy(f.skillsRoot, skill("v2"))[0]?.status).toBe("installed");
    expect(readFileSync(join(f.destination, "SKILL.md"), "utf8")).toContain("v2");
    expect(remove(f.skillsRoot)[0]?.status).toBe("removed");
    expect(existsSync(f.destination)).toBe(false);
    expect(JSON.parse(readFileSync(f.registry, "utf8")).skills[name]).toBeUndefined();
    expect(remove(f.skillsRoot)[0]?.status).toBe("not_installed");
    expect(readdirSync(f.base)).toEqual(["skills"]);
  });
  test.each(["file", "empty-directory", "modified-file", "missing-file", "symlink"])("preserves %s during both update and removal", (change) => {
    const f = installed();
    if (change === "file") writeFileSync(join(f.destination, "notes.txt"), "user-owned");
    if (change === "empty-directory") mkdirSync(join(f.destination, "my-notes"));
    if (change === "modified-file") writeFileSync(join(f.destination, "SKILL.md"), "user-owned");
    if (change === "missing-file") rmSync(join(f.destination, "SKILL.md"));
    if (change === "symlink") {
      const target = join(f.base, "user-owned.txt"); writeFileSync(target, f.content);
      rmSync(join(f.destination, "SKILL.md")); symlinkSync(target, join(f.destination, "SKILL.md"));
    }
    expect(deploy(f.skillsRoot, skill("v2"))[0]?.status).toBe("modified");
    expect(remove(f.skillsRoot)[0]?.status).toBe("modified");
    expect(readFileSync(f.registry, "utf8")).toBe(f.before);
    if (change === "file") expect(readFileSync(join(f.destination, "notes.txt"), "utf8")).toBe("user-owned");
    if (change === "empty-directory") expect(lstatSync(join(f.destination, "my-notes")).isDirectory()).toBe(true);
    if (change === "symlink") expect(lstatSync(join(f.destination, "SKILL.md")).isSymbolicLink()).toBe(true);
  });
  test.each(["root-markdown", "grouped-skill"])("refuses Pi discovery name collision in %s", (kind) => {
    const f = fixture();
    const file = kind === "root-markdown" ? join(f.skillsRoot, "manual.md") : join(f.skillsRoot, "group", "SKILL.md");
    if (kind === "grouped-skill") mkdirSync(join(f.skillsRoot, "group"));
    writeFileSync(file, skill().files[0]!.content);
    expect(deploy(f.skillsRoot)[0]?.status).toBe("collision");
    expect(existsSync(f.destination)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(skill().files[0]!.content);
  });
  test("refuses another extension's removal request", () => {
    const f = installed();
    const fn = (deployment as unknown as { removeBundledPiSkills?: (options: unknown) => readonly { status: string }[] }).removeBundledPiSkills;
    expect(typeof fn).toBe("function");
    expect(fn!({ skillsRoot: f.skillsRoot, extensionId: "another-extension", names: [name] })[0]?.status).toBe("collision");
    expect(readFileSync(f.registry, "utf8")).toBe(f.before);
    expect(existsSync(f.destination)).toBe(true);
  });
  test.each(["files-null", "forged-digest", "path-alias", "invalid-owner", "array-registry", "too-large"])("rejects corrupt registry %s without filesystem changes", (change) => {
    const f = installed(); const registry = JSON.parse(f.before);
    if (change === "files-null") registry.skills[name].files = null;
    if (change === "forged-digest") registry.skills[name].sourceDigest = "0".repeat(64);
    if (change === "path-alias") {
      registry.skills[name].files["references//x"] = "0".repeat(64);
      registry.skills[name].sourceDigest = createHash("sha256").update(canonicalJson(registry.skills[name].files)).digest("hex");
    }
    if (change === "invalid-owner") registry.skills[name].extensionId = "../escape";
    if (change === "array-registry") registry.skills = [];
    const text = JSON.stringify(registry) + (change === "too-large" ? " ".repeat(9 * 1024 * 1024) : "");
    writeFileSync(f.registry, text);
    expect(() => deploy(f.skillsRoot, skill("v2"))).toThrow();
    expect(readFileSync(join(f.destination, "SKILL.md"), "utf8")).toBe(f.content);
    expect(readFileSync(f.registry, "utf8")).toBe(text);
  });
  test("refuses a root directory symlink instead of mutating its target", () => {
    const f = fixture(); const target = join(f.base, "real-skills"); renameSync(f.skillsRoot, target); symlinkSync(target, f.skillsRoot);
    expect(() => deploy(f.skillsRoot)).toThrow();
    expect(readdirSync(target)).toEqual([]);
  });
  test("registry is owner-private and payload digests are computed internally", () => {
    const f = installed();
    const registry = JSON.parse(f.before);
    expect(lstatSync(f.registry).mode & 0o777).toBe(0o600);
    expect(registry.skills[name].files["SKILL.md"]).toBe(createHash("sha256").update(f.content).digest("hex"));
    expect(registry.skills[name].sourceDigest).toBe(createHash("sha256").update(canonicalJson(registry.skills[name].files)).digest("hex"));
  });
});

describe("failure-atomic per-skill transactions", () => {
  test.each(["stage-write", "park-old", "activate-new", "registry"])("failed update at %s restores old tree and ownership", (point) => {
    const f = installed(); let fired = false;
    const operations: Operations = {
      writeFile(file, content) {
        if (point === "stage-write" && !fired) { fired = true; throw new Error("injected write failure"); }
        writeFileSync(file, content, { mode: 0o600, flag: "wx" });
      },
      rename(from, to) {
        if (!fired && ((point === "park-old" && from === f.destination) || (point === "activate-new" && to === f.destination))) {
          fired = true; throw new Error("injected rename failure");
        }
        renameSync(from, to);
      },
      writeRegistry(file, value) {
        if (point === "registry" && !fired) { fired = true; throw new Error("injected registry failure"); }
        writePrivateJsonFile(file, value);
      },
    };
    expect(deploy(f.skillsRoot, skill("v2"), operations)[0]?.status).toBe("write_failed");
    expect(fired).toBe(true);
    expect(readFileSync(join(f.destination, "SKILL.md"), "utf8")).toBe(f.content);
    expect(readFileSync(f.registry, "utf8")).toBe(f.before);
    expect(readdirSync(f.base)).toEqual(["skills"]);
    expect(deploy(f.skillsRoot, skill("v2"))[0]?.status).toBe("installed");
  });
  test("failed first-install registry write leaves no activated directory", () => {
    const f = fixture();
    expect(deploy(f.skillsRoot, skill(), { writeRegistry() { throw new Error("injected registry failure"); } })[0]?.status).toBe("write_failed");
    expect(existsSync(f.destination)).toBe(false);
    expect(existsSync(f.registry)).toBe(false);
    expect(readdirSync(f.base)).toEqual(["skills"]);
  });
  test("failed removal registry write restores the old directory", () => {
    const f = installed();
    expect(remove(f.skillsRoot, { writeRegistry() { throw new Error("injected registry failure"); } })[0]?.status).toBe("write_failed");
    expect(readFileSync(join(f.destination, "SKILL.md"), "utf8")).toBe(f.content);
    expect(readFileSync(f.registry, "utf8")).toBe(f.before);
    expect(readdirSync(f.base)).toEqual(["skills"]);
  });
  test("recognizes registry commit even if a writer reports a post-commit error", () => {
    const f = installed();
    let fired = false;
    expect(deploy(f.skillsRoot, skill("v2"), { writeRegistry(file, value) { fired = true; writePrivateJsonFile(file, value); throw new Error("post-commit cleanup failed"); } })[0]?.status).toBe("installed");
    expect(fired).toBe(true);
    expect(deploy(f.skillsRoot, skill("v2"))[0]?.status).toBe("unchanged");
  });
  test("preserves backup and reports cleanup location if post-commit cleanup fails", () => {
    const f = installed();
    const result = deploy(f.skillsRoot, skill("v2"), { removeTree() { throw new Error("cleanup failed"); } })[0] as unknown as { status: string; cleanupDirectory?: string };
    expect(result.status).toBe("installed");
    expect(typeof result.cleanupDirectory).toBe("string");
    expect(result.cleanupDirectory!.startsWith(f.skillsRoot + "/")).toBe(false);
    expect(readFileSync(join(result.cleanupDirectory!, "old", "SKILL.md"), "utf8")).toBe(f.content);
    expect(deploy(f.skillsRoot, skill("v2"))[0]?.status).toBe("unchanged");
  });
  test("serializes writers with a root lock rather than racing registry snapshots", () => {
    const f = fixture(); let checked = false;
    expect(deploy(f.skillsRoot, skill(), { writeFile(file, content) {
      expect(() => deploy(f.skillsRoot, skill("other"))).toThrow();
      checked = true; writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    } })[0]?.status).toBe("installed");
    expect(checked).toBe(true);
  });
  test("retains recoverable old bytes and locks out writes if rollback itself fails", () => {
    const f = installed(); let caught: unknown;
    try { deploy(f.skillsRoot, skill("v2"), {
      writeRegistry() { throw new Error("registry failed"); },
      rename(from, to) { if (from.endsWith("/old")) throw new Error("restore failed"); renameSync(from, to); },
    }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "RECOVERY_REQUIRED" });
    const recovery = (caught as { recoveryDirectory: string }).recoveryDirectory;
    expect(readFileSync(join(recovery, "old", "SKILL.md"), "utf8")).toBe(f.content);
    expect(readFileSync(f.registry, "utf8")).toBe(f.before);
    expect(() => deploy(f.skillsRoot, skill("v3"))).toThrow();
  });
});
