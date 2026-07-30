import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "..", "..", "public");
const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.json"), "utf8")) as {
  readonly icons?: readonly { readonly src?: string; readonly sizes?: string; readonly type?: string; readonly purpose?: string }[];
};

function pngDimensions(fileName: string): { width: number; height: number } {
  const bytes = readFileSync(join(publicDir, fileName));
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("PWA install icons", () => {
  test("provides raster any-purpose and maskable icons at install sizes", () => {
    expect(manifest.icons).toEqual(expect.arrayContaining([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]));
  });

  test("declared raster files have their advertised dimensions", () => {
    expect(pngDimensions("icon-192.png")).toEqual({ width: 192, height: 192 });
    expect(pngDimensions("icon-512.png")).toEqual({ width: 512, height: 512 });
    expect(pngDimensions("icon-maskable-192.png")).toEqual({ width: 192, height: 192 });
    expect(pngDimensions("icon-maskable-512.png")).toEqual({ width: 512, height: 512 });
  });
});
