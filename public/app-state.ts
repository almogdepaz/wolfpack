// ── Shared state, settings, and utilities ──
// Extracted from app.ts — imported back via bundler (inlined at build time)

import {
  applyNotificationPreference,
  NOTIFICATION_CHANGE_FAILURE,
} from "../src/notification-preference";
import type {
  NotificationChangeFailure,
  NotificationChangeResult,
  NotificationPreferenceOutcome,
} from "../src/notification-preference";
import { unsubscribePushNotifications } from "../src/push-unsubscribe";
import {
  PUSH_API_PATH,
  requestSameOriginPushApi,
  sameOriginPushUrl,
} from "../src/push-subscription-origin";
import { authenticatedFetchWithTimeout } from "./browser-auth";

export { esc, escAttr } from "../src/html-escape";

// ── Generic utilities ──

export function loadStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function isDesktop() {
  return window.innerWidth > 768;
}

export function getTerminalFontFamily() {
  return wpSettings.termFont === "alt"
    ? '"JetBrains Mono", "Fira Code", "Source Code Pro", "Cascadia Code", monospace'
    : '"SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", "Liberation Mono", monospace';
}

// ── Settings (persisted to localStorage) ──

export const wpDefaults = {animations:true, haptics:true, notifications:false, recoveryCache:true, enterSends: window.innerWidth > 768, holdToSend:false, termFontSize:"medium", termFont:"default", debugPanel:false};

function loadWpSettings() {
  const stored = loadStoredJson("wp-effects", {});
  const settings = { ...wpDefaults };
  for (const key of Object.keys(wpDefaults)) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) settings[key] = stored[key];
  }
  return settings;
}

export const wpSettings = loadWpSettings();

export const TERM_PRESETS = { small: {fontSize:12, lineHeight:1.35}, medium: {fontSize:13, lineHeight:1.45}, large: {fontSize:14, lineHeight:1.55}, xlarge: {fontSize:18, lineHeight:1.45} };

const NOTIFICATION_FAILURE_MESSAGES: Readonly<Record<NotificationChangeFailure, string>> = {
  [NOTIFICATION_CHANGE_FAILURE.UNSUPPORTED]: "Push notifications are not supported in this browser.",
  [NOTIFICATION_CHANGE_FAILURE.PERMISSION_DENIED]: "Notifications are blocked in browser settings. Allow them for this site, then retry.",
  [NOTIFICATION_CHANGE_FAILURE.SERVICE_WORKER]: "Wolfpack could not start notification support. Reload the app, then retry.",
  [NOTIFICATION_CHANGE_FAILURE.SUBSCRIPTION]: "This device could not create a push subscription. Check browser notification settings, then retry.",
  [NOTIFICATION_CHANGE_FAILURE.SERVER]: "Wolfpack could not register this device. Check your connection, then retry.",
  [NOTIFICATION_CHANGE_FAILURE.UNSUBSCRIBE]: "Wolfpack could not disable notifications. Check your connection, then retry.",
};

let notificationPreferenceBusy = false;

function setNotificationStatus(message: string, status: "idle" | "pending" | "success" | "error"): void {
  const control = document.getElementById("notification-setting-status");
  if (!control) return;
  control.textContent = message;
  control.dataset.state = status;
}

function notificationsSupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

function renderNotificationRestingStatus(): void {
  if (!notificationsSupported()) {
    setNotificationStatus(NOTIFICATION_FAILURE_MESSAGES[NOTIFICATION_CHANGE_FAILURE.UNSUPPORTED], "error");
    return;
  }
  if (Notification.permission === "denied") {
    setNotificationStatus(NOTIFICATION_FAILURE_MESSAGES[NOTIFICATION_CHANGE_FAILURE.PERMISSION_DENIED], "error");
    return;
  }
  if (wpSettings.notifications && state.notificationsEnabled) {
    setNotificationStatus("Notifications are enabled on this device.", "success");
    return;
  }
  setNotificationStatus("Notifications are off.", "idle");
}

function renderNotificationOutcome(outcome: NotificationPreferenceOutcome): void {
  const change = outcome.change;
  if (change.ok === true) {
    renderNotificationRestingStatus();
    return;
  }
  setNotificationStatus(NOTIFICATION_FAILURE_MESSAGES[change.reason], "error");
}

