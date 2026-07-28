export const SNAPSHOT_CACHE_LIMIT_PER_MACHINE = 3;

export interface SnapshotCacheEntry {
  readonly key: string;
  readonly machine: string;
  readonly lastUsedAt: number;
}

export function snapshotKeysToEvict(
  entries: readonly SnapshotCacheEntry[],
  limit = SNAPSHOT_CACHE_LIMIT_PER_MACHINE,
): readonly string[] {
  const entriesByMachine = new Map<string, SnapshotCacheEntry[]>();
  for (const entry of entries) {
    const machineEntries = entriesByMachine.get(entry.machine) ?? [];
    machineEntries.push(entry);
    entriesByMachine.set(entry.machine, machineEntries);
  }
  return [...entriesByMachine.values()].flatMap((machineEntries) =>
    [...machineEntries]
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key))
      .slice(0, Math.max(0, machineEntries.length - limit))
      .map((entry) => entry.key),
  );
}
