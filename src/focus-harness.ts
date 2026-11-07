import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_STATE } from "./agent-status-contract.js";
/** Scheduling trusts semantic Pi status when available; fallback requires a quiet visible prompt. */
export interface HarnessSample { state?: string; authority?: string; stale?: boolean; screen?: string; quietMs?: number }
export interface FocusHarness { needsScreen(sample: HarnessSample): boolean; isIdle(sample: HarnessSample): boolean; needsInput(sample: HarnessSample): boolean }
const semantic = (s: HarnessSample) => !s.stale && (s.authority === AGENT_STATUS_AUTHORITY.PROGRAM || s.authority === AGENT_STATUS_AUTHORITY.MANIFEST);
const question = (screen = "") => /(?:\?\s*(?:\([^\n]*\))?|\[y\/n\]|\(y\/n\)|permission|sign in|log in)\s*(?:\n[›>❯$#] ?)?\s*$/i.test(screen.trim());
/** A TUI select dialog (pi: trust folder, login, resume) ends in its navigation footer, with no prompt row after it. */
const selectDialog = (screen = "") => /(?:^|\n)[^\n]*enter select[^\n]*(?:escape|cancel)[^\n]*[\s─—-]*$/i.test(screen.trim());
export const genericHarness: FocusHarness = {
  needsScreen: () => true,
  needsInput: s => s.state === AGENT_STATUS_STATE.NEEDS_INPUT || question(s.screen) || selectDialog(s.screen),
  isIdle: s => !(semantic(s) && s.state !== AGENT_STATUS_STATE.IDLE && s.state !== AGENT_STATUS_STATE.DONE)
    && (s.quietMs ?? 0) >= 5000 && !genericHarness.needsInput(s) && /(?:^|\n)[›❯$]\s*$/.test(s.screen ?? ""),
};
export const piHarness: FocusHarness = {
  needsScreen: s => !semantic(s),
  needsInput: s => semantic(s) ? s.state === AGENT_STATUS_STATE.NEEDS_INPUT : genericHarness.needsInput(s),
  isIdle: s => semantic(s) ? s.state === AGENT_STATUS_STATE.IDLE || s.state === AGENT_STATUS_STATE.DONE : genericHarness.isIdle(s),
};