function setNotificationPreferenceBusy(busy: boolean, requested: boolean): void {
  notificationPreferenceBusy = busy;
  const control = document.getElementById("setting-notifications") as HTMLInputElement | null;
  if (control) control.disabled = busy;
  if (busy) setNotificationStatus(requested ? "Enabling notifications…" : "Disabling notifications…", "pending");
}

function commitNotificationPreference(enabled: boolean): void {
  wpSettings.notifications = enabled;
  localStorage.setItem("wp-effects", JSON.stringify(wpSettings));
  const control = document.getElementById("setting-notifications") as HTMLInputElement | null;
  if (control) control.checked = enabled;
}

let notificationPreferenceChange = Promise.resolve();

async function changeNotificationPreference(requested: boolean): Promise<void> {
  const change = notificationPreferenceChange.then(async () => {
    setNotificationPreferenceBusy(true, requested);
    try {
      const outcome = await applyNotificationPreference({
        current: wpSettings.notifications,
        requested,
        changeSubscription: requested ? requestNotifications : unsubscribeNotifications,
        commit: commitNotificationPreference,
      });
      renderNotificationOutcome(outcome);
    } catch (error: unknown) {
      console.error("Notification preference change failed:", error);
      setNotificationStatus("Wolfpack could not update notifications. Reload the app, then retry.", "error");
    } finally {
      setNotificationPreferenceBusy(false, requested);
    }
  });
  notificationPreferenceChange = change;
  await change;
}

export function toggleSetting(key, val) {
  if (key === "notifications") {
    void changeNotificationPreference(Boolean(val));
    return;
  }
  wpSettings[key] = val;
  localStorage.setItem("wp-effects", JSON.stringify(wpSettings));
  applySetting(key, val);
}

export function applySetting(key, val) {
  if (key === "animations") document.body.classList.toggle("no-animations", !val);
  if (key === "notifications") void changeNotificationPreference(Boolean(val));
  if (key === "enterSends") {
    const el = document.getElementById("msg-input") as HTMLTextAreaElement | null;
    if (el) el.placeholder = val ? "$ (Enter to send)" : "$ (⚡ to send)";
  }
  if (key === "termFontSize") {
    document.body.classList.remove("term-size-small", "term-size-medium", "term-size-large", "term-size-xlarge");
    document.body.classList.add("term-size-" + val);
    document.querySelectorAll(".term-size-btn").forEach(b => {
      const selected = (b as HTMLElement).dataset.size === val;
      b.classList.toggle("active", selected);
      b.setAttribute("aria-pressed", String(selected));
    });
    applyTermToXterm();
  }
  if (key === "termFont") {
    document.body.classList.toggle("term-font-alt", val === "alt");
    document.querySelectorAll(".term-font-btn").forEach(b => {
      const selected = (b as HTMLElement).dataset.font === val;
      b.classList.toggle("active", selected);
      b.setAttribute("aria-pressed", String(selected));
    });
    applyTermToXterm();
  }
}

export function applyTermToXterm() {
  const p = TERM_PRESETS[wpSettings.termFontSize] || TERM_PRESETS.medium;
  const fontFamily = getTerminalFontFamily();
  if (state.terminalController?.term) {
    state.terminalController.term.options.fontSize = p.fontSize;
    state.terminalController.term.options.lineHeight = p.lineHeight;
    state.terminalController.term.options.fontFamily = fontFamily;
    state.terminalController.resize();
  }
  for (const gs of [...state.gridSessions, ...state.delegationGridSessions]) {
    if (!gs.controller?.term) continue;
    gs.controller.term.options.fontSize = Math.max(p.fontSize - 2, 10);
    gs.controller.term.options.lineHeight = p.lineHeight;
    gs.controller.term.options.fontFamily = fontFamily;
    gs.controller.resize();
  }
}

export function initSettings() {
  Object.entries(wpSettings).forEach(([k, v]) => {
    applySetting(k, v);
    const el = document.getElementById("setting-" + k) as HTMLInputElement | null;
    if (!el) return;
    if (el.type === "checkbox") el.checked = v as boolean;
    else el.value = v as string;
  });
}

