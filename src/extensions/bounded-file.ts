import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** A bounded snapshot from one regular no-follow descriptor, not two pathname reads. */
export function readBoundedRegularFile(path: string, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("file limit must be a nonnegative safe integer");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) {
      throw new Error("file is not a bounded regular file");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error("file size changed while taking a bounded snapshot");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
