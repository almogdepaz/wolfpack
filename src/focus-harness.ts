/** Scheduling trusts semantic Pi status when available; fallback requires a quiet visible prompt. */
export interface HarnessSample { state?: string; authority?: string; stale?: boolean; screen?: string; quietMs?: number }
export interface FocusHarness { isIdle(sample: HarnessSample): boolean; needsInput(sample: HarnessSample): boolean }
const question = (screen = "") => /(?:\?\s*(?:\([^\n]*\))?|\[y\/n\]|\(y\/n\)|permission|sign in|log in)\s*(?:\n[›>❯$#] ?)?\s*$/i.test(screen.trim());
export const genericHarness: FocusHarness = {
  needsInput: s => s.state === "needs-input" || question(s.screen),
  isIdle: s => (s.quietMs ?? 0) >= 5000 && !genericHarness.needsInput(s) && /(?:^|\n)[›>❯$#] ?$/.test(s.screen ?? ""),
};
const semantic = (s: HarnessSample) => !s.stale && (s.authority === "program" || s.authority === "manifest");
export const piHarness: FocusHarness = {
  needsInput: s => semantic(s) ? s.state === "needs-input" : genericHarness.needsInput(s),
  isIdle: s => semantic(s) ? s.state === "idle" || s.state === "done" : genericHarness.isIdle(s),
};
