# Kobra Kai UI — Rework Plan

> Move Kobra Kai from a separate view into the ralph-start form as a toggle.
> Remove the standalone kobra-kai-view, goal decomposition UI, and nav buttons.
> Kobra Kai = "run this plan in parallel" toggle on the existing ralph launch form.

---

## 1. Add Kobra Kai toggle to ralph-start-view

In `public/index.html`, add a toggle inside `#ralph-start-view` form (the `.ralph-start-form` div),
between the plan file selector and the launch button.

**Add this HTML** after the branch fields div (`#ralph-branch-fields`) and before the launch button:

```html
<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
  <input type="checkbox" id="ralph-kobra-toggle" onchange="toggleKobraKaiFields()" style="width:auto;accent-color:#f39c12" />
  <label for="ralph-kobra-toggle" style="margin:0;cursor:pointer;color:#f39c12">Kobra Kai (parallel)</label>
</div>
<div id="ralph-kobra-fields" style="display:none;flex-direction:column;gap:12px">
  <label for="ralph-max-concurrent">Max concurrent agents</label>
  <input id="ralph-max-concurrent" type="number" min="1" max="10" value="3" />
</div>
```

**Add JavaScript:**

`toggleKobraKaiFields()`:
- Show/hide `#ralph-kobra-fields` (same pattern as `toggleBranchFields()`)
- When kobra kai is toggled ON, hide the iterations field (not relevant for parallel) and change
  the launch button text to "Launch Kobra Kai" with orange accent
- When toggled OFF, restore iterations field and "Launch Ralph" button

**Modify `startRalph()`:**
- Check if `#ralph-kobra-toggle` is checked
- If checked: call `launchKobraKai()` instead of the normal ralph start flow
- `launchKobraKai()` should:
  1. Read selected project + plan file + max concurrent
  2. `POST /api/kobra-kai/plan { mode: "schedule", planFile, project }`
  3. On success: `POST /api/kobra-kai/launch { project, maxConcurrent }`
  4. Navigate to ralph detail or a status display

<!-- files: public/index.html -->

---

## 2. Remove standalone kobra-kai-view

Remove from `public/index.html`:

**HTML to delete:**
- The entire `<div id="kobra-kai-view" class="view">...</div>` block (lines ~2747-2787)
- The `🥋` nav button in header-right: `<button class="kobra-nav-btn" id="kobra-btn"...>`
- The `🥋` button in desktop sidebar: `<button id="sidebar-kobra-btn"...>`

**CSS to delete:**
- `.kobra-nav-btn` styles
- All `.kk-*` styles (kk-new-btn, kk-card, kk-badge, kk-wave-group, kk-task-row, kk-task-dot,
  kk-progress, kk-cancel-action, kk-field, kk-mode-tab, kk-cancel-btn, kk-launch-btn, kk-loading, etc.)

**JavaScript to delete:**
- `toggleKobraKaiView()` function
- `showKobraKaiForm()` / `hideKobraKaiForm()`
- `setKKMode()`
- `loadKobraKaiStatus()` (the standalone version)
- `startKobraKaiPolling()` / `stopKobraKaiPolling()` (the standalone version)
- `renderKobraKaiDashboard()` (the standalone version)
- `cancelKobraKai()` (the standalone version — we'll add a new one in step 4)
- `launchKobraKai()` (the standalone version — replaced by new one in step 1)
- The `"kobra-kai": 1` entry in the view index/order map
- Any `kobra-kai` references in `showView()`, back button handling, swipe logic, keyboard shortcuts

**Keep:**
- All CSS that will be reused for the inline status display (task dots, wave labels, badges).
  Extract and keep: `.kk-badge`, `.kk-task-dot`, `.kk-wave-label`, `.kk-wave-group`,
  `.kk-task-row`, `.kk-task-title`, `.kk-progress`, `.kk-progress-fill`

<!-- depends: 1 -->
<!-- files: public/index.html -->

---

## 3. Show Kobra Kai status in ralph detail view

When a kobra kai orchestration is active for a project, show its status in the existing
ralph detail view (`#ralph-detail-view`). This replaces the standalone DAG visualization.

**Modify `renderRalphDetail(loop)` or the ralph detail rendering logic:**
- After loading ralph status, also check `GET /api/kobra-kai/status?project={project}`
- If orchestration is active: render wave/task status inside `#ralph-detail-header` or
  a new `#ralph-kobra-status` div inside the detail view

**Render wave groups inline** (reuse kept CSS from step 2):
```javascript
function renderKobraKaiInline(status) {
  // Show: project, current wave / total waves, progress bar
  // For each wave: wave label + task rows with dots and badges
  // Show cancel button at bottom
}
```

**Add a `#ralph-kobra-status` div** inside `#ralph-detail-view`:
```html
<div id="ralph-kobra-status" style="display:none"></div>
```

**Polling:** when viewing a ralph detail for a project with active orchestration,
poll `GET /api/kobra-kai/status?project={project}` alongside the normal ralph log polling
(same interval, ~2-3s). Stop polling when navigating away.

<!-- depends: 2 -->
<!-- files: public/index.html -->

---

## 4. Show orchestrated projects in session list

In the sessions list (main view), if a project has an active kobra kai orchestration,
show an indicator on its card.

**Modify `loadSessions()` or wherever session cards are rendered:**
- Fetch active orchestrations: check each project for kobra-kai status
  (can be batched or cached alongside existing ralph status checks)
- If a project has an active orchestration, add a small orange badge to its card:
  ```html
  <span class="kk-badge running" style="margin-left:4px">KK w${currentWave}/${totalWaves}</span>
  ```
- Clicking the card should navigate to ralph detail view showing the kobra kai status

<!-- depends: 3 -->
<!-- files: public/index.html -->

---

## 5. Regenerate assets and deploy

- Run `bun run scripts/gen-assets.ts` to regenerate embedded assets
- Run `bun run scripts/build.ts --deploy` to build + deploy locally
- Verify:
  - Ralph start form shows kobra kai toggle
  - Toggling it shows max concurrent field, hides iterations
  - Launch works: plan gets scheduled → orchestration starts
  - Ralph detail view shows wave/task status for active orchestrations
  - Session cards show KK badge for orchestrated projects
  - No trace of the old standalone kobra-kai view
  - All existing functionality (ralph, sessions, terminal, settings) unchanged

<!-- depends: 4 -->
<!-- files: public/index.html -->
