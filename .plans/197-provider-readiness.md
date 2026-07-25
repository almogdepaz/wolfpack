# issue 197 — provider setup and readiness

status: complete
branch: 197-wizard
base: main @ 4dbe7fc

## goal

a fresh user can open browser settings, see whether each supported coding-agent executable is available, inspect its path/version, get install/login guidance, and add a detected provider through the existing validated settings path.

## assumptions

- browser settings is the delivery surface; no separate cli wizard
- providers are claude, codex, gemini, cursor, and pi
- auth status stays `unknown` unless a stable structured probe exists
- provider checks never auto-install software or evaluate user-controlled shell text

## success criteria

- [x] fixed allowlisted providers expose installed/missing status
- [x] installed providers expose executable path and bounded version text when available
- [x] missing providers expose concise install guidance
- [x] installed providers expose concise login guidance with auth status `unknown`
- [x] settings ui can add a detected provider through `POST /api/settings`
- [x] command validation remains centralized in the existing settings route
- [x] generated control schema and browser assets are updated
- [x] unit, integration, ui, typecheck, and full `bun test` verification are green

## execution

1. [complete] add failing provider-readiness unit tests
2. [complete] implement typed provider definitions and safe executable/version probes
3. [complete] add failing authenticated api/schema tests
4. [complete] expose `GET /api/providers`
5. [complete] add failing browser ui test
6. [complete] render readiness and add actions in settings
7. [complete] regenerate schema/assets and run verification

## verification

red evidence:

- provider unit test failed because `src/provider-readiness.ts` did not exist
- api test returned 404 and schema test reported missing `listProviderReadiness`
- browser test could not find provider readiness rows

final green evidence:

- `bun run typecheck` — pass
- `bun test` — 1837 pass, 0 fail across 122 files
- provider browser test — 1 pass on desktop
- full desktop ux navigation file — 9 pass
- api integration file — 120 pass
- auth/schema integration set — 31 pass

full all-project e2e was also attempted twice: 109 passed, 126 skipped, and two unrelated iphone-se broker tests failed under suite load. both exact failures passed when rerun independently; the same scenarios passed in the iphone-14 and desktop portions of each full run.

local deployment:

- `scripts/deploy-local.sh --broker=no` — pass
- server restarted from pid 98163 to 64605
- broker preserved at pid 36530 with 7 sessions preserved
- deployed version 1.6.7; served bundle hash verified
- live `/api/providers` smoke check — pass

## first-run readiness follow-up

- [x] seed first-run setup with `shell` plus installed providers
- [x] persist the initial seed so later PATH changes do not mutate settings
- [x] preserve existing, legacy, and missing-file Ralph authorization behavior
- [x] cover missing, installed, and existing-settings cases test-first
- [x] redeploy server-only after full verification

follow-up verification:

- red: `Cannot find module '../../src/initial-provider-settings.ts'`
- focused provider/settings tests — 29 pass, 0 fail
- api integration, including missing-file Ralph authorization — 120 pass, 0 fail
- taxonomy ownership — 4 pass, 0 fail
- `bun run typecheck` — pass
- `bun test` — 1841 pass, 0 fail across 123 files
- `scripts/deploy-local.sh --broker=no` — pass; server pid 90192, broker pid 36530, 8 sessions preserved
- live readiness/settings smoke — pass

shell discoverability follow-up:

- shell remains removable and toggleable like other configured commands
- provider readiness always shows shell as a built-in command and can re-add it through `POST /api/settings`
- the existing shell fallback remains when no command is enabled
- red: 4 focused settings/API failures reproduced the over-constrained shell behavior
- focused settings/API tests — 143 pass, 0 fail
- taxonomy ownership — 4 pass, 0 fail
- desktop settings e2e — 1 pass
- `bun run typecheck` — pass
- `bun test` — 1843 pass, 0 fail across 123 files

## constraints

- no provider-auth prose scraping
- no curl-pipe-shell install action
- no changes to existing custom command behavior
- preserve unrelated dirty working-tree files
