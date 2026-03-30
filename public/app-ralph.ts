// ── Ralph Loop Functions ──
// Extracted from app.ts — imported back via bundler (inlined at build time)
// Uses dependency injection to avoid circular imports with app.ts

import { esc, escAttr, state, wpSettings, haptic } from "./app-state";

// ── Dependency injection ──

interface RalphDeps {
  api: (path: string, opts?: any, machineUrl?: string) => Promise<any>;
  errorMessage: (err: any) => string;
  showView: (name: string) => void;
  getMachines: () => any[];
  backToSessions: () => void;
  loadSessions: () => Promise<void>;
  renderSidebar: () => void;
  startSidebarRefresh: () => void;
  getSidebarRefreshTimer: () => any;
  setSidebarRefreshTimer: (v: any) => void;
}

let deps: RalphDeps;

export function initRalphDeps(d: RalphDeps) {
  deps = d;
}

// ── Status helpers ──

export function getRalphStatus(loop) {
  const hitLimit = !loop.active && !loop.completed && loop.finished;
  return {
    hitLimit,
    status: loop.audit ? "audit" : loop.cleanup ? "cleanup" : loop.active ? "running" : loop.completed ? "done" : hitLimit ? "limit" : "idle",
    statusLabel: loop.audit ? "AUDIT" : loop.cleanup ? "CLEANUP" : loop.active ? "RUNNING" : loop.completed ? "DONE" : hitLimit ? "STOPPED" : "IDLE",
    dotClass: loop.active ? "purple" : "gray",
    dotTitle: loop.active ? "active" : "idle",
  };
}

// ── Card rendering ──

export function renderRalphCardHtml(loop, machineUrl) {
  const { status, statusLabel, dotClass, dotTitle } = getRalphStatus(loop);
  const taskPct = loop.tasksTotal > 0 ? Math.round((loop.tasksDone / loop.tasksTotal) * 100) : 0;
  const taskLabel = loop.tasksDone + '/' + loop.tasksTotal + ' tasks';
  const iterLabel = loop.totalIterations > 0 ? loop.iteration + '/' + loop.totalIterations + ' iter' : '';
  const lastOut = loop.lastOutput ? '<div class="ralph-last-output">' + esc(loop.lastOutput) + '</div>' : '';
  const mUrl = escAttr(machineUrl || '');
  return '<div class="ralph-card ' + status + '" onclick="openRalphDetail(\'' + escAttr(loop.project) + '\', \'' + mUrl + '\')">' +
    '<div class="ralph-card-header">' +
      '<span class="ralph-card-name"><span class="dot ' + dotClass + '" title="' + dotTitle + '"></span>' + esc(loop.project) + (loop.planFile ? ' <span class="ralph-plan-suffix">— ' + esc(loop.planFile.replace(/\.md$/i, '')) + '</span>' : '') + '</span>' +
      '<span class="ralph-status ' + status + '">' + statusLabel + '</span>' +
      '<button class="kill-btn" onclick="dismissRalph(\'' + escAttr(loop.project) + '\', event, \'' + mUrl + '\')">&times;</button>' +
    '</div>' +
    '<div class="ralph-progress">' +
      '<div class="ralph-bar"><div class="ralph-bar-fill ' + status + '" style="width:' + taskPct + '%"></div></div>' +
      '<span class="ralph-iter">' + taskLabel + '</span>' +
    '</div>' +
    (iterLabel ? '<div class="ralph-iter ralph-iter-align">' + iterLabel + '</div>' : '') +
    lastOut +
  '</div>';
}

export function sidebarRalphCardHtml(loop, machineUrl) {
  const { status, statusLabel, dotClass, dotTitle } = getRalphStatus(loop);
  const mUrl = escAttr(machineUrl || '');
  return '<div class="ralph-card sidebar-ralph-card ' + status + '" onclick="openRalphDetail(\'' + escAttr(loop.project) + '\', \'' + mUrl + '\')">' +
    '<span class="dot ' + dotClass + '" title="' + dotTitle + '"></span>' +
    '<span class="sidebar-ralph-name">' + esc(loop.project) + '</span>' +
    '<span class="ralph-status ' + status + '">' + statusLabel + '</span>' +
    '<button class="kill-btn" onclick="dismissRalph(\'' + escAttr(loop.project) + '\', event, \'' + mUrl + '\')">&times;</button>' +
  '</div>';
}

