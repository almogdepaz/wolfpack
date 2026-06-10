/**
 * Image upload helpers — magic-byte sniffing, filename generation, pruning.
 * Used by the POST /api/upload-image route to let mobile clients attach
 * photos that agents (e.g. Claude Code) can read from disk by path.
 */
import { readdirSync, statSync, unlinkSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, errMsg } from "./log.js";

const log = createLogger("image-upload");

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
export const IMAGE_DIR_NAME = join(".wolfpack", "images");

export type ImageExt = "jpg" | "png" | "webp" | "gif";

export const IMAGE_MIME_TO_EXT: Record<string, ImageExt> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Detect image type from magic bytes. Returns null for unrecognized data. */
export function sniffImageExt(buf: Buffer): ImageExt | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  return null;
}

/** Generate a collision-resistant filename like img-1718000000000-a1b2.jpg */
export function makeImageFilename(ext: ImageExt, now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `img-${now}-${rand}.${ext}`;
}

/** Resolve (and create) the image directory for a project.
 *  Drops a .gitignore inside so uploaded photos never show up in git status. */
export function ensureImageDir(projectDir: string): string {
  const dir = join(projectDir, IMAGE_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
  return dir;
}

/** Delete images older than ttlMs. Best-effort — errors are logged, not thrown. */
export function pruneOldImages(dir: string, ttlMs = IMAGE_TTL_MS, now = Date.now()): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch { /* expected: dir doesn't exist yet */
    return removed;
  }
  for (const name of entries) {
    if (!/^img-\d+-[a-z0-9]+\.(jpg|png|webp|gif)$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > ttlMs) {
        unlinkSync(path);
        removed.push(name);
      }
    } catch (e: unknown) {
      log.warn("failed to prune old image", { path, error: errMsg(e) });
    }
  }
  return removed;
}
