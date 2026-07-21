import {
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_STATE,
  agentStatusLabel,
  isAgentStatusState,
} from "./agent-status-contract.js";
import type { AgentStatusState } from "./agent-status-contract.js";

const RALPH_CARD_LIMIT_STATUS = "limit";

export interface RalphLoop {
  readonly project: string;
  readonly active: boolean;
  readonly completed: boolean;
  readonly finished?: string;
  readonly started?: string;
  readonly audit?: boolean;
  readonly cleanup?: boolean;
  readonly cleanupEnabled?: boolean;
  readonly auditFixEnabled?: boolean;
  readonly iteration?: number;
  readonly totalIterations?: number;
  readonly tasksDone?: number;
  readonly tasksTotal?: number;
  readonly agent?: string;
  readonly planFile?: string;
  readonly progressFile?: string;
  readonly lastOutput?: string;
  readonly worktreeMode?: string;
  readonly worktreeBranch?: string;
  readonly statusSource?: {
    readonly state: string;
    readonly authority: string;
    readonly freshness: string;
    readonly label: string;
    readonly stale: boolean;
    readonly message?: string;
  };
  readonly statusSources?: ReadonlyArray<{
    readonly source: string;
    readonly freshness: string;
    readonly label: string;
    readonly message?: string;
  }>;
}

export interface RalphStatusResult {
  readonly hitLimit: boolean;
  readonly status: string;
  readonly statusLabel: string;
  readonly dotClass: string;
  readonly dotTitle: string;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(value: string): string {
  return esc(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function getRalphStatus(loop: RalphLoop): RalphStatusResult {
  const sourceState = loop.statusSource?.state;
  const hitLimit = !loop.active && !loop.completed && !!loop.finished;
  const status: AgentStatusState = sourceState && isAgentStatusState(sourceState)
    ? sourceState
    : loop.audit ? AGENT_STATUS_STATE.AUDIT
      : loop.cleanup ? AGENT_STATUS_STATE.CLEANUP
        : loop.active ? AGENT_STATUS_STATE.RUNNING
          : loop.completed ? AGENT_STATUS_STATE.DONE
            : hitLimit ? AGENT_STATUS_STATE.STOPPED
              : AGENT_STATUS_STATE.IDLE;
  return {
    hitLimit,
    status: status === AGENT_STATUS_STATE.STOPPED ? RALPH_CARD_LIMIT_STATUS : status,
    statusLabel: agentStatusLabel(status),
    dotClass: loop.active ? "purple" : "gray",
    dotTitle: loop.active ? "active" : AGENT_STATUS_STATE.IDLE,
  };
}

export function renderStatusSource(loop: RalphLoop): string {
  const source = loop.statusSource;
  if (!source) return '<span class="ralph-authority unknown">authority unknown</span>';
  const cls = source.authority + (source.stale || source.freshness !== AGENT_STATUS_FRESHNESS.FRESH ? " stale" : "");
  const stale = source.stale || source.freshness !== AGENT_STATUS_FRESHNESS.FRESH ? " · " + source.freshness : "";
  const title = source.message ? ' title="' + escAttr(source.message) + '"' : "";
  return '<span class="ralph-authority ' + escAttr(cls) + '"' + title + '>' +
    esc(source.authority + " · " + source.label + stale) +
  "</span>";
}

export function renderRalphCardHtml(loop: RalphLoop, machineUrl: string): string {
  const { status, statusLabel, dotClass, dotTitle } = getRalphStatus(loop);
  const tasksDone = loop.tasksDone ?? 0;
  const tasksTotal = loop.tasksTotal ?? 0;
  const iteration = loop.iteration ?? 0;
  const totalIterations = loop.totalIterations ?? 0;
  const taskPct = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;
  const taskLabel = `${tasksDone}/${tasksTotal} tasks`;
  const iterLabel = totalIterations > 0 ? `${iteration}/${totalIterations} iter` : "";
  const lastOut = loop.lastOutput ? `<div class="ralph-last-output">${esc(loop.lastOutput)}</div>` : "";
  const planSuffix = loop.planFile ? ` <span class="ralph-plan-suffix">— ${esc(loop.planFile.replace(/\.md$/i, ""))}</span>` : "";
  const mUrl = escAttr(machineUrl || "");
  const project = escAttr(loop.project);
  return `<div class="ralph-card ${status}" onclick="openRalphDetail('${project}', '${mUrl}')">` +
    `<div class="ralph-card-header">` +
      `<span class="ralph-card-name"><span class="dot ${dotClass}" title="${dotTitle}"></span>${esc(loop.project)}${planSuffix}</span>` +
      `<span class="ralph-status ${status}">${statusLabel}</span>` +
      `<button class="kill-btn" onclick="dismissRalph('${project}', event, '${mUrl}')">&times;</button>` +
    `</div>` +
    `<div class="ralph-progress">` +
      `<div class="ralph-bar"><div class="ralph-bar-fill ${status}" style="width:${taskPct}%"></div></div>` +
      `<span class="ralph-iter">${taskLabel}</span>` +
    `</div>` +
    (iterLabel ? `<div class="ralph-iter ralph-iter-align">${iterLabel}</div>` : "") +
    `<div class="ralph-authority-row">${renderStatusSource(loop)}</div>` +
    lastOut +
  `</div>`;
}

export function sidebarRalphCardHtml(loop: RalphLoop, machineUrl: string): string {
  const { status, statusLabel, dotClass, dotTitle } = getRalphStatus(loop);
  const mUrl = escAttr(machineUrl || "");
  const project = escAttr(loop.project);
  return `<div class="ralph-card sidebar-ralph-card ${status}" onclick="openRalphDetail('${project}', '${mUrl}')">` +
    `<span class="dot ${dotClass}" title="${dotTitle}"></span>` +
    `<span class="sidebar-ralph-name">${esc(loop.project)}</span>` +
    `<span class="ralph-status ${status}">${statusLabel}</span>` +
    renderStatusSource(loop) +
    `<button class="kill-btn" onclick="dismissRalph('${project}', event, '${mUrl}')">&times;</button>` +
  `</div>`;
}