// ── Detail view ──

export function openRalphDetail(project, machineUrl) {
  state.currentRalphProject = project;
  state.currentRalphMachine = machineUrl || "";
  deps.showView("ralph-detail");
}

export async function refreshRalphDetail() {
  if (!state.currentRalphProject) return;
  const header = document.getElementById("ralph-detail-header");
  const logEl = document.getElementById("ralph-log");
  const actions = document.getElementById("ralph-actions");
  try {
    const data = await deps.api("/ralph", undefined, state.currentRalphMachine);
    const loop = (data.loops || []).find(l => l.project === state.currentRalphProject);
    if (!loop) {
      header.innerHTML = '<span class="ralph-status failed">NOT FOUND</span>';
      logEl.textContent = "no ralph log for this project";
      actions.innerHTML = '';
      return;
    }
    const { status, statusLabel } = getRalphStatus(loop);
    const taskPct = loop.tasksTotal > 0 ? Math.round((loop.tasksDone / loop.tasksTotal) * 100) : 0;
    const taskLabel = loop.tasksDone + '/' + loop.tasksTotal + ' tasks';
    const iterLabel = loop.totalIterations > 0 ? loop.iteration + '/' + loop.totalIterations + ' iter' : '';
    const cleanupEnabled = loop.cleanupEnabled !== false;
    const auditFixEnabled = loop.auditFixEnabled === true;
    header.innerHTML =
      '<div class="ralph-detail-row">' +
        '<span class="ralph-status ' + status + '">' + statusLabel + '</span>' +
        '<div class="ralph-detail-stats">' +
          '<span class="ralph-iter">' + taskLabel + '</span>' +
          (iterLabel ? '<span class="ralph-iter">' + iterLabel + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="ralph-progress">' +
        '<div class="ralph-bar"><div class="ralph-bar-fill ' + status + '" style="width:' + taskPct + '%"></div></div>' +
      '</div>' +
      (loop.planFile ? '<div class="ralph-detail-meta">plan: ' + esc(loop.planFile) + '</div>' : '') +
      '<div class="ralph-detail-meta">phases: audit+fix ' + (auditFixEnabled ? "on" : "off") + ', cleanup ' + (cleanupEnabled ? "on" : "off") + '</div>' +
      (loop.started ? '<div class="ralph-detail-meta">started: ' + esc(loop.started) + '</div>' : '') +
      (loop.finished ? '<div class="ralph-detail-meta">finished: ' + esc(loop.finished) + '</div>' : '');

    // actions
    if (loop.active) {
      actions.innerHTML = '<button class="ralph-launch-btn ralph-cancel-btn" onclick="cancelRalph()">Cancel</button>';
    } else {
      const wt = escAttr(loop.worktreeMode || 'false');
      const wtBranch = escAttr(loop.worktreeBranch || '');
      actions.innerHTML =
        '<button class="ralph-launch-btn" onclick="continueRalph(\'' + escAttr(loop.planFile || '') + '\',\'' + escAttr(loop.agent || '') + '\',' + cleanupEnabled + ',' + auditFixEnabled + ',\'' + wt + '\',\'' + wtBranch + '\')">Continue</button>' +
        '<button class="ralph-launch-btn ralph-cancel-btn" onclick="discardRalph()">Discard</button>';
    }

    // stop polling if loop finished
    if (!loop.active && state.ralphLogPollTimer) {
      clearInterval(state.ralphLogPollTimer);
      state.ralphLogPollTimer = null;
    }
  } catch {
    header.innerHTML = '<span class="ralph-status failed">ERROR</span>';
  }

  // fetch log and render iteration cards
  try {
    const logData = await deps.api("/ralph/log?project=" + encodeURIComponent(state.currentRalphProject), undefined, state.currentRalphMachine);
    if (logData.log != null) {
      const container = document.getElementById("ralph-log-container");
      const wasScrolled = container.scrollTop + container.clientHeight >= container.scrollHeight - 30;
      logEl.textContent = logData.log;
      renderIterationCards(logData.log);
      if (wasScrolled) container.scrollTop = container.scrollHeight;
    }
  } catch {}
}

// ── Iteration parsing/rendering ──

export function parseIterations(log) {
  const sections = [];
  const marker = /^=== 🥋 (.+?) ===$/gm;
  let match, lastIdx = 0, lastTitle = null;
  while ((match = marker.exec(log)) !== null) {
    if (lastTitle !== null) {
      sections.push({ title: lastTitle, body: log.slice(lastIdx, match.index).trim() });
    }
    lastTitle = match[1];
    lastIdx = match.index + match[0].length;
  }
  if (lastTitle !== null) {
    sections.push({ title: lastTitle, body: log.slice(lastIdx).trim() });
  }
  return sections;
}

function renderIterationCards(log) {
  const el = document.getElementById("ralph-iterations");
  const iterations = parseIterations(log);
  if (!iterations.length) {
    el.innerHTML = '<div class="empty-state">no iterations yet</div>';
    return;
  }

  // preserve expanded state
  const expanded = new Set();
  el.querySelectorAll(".ralph-iter-card.expanded").forEach(c => expanded.add((c as HTMLElement).dataset.idx));

  el.innerHTML = iterations.map((iter, i) => {
    const isLast = i === iterations.length - 1;
    const isOpen = expanded.has(String(i)) || (isLast && !expanded.size);
    const taskLine = iter.body.match(/^task:\s*(.+)$/m);
    const task = taskLine ? taskLine[1].replace(/^#+\s*/, "").replace(/^~~|~~$/g, "").replace(/^\d+[a-z]?\.\s*/, "") : "";
    const cardClass = isLast ? "active" : "done";
    return '<div class="ralph-iter-card ' + cardClass + (isOpen ? " expanded" : "") + '" data-idx="' + i + '">' +
      '<div class="ralph-iter-header" onclick="this.parentElement.classList.toggle(\'expanded\')">' +
        '<div>' +
          '<div class="ralph-iter-title">' + esc(iter.title.replace(/ — .+$/, "")) + '</div>' +
          (task ? '<div class="ralph-iter-task">' + esc(task) + '</div>' : '') +
        '</div>' +
        '<span class="ralph-iter-chevron">&#9656;</span>' +
      '</div>' +
      '<div class="ralph-iter-body"><pre>' + esc(iter.body) + '</pre></div>' +
    '</div>';
  }).join("");
}

export function toggleRawLog() {
  const logEl = document.getElementById("ralph-log");
  const iterEl = document.getElementById("ralph-iterations");
  const toggle = document.getElementById("ralph-log-toggle");
  const showing = getComputedStyle(logEl).display !== "none";
  logEl.style.display = showing ? "none" : "block";
  logEl.classList.remove("ralph-log-hidden");
  iterEl.style.display = showing ? "" : "none";
  toggle.textContent = showing ? "view raw log" : "view iterations";
}

// ── Cancel / Dismiss ──

export async function cancelRalph() {
  if (!state.currentRalphProject) return;
  if (!confirm("cancel ralph loop for " + state.currentRalphProject + "?")) return;
  try {
    await deps.api("/ralph/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.currentRalphProject }),
    }, state.currentRalphMachine);
    refreshRalphDetail();
  } catch (e) {
    alert("failed to cancel: " + deps.errorMessage(e));
  }
}

export async function dismissRalph(project, event, machineUrl) {
  event.stopPropagation();
  if (!confirm("dismiss ralph loop for " + project + "?")) return;
  try {
    // Auto-cancel if still active
    const data = await deps.api("/ralph", undefined, machineUrl);
    const loop = (data.loops || []).find(l => l.project === project);
    if (loop && loop.active) {
      await deps.api("/ralph/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
      }, machineUrl);
      // Wait for process to die before dismissing
      await new Promise(r => setTimeout(r, 1000));
    }
    const deletePlan = confirm("also delete the plan file?");
    await deps.api("/ralph/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, deletePlan }),
    }, machineUrl);
    // Stop poll timer to prevent stale in-flight fetches from overwriting fresh data
    const timer = deps.getSidebarRefreshTimer();
    if (timer) { clearInterval(timer); deps.setSidebarRefreshTimer(null); }
    state.lastSessionsHtml = "";
    await deps.loadSessions();
    deps.renderSidebar();
    deps.startSidebarRefresh();
  } catch (e) {
    alert("failed to dismiss: " + deps.errorMessage(e));
  }
}

