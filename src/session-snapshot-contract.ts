export const SESSION_SNAPSHOT_FRESHNESS = {
  FRESH: "fresh",
  CACHED: "cached",
} as const;

export type SessionSnapshotFreshness = typeof SESSION_SNAPSHOT_FRESHNESS[keyof typeof SESSION_SNAPSHOT_FRESHNESS];
