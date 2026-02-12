# Remote Machine Ralph + Dismiss Rework

## Context

Ralph loops only work on the local machine, even though sessions already support multi-machine via Tailscale. The `api()` function accepts `machineUrl` and `/api/discover` probes peers — ralph just never uses it. Also, the dismiss button always deletes the plan file; should clean up loop artifacts and optionally delete the plan.

**Files:** `serve.ts` (dismiss endpoint), `public/index.html` (all ralph JS + start form)

---

## ~~1. Rewrite dismiss endpoint~~

**File:** `serve.ts:1046-1075`

Accept `{ project, deletePlan?: boolean }`:
- Always delete `.ralph.log` (hides card — `parseRalphLog()` returns null without it)
- Always delete progress file (name from `status.progressFile`, validate with path-traversal regex)
- Always clean up stale `.ralph.lock`
- Conditionally delete plan file when `deletePlan: true`
- Return `{ ok: true, deleted: [...], failed: [...] }`

Keep existing guards: reject if loop active (409), validate filenames.

## ~~2. Update dismiss UI + add machine param~~

**File:** `public/index.html:1479-1492`

Replace single `confirm("delete plan file?")` with two sequential confirms:
1. `confirm("dismiss ralph loop for " + project + "?")` — gates the action
2. `confirm("also delete the plan file?")` — cancel = keep plan

POST `{ project, deletePlan }` to `/api/ralph/dismiss`. Add `machineUrl` parameter to `dismissRalph()` function signature, pass to `api()` call.

## ~~3. Wire `currentRalphMachine` into all ralph functions~~

**File:** `public/index.html`

Add state var near `currentRalphProject` (~line 1018):
```javascript
let currentRalphMachine = "";
```

Update all ralph functions to carry machine context (mirrors `currentMachine` pattern for sessions):
- `openRalphDetail(project, machineUrl)` — store both
- `refreshRalphDetail()` — pass `currentRalphMachine` to `api("/ralph")` and log fetch
- `cancelRalph()` — pass `currentRalphMachine` to cancel API call
- `restartRalph(planFile)` — machine already stored from `openRalphDetail`
- Detail header: append `@ machineName` when remote

## ~~4. Fan-out `loadRalphLoops()` across all machines~~

**File:** `public/index.html:1236-1276`

Mirror `loadSessions()` fan-out pattern (lines 1567-1634):
- Build targets array: `[{url: "", name: selfName}, ...getMachines()]`
- `Promise.all` fetch `/api/ralph` from each, stamp `machineUrl` + `machineName` on each loop
- Existing sort + render, but card onclick passes `(project, machineUrl)`
- Dismiss button passes `machineUrl` too
- Machine label on cards when multi-machine: small uppercase text below progress bar
- `catch(() => [])` per machine — offline machines silently drop

## ~~5. Machine picker in ralph start form + route API calls~~

**File:** `public/index.html`

HTML: `<select id="ralph-machine-select">` before Project select, hidden when single machine.

JS:
- Populate with `getMachines()` + self, pre-select `currentRalphMachine` for restart flow
- `onchange` → reload projects/plans/branches for selected machine
- Helper `getStartMachine()` returns selected URL or undefined
- Route all start-form API calls through it:
  - `/projects`, `/ralph/plans`, `/ralph/branches`, `/ralph/task-count`, `/ralph/start`