// ── Start form ──

function getStartMachine() {
  return state.ralphStartMachine || undefined;
}

export async function loadRalphStartForm() {
  // Show machine label if multi-machine
  const machines = deps.getMachines();
  const picker = document.getElementById("ralph-machine-picker");
  if (machines.length > 0 && state.ralphStartMachine) {
    const mName = machines.find(m => m.url === state.ralphStartMachine)?.name || "remote";
    picker.style.display = "";
    picker.innerHTML = '<span class="machine-picker-label">Machine: <strong class="machine-picker-name">' + esc(mName) + '</strong></span>';
  } else if (machines.length > 0) {
    picker.style.display = "";
    picker.innerHTML = '<span class="machine-picker-label">Machine: <strong class="machine-picker-name">' + esc(state.selfName || "this machine") + '</strong></span>';
  } else {
    picker.style.display = "none";
  }
  await loadStartFormData();
}

async function loadStartFormData() {
  const machine = getStartMachine();
  const sel = document.getElementById("ralph-project-select") as HTMLSelectElement;
  try {
    const data = await deps.api("/projects", undefined, machine);
    const projects = data.projects || [];
    sel.innerHTML = projects.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join("");
    if (state.currentRalphProject && projects.includes(state.currentRalphProject)) {
      sel.value = state.currentRalphProject;
    }
  } catch {
    sel.innerHTML = '<option value="">failed to load projects</option>';
  }
  sel.onchange = function() {
    loadPlanFiles(sel.value);
    const isoVal = ((document.querySelector('input[name="ralph-isolation"]:checked') as HTMLInputElement) || {} as any).value;
    if (isoVal === "branch") loadBranches(sel.value);
    if (isoVal === "plan" || isoVal === "task") loadWorktreeBranches(sel.value);
  };
  // Reset toggles on form load (restore from state if restarting)
  (document.getElementById("ralph-cleanup-toggle") as HTMLInputElement).checked = state.currentRalphCleanup != null ? state.currentRalphCleanup : true;
  (document.getElementById("ralph-audit-fix-toggle") as HTMLInputElement).checked = state.currentRalphAuditFix != null ? state.currentRalphAuditFix : false;
  state.currentRalphCleanup = undefined;
  state.currentRalphAuditFix = undefined;
  // enforce original worktree mode on continue
  const isoRadios = document.querySelectorAll('input[name="ralph-isolation"]') as NodeListOf<HTMLInputElement>;
  if (state.restartingRalph && state.currentRalphWorktreeMode !== "false") {
    const mode = state.currentRalphWorktreeMode;
    isoRadios.forEach(r => {
      r.checked = r.value === mode;
      r.disabled = true;
    });
    onIsolationChange();
  } else {
    (document.getElementById("ralph-iso-off") as HTMLInputElement).checked = true;
    isoRadios.forEach(r => { r.disabled = false; });
    document.getElementById("ralph-branch-fields").style.display = "none";
    document.getElementById("ralph-worktree-fields").style.display = "none";
  }
  await loadPlanFiles(sel.value);
  if (state.currentRalphPlanFile) {
    (document.getElementById("ralph-plan-select") as HTMLSelectElement).value = state.currentRalphPlanFile;
    state.currentRalphPlanFile = "";
  }
  if (state.currentRalphAgent) {
    (document.getElementById("ralph-agent-select") as HTMLSelectElement).value = state.currentRalphAgent;
    state.currentRalphAgent = "";
  }
  // Lock all fields except iterations when continuing a stopped loop
  const lockable = [sel, document.getElementById("ralph-plan-select"), document.getElementById("ralph-agent-select"),
    document.getElementById("ralph-cleanup-toggle"), document.getElementById("ralph-audit-fix-toggle"),
    document.getElementById("ralph-worktree-name"), document.getElementById("ralph-worktree-base"),
    document.getElementById("ralph-branch-name"), document.getElementById("ralph-source-branch")] as HTMLElement[];
  if (state.restartingRalph) {
    lockable.forEach(el => { if (el) (el as any).disabled = true; });
    // Show the actual worktree branch name in the disabled field
    if (state.currentRalphWorktreeBranch) {
      (document.getElementById("ralph-worktree-name") as HTMLInputElement).value = state.currentRalphWorktreeBranch;
    }
    state.currentRalphWorktreeBranch = "";
  } else {
    lockable.forEach(el => { if (el) (el as any).disabled = false; });
  }
}

