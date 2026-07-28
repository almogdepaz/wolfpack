# terminal snapshot cache policy

status: complete

## goal

Remove the user-facing snapshot ttl setting and retain only the three most recently used solo-terminal snapshots per machine.

## accepted policy

- remove snapshot ttl from settings and defaults.
- cache at most three snapshots for each machine.
- preserve the existing per-snapshot size cap.
- evict least-recently-used snapshots when storing a fourth snapshot.
- do not use this cache for grid-cell persistence or restoration.

## verification

- add unit coverage for machine-scoped lru eviction.
- run relevant unit tests, typecheck, and desktop picker browser coverage.
