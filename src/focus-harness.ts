import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_STATE } from "./agent-status-contract.js";
/** Scheduling trusts semantic Pi status when available; fallback requires a quiet visible prompt. */
export interface HarnessSample { state?: string; authority?: string; stale?: boolean; screen?: string; quietMs?: number }
export interface FocusHarness { isIdle(sample: HarnessSample): boolean; needsInput(sample: HarnessSample): boolean }
const question = (screen = "") => /(?:\?\s*(?:\([^\n]*\))?|\[y\/n\]|\(y\/n\)|permission|sign in|log in)\s*(?:\n[›>❯$#] ?)?\s*$/i.test(screen.trim());
export const genericHarness: FocusHarness = {
  needsInput: s => s.state === AGENT_STATUS_STATE.NEEDS_INPUT || question(s.screen),
  isIdle: s => (s.quietMs ?? 0) >= 5000 && !genericHarness.needsInput(s) && /(?:^|\n)[›>❯$#] ?$/.test(s.screen ?? ""),
};
const semantic = (s: HarnessSample) => !s.stale && (s.authority === AGENT_STATUS_AUTHORITY.PROGRAM || s.authority === AGENT_STATUS_AUTHORITY.MANIFEST);
export const piHarness: FocusHarness = {
  needsInput: s => semantic(s) ? s.state === AGENT_STATUS_STATE.NEEDS_INPUT : genericHarness.needsInput(s),
  isIdle: s => semantic(s) ? s.state === AGENT_STATUS_STATE.IDLE || s.state === AGENT_STATUS_STATE.DONE : genericHarness.isIdle(s),
};
