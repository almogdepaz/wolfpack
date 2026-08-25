import { describe, expect, test } from "bun:test";
import {
  isFreshSnapshotTimestamp,
  snapshotKeysToEvict,
} from "../../src/snapshot-cache.ts";

describe("snapshot cache timestamps", () => {
  test("accepts fresh and exact-boundary timestamps", () => {
    expect(isFreshSnapshotTimestamp(900, 1_000, 100)).toBe(true);
    expect(isFreshSnapshotTimestamp(1_000, 1_000, 100)).toBe(true);
  });

  test("rejects expired and invalid timestamps", () => {
    expect(isFreshSnapshotTimestamp(899, 1_000, 100)).toBe(false);
    expect(isFreshSnapshotTimestamp("900", 1_000, 100)).toBe(false);
    expect(isFreshSnapshotTimestamp(undefined, 1_000, 100)).toBe(false);
  });
});

describe("snapshot cache eviction", () => {
  test("keeps the three most recently used snapshots for a machine", () => {
    expect(snapshotKeysToEvict([
      { key: "local|one", machine: "local", lastUsedAt: 1 },
      { key: "local|two", machine: "local", lastUsedAt: 2 },
      { key: "local|three", machine: "local", lastUsedAt: 3 },
      { key: "local|four", machine: "local", lastUsedAt: 4 },
    ])).toEqual(["local|one"]);
  });

  test("does not evict when a machine has three or fewer snapshots", () => {
    expect(snapshotKeysToEvict([
      { key: "remote|one", machine: "remote", lastUsedAt: 1 },
      { key: "remote|two", machine: "remote", lastUsedAt: 2 },
      { key: "remote|three", machine: "remote", lastUsedAt: 3 },
    ])).toEqual([]);
  });

  test("evicts independently for each machine", () => {
    expect(snapshotKeysToEvict([
      { key: "local|one", machine: "local", lastUsedAt: 1 },
      { key: "local|two", machine: "local", lastUsedAt: 2 },
      { key: "local|three", machine: "local", lastUsedAt: 3 },
      { key: "local|four", machine: "local", lastUsedAt: 4 },
      { key: "remote|one", machine: "remote", lastUsedAt: 1 },
      { key: "remote|two", machine: "remote", lastUsedAt: 2 },
      { key: "remote|three", machine: "remote", lastUsedAt: 3 },
    ])).toEqual(["local|one"]);
  });

  test("uses the key as a stable tiebreaker", () => {
    expect(snapshotKeysToEvict([
      { key: "machine|z", machine: "machine", lastUsedAt: 1 },
      { key: "machine|a", machine: "machine", lastUsedAt: 1 },
      { key: "machine|b", machine: "machine", lastUsedAt: 2 },
      { key: "machine|c", machine: "machine", lastUsedAt: 3 },
    ])).toEqual(["machine|a"]);
  });
});
