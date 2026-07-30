# tagged ghostty build release recovery

## goal

ship v1.6.10 from main, including pr #246, without mutating the failed v1.6.9 tag. prevent extracted ghostty source builds from observing wolfpack's enclosing git tag.

## constraints

- preserve the existing remote v1.6.9 tag and failed workflow history.
- fix the source-build boundary instead of hardcoding a ghostty release version.
- merge the regression fix to main before creating the v1.6.10 release commit and tag.
- do not publish until focused, full, and main-ci verification pass.

## non-goals

- changing the pinned ghostty revision, patches, zig version, or broker behavior.
- changing release assets or npm package layout.

## 1. reproduce tagged-build metadata leakage

add a deterministic regression test using a real temporary git repository and exact tag. prove the current build environment exposes the enclosing wolfpack repository to extracted ghostty source.

## 2. isolate the ghostty source build

set the git discovery ceiling for the zig source-build subprocess so the authenticated extracted source cannot discover enclosing wolfpack repository metadata.

## 3. verify and merge the fix

run focused tests, the full bun suite, typecheck, and relevant build reproduction. push a fix pr, pass ci, and merge it to main.

## 4. release v1.6.10

create a clean release branch from updated main, bump all package versions to 1.6.10, verify, commit, tag, and monitor github/npm publication.