export function haptic(pattern) {
  if (wpSettings.haptics && navigator.vibrate) navigator.vibrate(pattern);
}

// ── Push Notifications ──

/** Convert a base64url string to a Uint8Array (for applicationServerKey). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function notificationChangeFailed(
  reason: NotificationChangeFailure,
  error: unknown = undefined,
): NotificationChangeResult {
  state.notificationsEnabled = false;
  if (error !== undefined) console.error("Push notification change failed:", error);
  return { ok: false, reason };
}

export async function requestNotifications(): Promise<NotificationChangeResult> {
  if (!notificationsSupported()) {
    console.warn("Push notifications not supported");
    return notificationChangeFailed(NOTIFICATION_CHANGE_FAILURE.UNSUPPORTED);
  }

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (error: unknown) {
      return notificationChangeFailed(NOTIFICATION_CHANGE_FAILURE.PERMISSION_DENIED, error);
    }
  }
  if (permission !== "granted") {
    return notificationChangeFailed(NOTIFICATION_CHANGE_FAILURE.PERMISSION_DENIED);
  }

  let publicKey: string;
  try {
    const response = await requestSameOriginPushApi(
      authenticatedFetchWithTimeout,
      location.origin,
      PUSH_API_PATH.vapidKey,
    );
    if (!response.ok) throw new Error(`VAPID key request failed: ${response.status}`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("publicKey" in body)
      || typeof body.publicKey !== "string" || body.publicKey.length === 0) {
      throw new Error("VAPID key response is missing publicKey");
    }
    publicKey = body.publicKey;
  } catch (error: unknown) {
    return notificationChangeFailed(NOTIFICATION_CHANGE_FAILURE.SERVER, error);
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(sameOriginPushUrl(location.origin, "/sw.js"));
    await navigator.serviceWorker.ready;
  } catch (error: unknown) {
    return notificationChangeFailed(NOTIFICATION_CHANGE_FAILURE.SERVICE_WORKER, error);
  }

  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  } catch (error: unknown) {
    const reason = Notification.permission === "denied"
      ? NOTIFICATION_CHANGE_FAILURE.PERMISSION_DENIED
      : NOTIFICATION_CHANGE_FAILURE.SUBSCRIPTION;
    return notificationChangeFailed(reason, error);
  }

  try {
    const response = await requestSameOriginPushApi(
      authenticatedFetchWithTimeout,
      location.origin,
      PUSH_API_PATH.subscribe,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      },
    );
    if (!response.ok) throw new Error(`subscription registration failed: ${response.status}`);
  } catch (error: unknown) {
    return notificationChangeFailed(NOTIFICATION_CHANGE_FAILURE.SERVER, error);
  }

  state.notificationsEnabled = true;
  console.log("Push subscription registered");
  return { ok: true };
}

export async function unsubscribeNotifications(): Promise<NotificationChangeResult> {
  const outcome = await unsubscribePushNotifications(
    state,
    async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.pushManager.getSubscription() ?? null;
    },
    endpoint => requestSameOriginPushApi(
      authenticatedFetchWithTimeout,
      location.origin,
      PUSH_API_PATH.unsubscribe,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      },
    ),
  );
  if ("error" in outcome) {
    console.error("Push unsubscribe failed:", outcome.error);
    return { ok: false, reason: NOTIFICATION_CHANGE_FAILURE.UNSUBSCRIBE };
  }
  if (outcome.removed) console.log("Push subscription removed");
  return { ok: true };
}

// ── State initializer helpers ──

export const QC_STORAGE_KEY = "wp-quick-cmds";

export function loadQuickCmds() {
  try {
    const raw = localStorage.getItem(QC_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export const RECENTS_STORAGE_KEY = "wp-recents";
export const MAX_RECENTS = 20;

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
    if (raw) { const r = JSON.parse(raw); if (Array.isArray(r)) return r; }
  } catch {}
  return [];
}

function loadSidebarPinned() {
  const v = localStorage.getItem("wolfpack-sidebar-pinned");
  if (v !== null) return v !== "0";
  const old = localStorage.getItem("wolfpack-sidebar-collapsed");
  if (old === "1") return false;
  return true;
}

const _initSidebarPinned = loadSidebarPinned();

// ── App state ──

export const state = {
  currentView: "sessions",
  currentSession: null,
  currentMachine: "", // "" = self, URL string = remote
  viewBeforePicker: "sessions", // stashed view to return to on Escape from project/agent picker
  viewBeforeSettings: "sessions",
  // session/data state
  allSessions: [],
  lastSessionGroups: [],
  firstLoad: true,
  lastSessionsHtml: "",
  loadSessionsEpoch: 0,
  selfName: "",
  selfVersion: "",
  sessionRecents: loadRecents(),
  quickCmds: loadQuickCmds(),
  // desktop/grid terminal state
  terminalController: null,
  desktopResizeHandler: null,
  desktopResizeTimer: null,
  _touchCleanup: null,
  visualViewportHandler: null,
  kbResizeTimer: null,
  gridSessions: [],
  gridFocusIndex: 0,
  preservedGridSessions: [],
  preservedGridFocusIndex: 0,
  gridResizeHandler: null,
  gridRelayoutTransitionId: 0,
  // Ephemeral delegation workspace. Kept separate from manual gridSessions.
  activeDelegationRoot: null,
  focusedDelegationSession: null,
  delegationMachine: "",
  delegationGridSessions: [],
  delegationGridFocusIndex: 0,
  // sidebar state
  sidebarPinned: _initSidebarPinned,
  sidebarCollapsed: !_initSidebarPinned,
  sidebarAutoExpanded: false,
  sidebarTransitionIsHover: false,
  sidebarLayoutTransitioning: false,
  sessionsExpanded: false,
  // connection state
  sessionRefreshTimer: null,
  // UI interaction state
  snapshotTimer: null,
  swipeNavigated: false,
  projectMachine: "",
  selectedProject: "",
  selectedProjectDir: "",
  newProjectParent: "",
  isNewProject: false,
  enterRetryTimer: null,
  drawerOpen: false,
  notificationsEnabled: ("Notification" in window && Notification.permission === "granted" && "PushManager" in window),
  notificationUnsubscribePending: false,
  notificationUnsubscribeInFlight: false,
  kbAccessoryOpen: false,
  _cachedFallbackTimer: null,
  // peer health: { [machineUrl]: { failures } }. A peer that fails repeatedly
  // drops to a shorter fetch timeout so it doesn't dominate UI refresh time.
  // Intentionally NOT persisted across page reloads — stale failure state
  // is a self-fulfilling prophecy: a peer that was slow yesterday gets the
  // 1.5s failing-timeout today, fails again because legit cold fetches
  // sometimes take longer than that, and never recovers. Per-tab in-memory
  // is the right scope.
  peerHealth: {} as Record<string, { failures: number }>,
};

export function setState(patch) { Object.assign(state, patch); }

// Detect OS-level notification permission revoke. Browser permission can be
// toggled from the URL bar / system settings without the page knowing —
// re-check on visibility/focus so the UI toggle doesn't silently lie.
export function syncNotificationsPermission(): void {
  if (notificationPreferenceBusy) return;
  if (state.notificationUnsubscribePending) {
    void changeNotificationPreference(false);
    return;
  }
  if (!notificationsSupported()) {
    renderNotificationRestingStatus();
    return;
  }
  const granted = Notification.permission === "granted";
  if (state.notificationsEnabled && !granted) {
    state.notificationsEnabled = false;
    // Route through toggleSetting so applySetting("notifications", false) runs
    // unsubscribeNotifications() — otherwise server retains stale push endpoint.
    toggleSetting("notifications", false);
    return;
  }
  renderNotificationRestingStatus();
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", syncNotificationsPermission);
  window.addEventListener("focus", syncNotificationsPermission);
}

// ── Constants ──

export const SNAPSHOT_KEY_PREFIX = "wp-snap|";
export const SNAPSHOT_MAX_BYTES = 16384;
export const SNAPSHOT_SAVE_INTERVAL = 2000;
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const DESKTOP_TERMINAL_SCROLLBACK = 2000;
export const GRID_TERMINAL_SCROLLBACK = 1000;
