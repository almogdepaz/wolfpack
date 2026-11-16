import { isFocusIntentionId } from "./focus-contract.js";
import { isValidSessionName } from "./validation.js";
import { UUID_PATTERN, canonicalTailnetOrigin } from "./tailnet-machine-contract.js";
import { isStableMachineIdentity, LOCAL_MACHINE_IDENTITY } from "./tailnet-peer-registry.js";
/** Local focus UX event contract. Deliberately contains no user or terminal text. */
export const FOCUS_UI_PATH = "/api/focus/ui-events";
export const FOCUS_UI_BATCH_MAX = 32;
export const FOCUS_UI_ACTION = {
  OPEN: "page.open", LEFT: "page.left", VIEW: "view", SHOWN: "cards.shown",
  CARD: "card", INTENTION: "intention", ASSISTANT: "assistant", SETTINGS: "settings", DISCLOSURE: "disclosure",
} as const;
export const FOCUS_UI_CARD = { EXPAND: "expand", COLLAPSE: "collapse", OPEN: "open", TAKE: "take", REPLY: "reply", SEEN: "seen", DONE: "done", RESET: "reset" } as const;
export const FOCUS_UI_INTENTION = { ADD: "add", DONE: "done", UNDO: "undo", EDIT: "edit", REORDER: "reorder", DROP: "drop" } as const;
export const FOCUS_UI_ASSISTANT = { TALK: "talk", REPLY: "reply", PLAN: "plan", SHOW: "show", HIDE: "hide", FOCUS: "focus", TAKE_CONTROL: "take-control", RECONNECT: "reconnect", SKIP: "skip" } as const;
export const FOCUS_UI_SETTINGS = { OPEN: "open", ENABLE: "enable", DISABLE: "disable", BACKGROUND: "background", CHAT: "chat", TIMING: "timing", HOME: "home", CATCH_UP: "catch-up", DAY_NOTE: "day-note", DAY_NOTE_READ: "day-note-read", DISMISS_TAKE: "dismiss-take" } as const;
export const FOCUS_UI_DISCLOSURE = { EXPAND: "expand", COLLAPSE: "collapse", MORE: "more" } as const;
export interface FocusUiCard { session: string; sessionId: string; machine: string; rank: number; kind: "action" | "suggest" | "done"; reason: "needs-you" | "suggest" | "quiet" | "rules" | "new-rules"; }
type Value<T> = T[keyof T];
interface EventBase { visit: string; at: string }
export type FocusUiEvent = EventBase & (
  | { action: typeof FOCUS_UI_ACTION.OPEN }
  | { action: typeof FOCUS_UI_ACTION.LEFT; visibleMs: number }
  | { action: typeof FOCUS_UI_ACTION.VIEW; docked: boolean }
  | { action: typeof FOCUS_UI_ACTION.SHOWN; cards: FocusUiCard[] }
  | { action: typeof FOCUS_UI_ACTION.CARD; control: Value<typeof FOCUS_UI_CARD>; session: string; sessionId: string; machine: string }
  | { action: typeof FOCUS_UI_ACTION.INTENTION; control: Value<typeof FOCUS_UI_INTENTION>; id: string }
  | { action: typeof FOCUS_UI_ACTION.ASSISTANT; control: Value<typeof FOCUS_UI_ASSISTANT>; id?: string }
  | { action: typeof FOCUS_UI_ACTION.SETTINGS; control: Value<typeof FOCUS_UI_SETTINGS> }
  | { action: typeof FOCUS_UI_ACTION.DISCLOSURE; control: Value<typeof FOCUS_UI_DISCLOSURE>; id?: string }
);
export type FocusUiRow = FocusUiEvent & { seq: number };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const sessionName = (v: unknown): v is string => typeof v === "string" && isValidSessionName(v);
// The UI can see mock fixture IDs and legacy name selectors as well as broker UUIDs.
const sessionId = (v: unknown): v is string => typeof v === "string" && (isValidSessionName(v) || v.startsWith("mock:") && isValidSessionName(v.slice(5)));
const machineId = (v: unknown): v is string => typeof v === "string" && v.length <= 320 && (v === LOCAL_MACHINE_IDENTITY || UUID_PATTERN.test(v) || v.startsWith("https://") && canonicalTailnetOrigin(v.slice(8)) === v || isStableMachineIdentity(v));
const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const member = (v: unknown, values: object) => Object.values(values).includes(v);
function isEvent(v: unknown): v is FocusUiEvent {
  if (!object(v) || typeof v.visit !== "string" || !UUID_PATTERN.test(v.visit) || !iso(v.at)) return false;
  const keys = ["visit", "at", "action"];
  const shape = (...extra: string[]) => only(v, [...keys, ...extra]);
  switch (v.action) {
    case FOCUS_UI_ACTION.OPEN: return shape();
    case FOCUS_UI_ACTION.LEFT: return shape("visibleMs") && Number.isSafeInteger(v.visibleMs) && (v.visibleMs as number) >= 0 && (v.visibleMs as number) <= 86_400_000;
    case FOCUS_UI_ACTION.VIEW: return shape("docked") && typeof v.docked === "boolean";
    case FOCUS_UI_ACTION.SHOWN: return shape("cards") && Array.isArray(v.cards) && v.cards.length <= 128 && v.cards.every((c, i) => object(c) && only(c, ["session", "sessionId", "machine", "rank", "kind", "reason"]) && sessionName(c.session) && sessionId(c.sessionId) && machineId(c.machine) && Number.isSafeInteger(c.rank) && c.rank === i + 1 && ["action", "suggest", "done"].includes(c.kind as string) && ["needs-you", "suggest", "quiet", "rules", "new-rules"].includes(c.reason as string));
    case FOCUS_UI_ACTION.CARD: return shape("control", "session", "sessionId", "machine") && member(v.control, FOCUS_UI_CARD) && sessionName(v.session) && sessionId(v.sessionId) && machineId(v.machine);
    case FOCUS_UI_ACTION.INTENTION: return shape("control", "id") && member(v.control, FOCUS_UI_INTENTION) && isFocusIntentionId(v.id);
    case FOCUS_UI_ACTION.ASSISTANT: return shape("control", "id") && member(v.control, FOCUS_UI_ASSISTANT) && (v.id === undefined || isFocusIntentionId(v.id));
    case FOCUS_UI_ACTION.SETTINGS: return shape("control") && member(v.control, FOCUS_UI_SETTINGS);
    case FOCUS_UI_ACTION.DISCLOSURE: return shape("control", "id") && member(v.control, FOCUS_UI_DISCLOSURE) && (v.id === undefined || isFocusIntentionId(v.id));
    default: return false;
  }
}
export function parseFocusUiBatch(value: unknown): FocusUiEvent[] | null {
  return object(value) && only(value, ["events"]) && Array.isArray(value.events) && value.events.length > 0 && value.events.length <= FOCUS_UI_BATCH_MAX && value.events.every(isEvent) ? value.events : null;
}
export function isFocusUiRow(value: unknown): value is FocusUiRow {
  if (!object(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return false;
  const { seq: _seq, ...event } = value;
  return isEvent(event);
}