async function loadPlanFiles(project) {
  const planSel = document.getElementById("ralph-plan-select") as HTMLSelectElement;
  if (!project) { planSel.innerHTML = '<option value="">select a project first</option>'; return; }
  try {
    const data = await deps.api("/ralph/plans?project=" + encodeURIComponent(project), undefined, getStartMachine());
    const plans = data.plans || [];
    if (plans.length === 0) {
      planSel.innerHTML = '<option value="">no .md files found</option>';
    } else {
      planSel.innerHTML = plans.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join("");
    }
  } catch {
    planSel.innerHTML = '<option value="">failed to load plans</option>';
  }
  planSel.onchange = () => syncIterationsFromPlan(project, planSel.value);
  syncIterationsFromPlan(project, planSel.value);
}

async function syncIterationsFromPlan(project, planFile) {
  if (!project || !planFile) return;
  try {
    const tc = await deps.api("/ralph/task-count?project=" + encodeURIComponent(project) + "&plan=" + encodeURIComponent(planFile), undefined, getStartMachine());
    if (tc.total > 0) {
      (document.getElementById("ralph-iterations-input") as HTMLInputElement).value = String(tc.total - tc.done);
    }
  } catch {}
}

export function onIsolationChange() {
  const val = ((document.querySelector('input[name="ralph-isolation"]:checked') as HTMLInputElement) || {} as any).value || "false";
  const isWorktree = val === "plan" || val === "task";
  document.getElementById("ralph-branch-fields").style.display = val === "branch" ? "flex" : "none";
  document.getElementById("ralph-worktree-fields").style.display = isWorktree ? "flex" : "none";
  const project = (document.getElementById("ralph-project-select") as HTMLSelectElement).value;
  if (val === "branch") loadBranches(project);
  if (isWorktree) {
    loadWorktreeBranches(project);
    updateWorktreePlaceholder(val);
  }
}

