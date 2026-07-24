import {
  isValidNamedViewMachineUrl,
  MAX_NAMED_VIEW_MEMBERS,
} from "../src/named-views";
import type {
  NamedViewFocusReference,
  NamedViewInput,
  NamedViewMemberReference,
  NamedViewRecord,
} from "../src/named-views";

interface BrowserNamedViewSession {
  readonly machineUrl: string;
  readonly machineName?: string;
  readonly sessionId: string;
  readonly sessionName: string;
}

interface NamedViewGridSession {
  readonly machine?: string;
  readonly session: string;
  readonly _namedViewUnavailable?: boolean;
  readonly _namedViewSessionId?: string;
  readonly _namedViewLabel?: string;
}

interface ResolvedNamedViewMember {
  readonly member: NamedViewMemberReference;
  readonly available: boolean;
  readonly live?: BrowserNamedViewSession;
}

interface ResolvedNamedView {
  readonly members: readonly ResolvedNamedViewMember[];
  readonly focusIndex: number;
}

interface NamedViewsListResponse {
  readonly views?: readonly NamedViewRecord[];
}

interface NamedViewMutationResponse {
  readonly view?: NamedViewRecord;
}

interface NamedViewAppState {
  readonly allSessions: readonly unknown[];
  readonly gridSessions: readonly NamedViewGridSession[];
  readonly gridFocusIndex: number;
  readonly sessionsExpanded?: boolean;
}

interface NamedViewDeps {
  api<TResponse = unknown>(path: string, opts?: RequestInit, machineUrl?: string): Promise<TResponse>;
  loadSessions(): Promise<void>;
  openSession(name: string, machineUrl?: string): void | Promise<void>;
  openGridComposition(sessions: readonly NamedViewGridSession[], focusIndex: number): void;
  renderNamedViewSurfaces(): void;
  state: NamedViewAppState;
  isDesktop(): boolean;
  esc(value: unknown): string;
  escAttr(value: unknown): string;
}

let deps: NamedViewDeps | null = null;
let namedViews: readonly NamedViewRecord[] = [];
let namedViewError = "";

export function initNamedViewDeps(nextDeps: NamedViewDeps): void {
  deps = nextDeps;
}

export function currentNamedViews(): readonly NamedViewRecord[] {
  return namedViews;
}

export function resolveNamedViewMembers(
  view: NamedViewRecord,
  liveSessions: readonly BrowserNamedViewSession[],
): ResolvedNamedView {
  const liveByStableKey = new Map<string, BrowserNamedViewSession>();
  for (const session of liveSessions) {
    if (!isValidNamedViewMachineUrl(session.machineUrl)) continue;
    liveByStableKey.set(namedViewStableKey(session.machineUrl, session.sessionId), session);
  }

  const members = view.members.map((member) => {
    const live = isValidNamedViewMachineUrl(member.machineUrl)
      ? liveByStableKey.get(namedViewStableKey(member.machineUrl, member.sessionId))
      : undefined;
    return {
      member,
      available: !!live,
      ...(live ? { live } : {}),
    };
  });

  const focusIndex = view.focused
    ? Math.max(0, members.findIndex((entry) => sameNamedViewReference(entry.member, view.focused!)))
    : 0;

  return {
    members,
    focusIndex: focusIndex >= 0 ? focusIndex : 0,
  };
}

