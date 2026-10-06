import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { ExtensionPackageError, extractVerifiedNpmTarball, inspectNpmTarball, parseExactNpmSpecifier, verifyNpmIntegrity } from "../../src/extensions/package-security.ts";

function fixture(): string { return mkdtempSync(join(tmpdir(), "wolfpack-extension-archive-")); }

describe("extension package security gate", () => {
  test("requires an exact npm source and verifies SRI bytes", () => {
    expect(parseExactNpmSpecifier("npm:@wolfpack/context@0.1.0")).toEqual({ name: "@wolfpack/context", version: "0.1.0" });
    expect(() => parseExactNpmSpecifier("npm:context@latest")).toThrow(ExtensionPackageError);
    const directory = fixture();
    try {
      const path = join(directory, "package.tgz"); writeFileSync(path, "bytes");
      const integrity = `sha512-${createHash("sha512").update("bytes").digest("base64")}`;
      expect(() => verifyNpmIntegrity(path, integrity)).not.toThrow();
      expect(() => verifyNpmIntegrity(path, `sha512-${createHash("sha512").update("other").digest("base64")}`)).toThrow(ExtensionPackageError);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("accepts regular package entries and rejects traversal before extraction", async () => {
    const directory = fixture();
    try {
      const source = join(directory, "source"); const packageDir = join(source, "package");
      const { mkdirSync } = await import("node:fs"); mkdirSync(packageDir, { recursive: true }); writeFileSync(join(packageDir, "package.json"), "{}");
      const archive = join(directory, "safe.tgz"); await tar.c({ gzip: true, cwd: source, file: archive }, ["package"]);
      expect(await inspectNpmTarball(archive)).toMatchObject({ files: 1 });
      const extracted = await extractVerifiedNpmTarball(archive, join(directory, "out"));
      expect(extracted).toEndWith("package");
      const hostile = join(directory, "hostile.tar"); await tar.c({ cwd: directory, file: hostile }, ["safe.tgz"]);
      await expect(inspectNpmTarball(hostile)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