function updateWorktreePlaceholder(mode) {
  const input = document.getElementById("ralph-worktree-name") as HTMLInputElement;
  input.placeholder = mode === "task" ? "ralph/1-task-slug (auto per task)" : "ralph/plan-my-feature";
  if (mode === "task") { input.value = ""; input.disabled = true; }
  else { input.disabled = false; }
}

async function loadWorktreeBranches(project) {
  const sel = document.getElementById("ralph-worktree-base") as HTMLSelectElement;
  if (!project) { sel.innerHTML = '<option value="">select a project first</option>'; return; }
  try {
    const data = await deps.api("/ralph/branches?project=" + encodeURIComponent(project), undefined, getStartMachine());
    const branches = data.branches || [];
    sel.innerHTML = branches.map(b => '<option value="' + escAttr(b) + '"' + (b === "main" ? " selected" : "") + '>' + esc(b) + '</option>').join("");
  } catch {
    sel.innerHTML = '<option value="">failed to load</option>';
  }
}

async function loadBranches(project) {
  const sel = document.getElementById("ralph-source-branch") as HTMLSelectElement;
  if (!project) { sel.innerHTML = '<option value="">select a project first</option>'; return; }
  try {
    const data = await deps.api("/ralph/branches?project=" + encodeURIComponent(project), undefined, getStartMachine());
    const branches = data.branches || [];
    if (branches.length === 0) {
      sel.innerHTML = '<option value="">no branches found</option>';
    } else {
      sel.innerHTML = branches.map(b => '<option value="' + esc(b) + '"' + (b === data.current ? ' selected' : '') + '>' + esc(b) + '</option>').join("");
      // Default to main/master if available
      const defaultBranch = branches.find(b => b === "main") || branches.find(b => b === "master");
      if (defaultBranch) sel.value = defaultBranch;
    }
  } catch {
    sel.innerHTML = '<option value="">not a git repo</option>';
  }
}