export function collectNamedViewMembersFromGrid(
  gridSessions: readonly NamedViewGridSession[],
  liveSessions: readonly BrowserNamedViewSession[],
): readonly NamedViewMemberReference[] | null {
  if (gridSessions.length < 1 || gridSessions.length > MAX_NAMED_VIEW_MEMBERS) return null;
  const liveByName = new Map<string, BrowserNamedViewSession>();
  for (const session of liveSessions) {
    if (!isValidNamedViewMachineUrl(session.machineUrl)) continue;
    liveByName.set(namedViewNameKey(session.machineUrl, session.sessionName), session);
  }

  const members: NamedViewMemberReference[] = [];
  for (const gridSession of gridSessions) {
    const machineUrl = gridSession.machine || "";
    if (!isValidNamedViewMachineUrl(machineUrl)) return null;
    const preservedSessionId = gridSession._namedViewSessionId;
    if (preservedSessionId) {
      members.push({
        machineUrl,
        sessionId: preservedSessionId,
        sessionName: gridSession._namedViewLabel || gridSession.session,
      });
      continue;
    }
    const live = liveByName.get(namedViewNameKey(machineUrl, gridSession.session));
    if (!live) return null;
    members.push({
      machineUrl: live.machineUrl,
      sessionId: live.sessionId,
      sessionName: live.sessionName,
    });
  }
  return members;
}

export async function loadNamedViews(): Promise<void> {
  if (!deps) return;
  try {
    const data = await deps.api<NamedViewsListResponse>("/named-views");
    namedViews = Array.isArray(data.views) ? data.views : [];
    namedViewError = "";
  } catch (error) {
    namedViews = [];
    namedViewError = errorMessage(error);
  }
  deps.renderNamedViewSurfaces();
}

export function renderNamedViewsSection(mode: "desktop" | "mobile"): string {
  const views = namedViews;
  const appState = currentAppState();
  const canSaveGrid = desktop() && appState.gridSessions.length >= 2 && appState.gridSessions.length <= MAX_NAMED_VIEW_MEMBERS;
  const refreshButton = `<button class="named-view-btn" onclick="refreshNamedViews(event)">↻</button>`;
  const saveButton = mode === "desktop"
    ? `<button class="named-view-btn named-view-save" ${canSaveGrid ? "" : "disabled"} onclick="saveNamedViewFromActiveGrid(event)">save grid</button>`
    : "";
  let html = `<section class="named-view-section named-view-${mode}">
    <div class="named-view-header"><span>named views</span><div class="named-view-header-actions">${saveButton}${refreshButton}</div></div>`;
  if (namedViewError) {
    html += `<div class="named-view-error">${escapeHtml(namedViewError)}</div>`;
  } else if (!views.length) {
    html += `<div class="named-view-empty">no saved views</div>`;
  } else if (mode === "desktop") {
    html += views.map(renderDesktopNamedView).join("");
  } else {
    html += views.map(renderMobileNamedView).join("");
  }
  html += "</section>";
  return html;
}

export async function refreshNamedViews(event?: Event): Promise<void> {
  event?.stopPropagation();
  await loadNamedViews();
}

