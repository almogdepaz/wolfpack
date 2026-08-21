import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface GhosttyLock {
  readonly revision: string;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly buildInputs: {
    readonly simd: boolean;
  };
}

const ROOT = process.cwd();
const NOTICE_PATH = join(ROOT, "THIRD_PARTY_NOTICES");
const BUILD_SCRIPT = readFileSync(join(ROOT, "scripts", "build.ts"), "utf-8");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  readonly files: readonly string[];
};
const LOCK = JSON.parse(readFileSync(join(ROOT, "ghostty-vt.lock.json"), "utf-8")) as GhosttyLock;
const UUCODE_SOURCE_URL = "https://deps.files.ghostty.org/uucode-2826a37a4562284fdacd8fa029d49509cc9bffcd.tar.gz";
const UUCODE_ZIG_PACKAGE_HASH = "sha256-R5RXW5tWIaDq5JOF2+oWd5YOYOyns6WH7f687WE+b20=";

const EXPECTED_LICENSE_HASHES: Record<string, string> = {
  "BEGIN GHOSTTY MIT LICENSE": "386211873e5b7a02f663ae4d7adf96285999f91608f8f9f31fecfd0f4095e6f1",
  "BEGIN UUCODE MIT LICENSE": "312e901e142be2477b4ca859e9311f9e3f80d33372991759b7921c1893605f33",
  "BEGIN BJOERN HOEHRMANN UTF-8 DFA LICENSE": "de219cece932aad5a817bf763393d8d149d378a15d2ad5320e3331eac07626dd",
  "BEGIN UNICODE LICENSE V3": "1eda5a3b026870c737b22e8bcd4954338612c790db688242e003f41a4fa95175",
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function noticeText(): string {
  expect(existsSync(NOTICE_PATH)).toBe(true);
  return readFileSync(NOTICE_PATH, "utf-8");
}

function noticeSection(text: string, marker: string): string {
  const startMarker = `----- ${marker} -----\n`;
  const endMarker = `----- ${marker.replace("BEGIN", "END")} -----`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + startMarker.length, end);
}

describe("third-party notice policy", () => {
  test("notice identities match the pinned Ghostty lib-vt lock and uucode dependency", () => {
    const text = noticeText();

    expect(text).toContain(`Ghostty revision: ${LOCK.revision}`);
    expect(text).toContain(`Ghostty source URL: ${LOCK.sourceUrl}`);
    expect(text).toContain(`Ghostty source SHA-256: ${LOCK.sourceSha256}`);
    expect(text).toContain(`Ghostty build input simd: ${String(LOCK.buildInputs.simd)}`);
    expect(LOCK.buildInputs.simd).toBe(false);
    expect(text).toContain(`uucode source URL: ${UUCODE_SOURCE_URL}`);
    expect(text).toContain(`uucode Zig package hash: ${UUCODE_ZIG_PACKAGE_HASH}`);
  });

  test("notice contains exact upstream license texts by checked hash", () => {
    const text = noticeText();
    for (const [marker, expectedHash] of Object.entries(EXPECTED_LICENSE_HASHES)) {
      expect(sha256(noticeSection(text, marker))).toBe(expectedHash);
    }
  });

  test("npm root and platform packages include the notice next to every broker", () => {
    expect(PACKAGE_JSON.files).toContain("THIRD_PARTY_NOTICES");
    expect(BUILD_SCRIPT).toContain("const THIRD_PARTY_NOTICES");
    expect(BUILD_SCRIPT).toContain("copyFileSync(THIRD_PARTY_NOTICES, join(targetDir, \"THIRD_PARTY_NOTICES\"));");
    expect(BUILD_SCRIPT).toContain("copyFileSync(THIRD_PARTY_NOTICES, join(packageDir, \"THIRD_PARTY_NOTICES\"));");
    expect(BUILD_SCRIPT).toContain('files: ["wolfpack", "wolfpack-broker", "broker-artifact.json", "THIRD_PARTY_NOTICES"]');
  });
});