export async function startRalph() {
  const machine = getStartMachine();
  const project = (document.getElementById("ralph-project-select") as HTMLSelectElement).value;
  const iterations = parseInt((document.getElementById("ralph-iterations-input") as HTMLInputElement).value) || 5;
  const planFile = (document.getElementById("ralph-plan-select") as HTMLSelectElement).value || undefined;
  const agent = (document.getElementById("ralph-agent-select") as HTMLSelectElement).value;
  const cleanup = (document.getElementById("ralph-cleanup-toggle") as HTMLInputElement).checked;
  const auditFix = (document.getElementById("ralph-audit-fix-toggle") as HTMLInputElement).checked;
  if (!project) { alert("select a project"); return; }
  if (!planFile) { alert("select a plan file"); return; }

  // Warn if plan has format issues — worker will auto-number
  let format = false;
  try {
    const tc = await deps.api("/ralph/task-count?project=" + encodeURIComponent(project) + "&plan=" + encodeURIComponent(planFile), undefined, machine);
    if (tc.issues && tc.issues.length > 0) {
      const msg = "Plan format issues in " + planFile + ":\n\n" +
        tc.issues.map(i => "• " + i).join("\n") +
        "\n\nRalph can auto-number them. Continue?";
      if (!confirm(msg)) return;
      format = true;
    } else if (tc.total === 0) {
      if (!confirm("No tasks found in " + planFile + ". Ralph will number them automatically. Continue?")) return;
      format = true;
    }
  } catch {}

  const isoVal = ((document.querySelector('input[name="ralph-isolation"]:checked') as HTMLInputElement) || {} as any).value || "false";
  const worktree = (isoVal === "plan" || isoVal === "task") ? isoVal : false;
  const body: any = { project, iterations, planFile, agent, format, cleanup, auditFix, worktree };
  if (worktree) {
    const wtName = (document.getElementById("ralph-worktree-name") as HTMLInputElement).value.trim();
    const wtBase = (document.getElementById("ralph-worktree-base") as HTMLSelectElement).value;
    if (wtName) body.worktreeBranch = wtName;
    if (wtBase) body.worktreeBase = wtBase;
  }
  if (isoVal === "branch") {
    const newBranch = (document.getElementById("ralph-branch-name") as HTMLInputElement).value.trim();
    const sourceBranch = (document.getElementById("ralph-source-branch") as HTMLSelectElement).value;
    if (!newBranch) { alert("enter a branch name"); return; }
    body.newBranch = newBranch;
    body.sourceBranch = sourceBranch;
  }

  try {
    await deps.api("/ralph/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, machine);
    state.currentRalphProject = project;
    state.restartingRalph = false;
    deps.backToSessions();
  } catch (e) {
    alert("failed to start: " + deps.errorMessage(e));
  }
}

export function continueRalph(planFile, agent, cleanup, auditFix, worktreeMode, worktreeBranch?) {
  state.currentRalphPlanFile = planFile || "";
  state.currentRalphAgent = agent || "";
  state.currentRalphCleanup = cleanup;
  state.currentRalphAuditFix = auditFix;
  state.currentRalphWorktreeMode = worktreeMode || "false";
  state.currentRalphWorktreeBranch = worktreeBranch || "";
  state.restartingRalph = true;
  state.ralphStartMachine = state.currentRalphMachine;
  deps.showView("ralph-start");
}

export async function discardRalph() {
  if (!confirm("Discard this ralph loop? This removes the log and progress files.")) return;
  try {
    await deps.api("/ralph/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.currentRalphProject }),
    }, state.currentRalphMachine);
    deps.backToSessions();
  } catch (e) {
    alert("failed to discard: " + deps.errorMessage(e));
  }
}

export function showRalphStart(machineUrl) {
  if (!wpSettings.ralphEnabled) return;
  state.ralphStartMachine = machineUrl || "";
  state.restartingRalph = false;
  deps.showView("ralph-start");
}

// ── Notification helpers ──
// Push notifications are handled server-side. Frontend only tracks state for haptic feedback.

const prevRalphStates: Record<string, string> = {};

export function getRalphNotificationStatus(loop) {
  if (loop.audit) return "running";
  if (loop.cleanup) return "running";
  if (loop.active) return "running";
  if (loop.completed) return "done";
  if (!loop.active && !loop.completed && loop.finished) return "limit";
  return "idle";
}

export function checkRalphTransitions(loops, mUrl, mName) {
  if (!loops) return;
  for (const loop of loops) {
    const key = mUrl + "|" + loop.project;
    const prev = prevRalphStates[key];
    const cur = getRalphNotificationStatus(loop);
    prevRalphStates[key] = cur;
    if ((prev === "running") && (cur === "done" || cur === "idle" || cur === "limit")) {
      haptic([200, 100, 200]);
    }
  }
}