export async function saveNamedViewFromActiveGrid(event?: Event): Promise<void> {
  event?.stopPropagation();
  if (!deps) return;
  const appState = currentAppState();
  if (appState.gridSessions.length < 2 || appState.gridSessions.length > MAX_NAMED_VIEW_MEMBERS) {
    window.alert("open a 2–6 cell grid before saving a view");
    return;
  }
  const name = window.prompt("View name:");
  if (!name || !name.trim()) return;
  await deps.loadSessions();
  const input = namedViewInputFromCurrentGrid(name.trim());
  if (!input) {
    window.alert("cannot save view until every live grid cell has a stable session identity");
    return;
  }
  try {
    await deps.api<NamedViewMutationResponse>("/named-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await loadNamedViews();
  } catch (error) {
    window.alert("failed to save named view: " + errorMessage(error));
  }
}

export async function openNamedViewById(id: string, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (!deps) return;
  const view = namedViews.find((candidate) => candidate.id === id);
  if (!view) return;
  await deps.loadSessions();
  const resolved = resolveNamedViewMembers(view, currentLiveSessions());
  if (!desktop()) {
    deps.renderNamedViewSurfaces();
    return;
  }
  const gridSessions = resolved.members.map((entry): NamedViewGridSession => {
    if (entry.live) return {
      session: entry.live.sessionName,
      machine: entry.live.machineUrl,
      _namedViewSessionId: entry.member.sessionId,
      _namedViewLabel: entry.member.sessionName,
    };
    return {
      session: entry.member.sessionName,
      machine: entry.member.machineUrl,
      _namedViewUnavailable: true,
      _namedViewSessionId: entry.member.sessionId,
      _namedViewLabel: entry.member.sessionName,
    };
  });
  if (gridSessions.length === 1 && resolved.members[0]?.live) {
    await deps.openSession(resolved.members[0].live.sessionName, resolved.members[0].live.machineUrl || undefined);
    return;
  }
  if (gridSessions.length < 2) {
    window.alert("saved view has no live terminal to open");
    return;
  }
  deps.openGridComposition(gridSessions, resolved.focusIndex);
}

export async function openNamedViewMember(viewId: string, index: number, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (!deps) return;
  const view = namedViews.find((candidate) => candidate.id === viewId);
  if (!view) return;
  await deps.loadSessions();
  const resolved = resolveNamedViewMembers(view, currentLiveSessions());
  const member = resolved.members[index];
  if (!member?.live) return;
  await deps.openSession(member.live.sessionName, member.live.machineUrl || undefined);
}

export async function updateNamedViewFromActiveGrid(id: string, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (!deps) return;
  const existing = namedViews.find((candidate) => candidate.id === id);
  if (!existing) return;
  const appState = currentAppState();
  if (appState.gridSessions.length < 1 || appState.gridSessions.length > MAX_NAMED_VIEW_MEMBERS) {
    window.alert("open a grid before updating a view");
    return;
  }
  await deps.loadSessions();
  const input = namedViewInputFromCurrentGrid(existing.name);
  if (!input) {
    window.alert("cannot update view until every live grid cell has a stable session identity");
    return;
  }
  try {
    await deps.api<NamedViewMutationResponse>("/named-views", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...input }),
    });
    await loadNamedViews();
  } catch (error) {
    window.alert("failed to update named view: " + errorMessage(error));
  }
}

export async function duplicateNamedView(id: string, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (!deps) return;
  const view = namedViews.find((candidate) => candidate.id === id);
  if (!view) return;
  const name = window.prompt("Duplicate view name:", `${view.name} copy`);
  if (!name || !name.trim()) return;
  try {
    await deps.api<NamedViewMutationResponse>("/named-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        members: view.members,
        ...(view.focused ? { focused: view.focused } : {}),
      }),
    });
    await loadNamedViews();
  } catch (error) {
    window.alert("failed to duplicate named view: " + errorMessage(error));
  }
}

