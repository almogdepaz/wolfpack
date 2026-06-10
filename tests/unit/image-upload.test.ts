import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sniffImageExt,
  makeImageFilename,
  ensureImageDir,
  pruneOldImages,
  IMAGE_MIME_TO_EXT,
  IMAGE_TTL_MS,
} from "../../src/image-upload.ts";

// ─── Magic-byte sniffing ─────────────────────────────────────────────────────

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

describe("sniffImageExt", () => {
  test("detects jpeg", () => expect(sniffImageExt(JPEG)).toBe("jpg"));
  test("detects png", () => expect(sniffImageExt(PNG)).toBe("png"));
  test("detects gif", () => expect(sniffImageExt(GIF)).toBe("gif"));
  test("detects webp", () => expect(sniffImageExt(WEBP)).toBe("webp"));
  test("rejects text", () => expect(sniffImageExt(Buffer.from("#!/bin/sh\nrm -rf\n"))).toBeNull());
  test("rejects short buffers", () => expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull());
  test("rejects RIFF that is not WEBP (e.g. WAV)", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
    expect(sniffImageExt(wav)).toBeNull();
  });
});

describe("IMAGE_MIME_TO_EXT", () => {
  test("covers the four supported types", () => {
    expect(Object.keys(IMAGE_MIME_TO_EXT).sort()).toEqual([
      "image/gif", "image/jpeg", "image/png", "image/webp",
    ]);
  });
});

// ─── Filename generation ─────────────────────────────────────────────────────

describe("makeImageFilename", () => {
  test("matches the prune-safe pattern", () => {
    const name = makeImageFilename("jpg", 1718000000000);
    expect(name).toMatch(/^img-1718000000000-[a-z0-9]{4}\.jpg$/);
  });
  test("generates distinct names", () => {
    const names = new Set(Array.from({ length: 20 }, () => makeImageFilename("png")));
    expect(names.size).toBeGreaterThan(1);
  });
});

// ─── Directory + pruning ─────────────────────────────────────────────────────

describe("ensureImageDir / pruneOldImages", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wolfpack-img-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates .wolfpack/images with a gitignore", () => {
    const imgDir = ensureImageDir(dir);
    expect(imgDir).toBe(join(dir, ".wolfpack", "images"));
    expect(existsSync(imgDir)).toBe(true);
    expect(readFileSync(join(imgDir, ".gitignore"), "utf-8")).toBe("*\n");
  });

  test("is idempotent", () => {
    ensureImageDir(dir);
    expect(() => ensureImageDir(dir)).not.toThrow();
  });

  test("prunes only expired image files", () => {
    const imgDir = ensureImageDir(dir);
    const now = Date.now();
    const oldFile = join(imgDir, "img-1000-aaaa.jpg");
    const newFile = join(imgDir, "img-2000-bbbb.png");
    const unrelated = join(imgDir, "keep-me.txt");
    writeFileSync(oldFile, "x");
    writeFileSync(newFile, "x");
    writeFileSync(unrelated, "x");
    const expired = (now - IMAGE_TTL_MS - 60_000) / 1000;
    utimesSync(oldFile, expired, expired);
    utimesSync(unrelated, expired, expired);

    const removed = pruneOldImages(imgDir, IMAGE_TTL_MS, now);

    expect(removed).toEqual(["img-1000-aaaa.jpg"]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test("returns empty for missing dir", () => {
    expect(pruneOldImages(join(dir, "nope"))).toEqual([]);
  });
});