export async function deleteNamedView(id: string, event?: Event): Promise<void> {
  event?.stopPropagation();
  if (!deps) return;
  const view = namedViews.find((candidate) => candidate.id === id);
  if (!view) return;
  if (!window.confirm(`Delete named view "${view.name}"?`)) return;
  try {
    await deps.api("/named-views", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await loadNamedViews();
  } catch (error) {
    window.alert("failed to delete named view: " + errorMessage(error));
  }
}

function renderDesktopNamedView(view: NamedViewRecord): string {
  const count = view.members.length;
  return `<div class="named-view-row" data-view-id="${escapeAttr(view.id)}">
    <button class="named-view-open" onclick="openNamedViewById('${escapeAttr(view.id)}', event)">
      <span class="named-view-name">${escapeHtml(view.name)}</span>
      <span class="named-view-count">${count} slot${count === 1 ? "" : "s"}</span>
    </button>
    <button class="named-view-btn" onclick="updateNamedViewFromActiveGrid('${escapeAttr(view.id)}', event)">update</button>
    <button class="named-view-btn" onclick="duplicateNamedView('${escapeAttr(view.id)}', event)">dup</button>
    <button class="named-view-btn danger" onclick="deleteNamedView('${escapeAttr(view.id)}', event)">×</button>
  </div>`;
}

function renderMobileNamedView(view: NamedViewRecord): string {
  const resolved = resolveNamedViewMembers(view, currentLiveSessions());
  const members = resolved.members.map((entry, index) => {
    const machine = entry.live?.machineName || machineLabel(entry.member.machineUrl);
    const status = entry.available ? "open" : "unavailable";
    return `<button class="named-view-member${entry.available ? "" : " disabled"}" ${entry.available ? "" : "disabled"} onclick="openNamedViewMember('${escapeAttr(view.id)}', ${index}, event)">
      <span class="named-view-member-name">${escapeHtml(entry.member.sessionName)}</span>
      <span class="named-view-member-meta">${escapeHtml(machine)} · ${status}</span>
    </button>`;
  }).join("");
  return `<div class="named-view-card" data-view-id="${escapeAttr(view.id)}">
    <div class="named-view-card-title">${escapeHtml(view.name)}</div>
    <div class="named-view-members">${members}</div>
  </div>`;
}

function namedViewInputFromCurrentGrid(name: string): NamedViewInput | null {
  const appState = currentAppState();
  const members = collectNamedViewMembersFromGrid(appState.gridSessions, currentLiveSessions());
  if (!members) return null;
  const focusMember = members[Math.max(0, Math.min(appState.gridFocusIndex, members.length - 1))] || members[0];
  const focused: NamedViewFocusReference | undefined = focusMember
    ? { machineUrl: focusMember.machineUrl, sessionId: focusMember.sessionId }
    : undefined;
  return {
    name,
    members,
    ...(focused ? { focused } : {}),
  };
}

function currentLiveSessions(): readonly BrowserNamedViewSession[] {
  const appState = currentAppState();
  const sessions = Array.isArray(appState.allSessions) ? appState.allSessions : [];
  const out: BrowserNamedViewSession[] = [];
  for (const session of sessions) {
    const sessionId = sessionIdentityId(session);
    const sessionName = typeof session.name === "string" ? session.name : "";
    const machineUrl = typeof session.machineUrl === "string" ? session.machineUrl : "";
    if (!sessionId || !sessionName || !isValidNamedViewMachineUrl(machineUrl)) continue;
    out.push({
      machineUrl,
      sessionId,
      sessionName,
      machineName: typeof session.machineName === "string" ? session.machineName : undefined,
    });
  }
  return out;
}

function sessionIdentityId(session: unknown): string | null {
  if (!session || typeof session !== "object") return null;
  const identity = (session as Record<string, unknown>).identity;
  if (!identity || typeof identity !== "object") return null;
  const id = (identity as Record<string, unknown>).wolfpackSessionId;
  return typeof id === "string" && id ? id : null;
}

function machineLabel(machineUrl: string): string {
  if (!machineUrl) return "local";
  try { return new URL(machineUrl).hostname; } catch { return "remote"; }
}

function currentAppState(): NamedViewAppState {
  return deps?.state ?? { allSessions: [], gridSessions: [], gridFocusIndex: 0 };
}

function desktop(): boolean {
  return deps ? deps.isDesktop() : true;
}

function escapeHtml(value: unknown): string {
  return deps ? deps.esc(value) : String(value ?? "");
}

function escapeAttr(value: unknown): string {
  return deps ? deps.escAttr(value) : String(value ?? "").replace(/'/g, "\\'");
}

function namedViewStableKey(machineUrl: string, sessionId: string): string {
  return `${machineUrl}\0${sessionId}`;
}

function namedViewNameKey(machineUrl: string, sessionName: string): string {
  return `${machineUrl}\0${sessionName}`;
}

function sameNamedViewReference(left: NamedViewFocusReference, right: NamedViewFocusReference): boolean {
  return left.machineUrl === right.machineUrl && left.sessionId === right.sessionId;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error || "unknown error");
}
