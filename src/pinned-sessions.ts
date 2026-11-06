import { isAbsolute } from "node:path";
import { isValidSessionName } from "./validation.js";
export interface PinnedSession { name: string; cwd: string; command: readonly string[]; harness: string }
export interface PinHistory { failures: number; retryAt: number }
export const PIN_FAILURE_LIMIT = 5;
export const PIN_STABLE_MS = 60_000;
export function isPinnedSessions(value: unknown): value is PinnedSession[] {
  return Array.isArray(value) && value.length <= 32 && value.every(p => p && typeof p === "object" && !Array.isArray(p)
    && Object.keys(p).every(k => ["name", "cwd", "command", "harness"].includes(k)) && typeof p.name === "string" && isValidSessionName(p.name)
    && typeof p.cwd === "string" && isAbsolute(p.cwd) && p.cwd.length <= 4096
    && typeof p.harness === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(p.harness)
    && Array.isArray(p.command) && p.command.length > 0 && p.command.length <= 64 && p.command.every((s: unknown) => typeof s === "string" && s.length <= 8192 && !s.includes("\0")) && p.command[0].length > 0)
    && new Set(value.map(p => p.name)).size === value.length;
}
export function recordPinFailure(previous: PinHistory | undefined, now: number): PinHistory {
  const failures = (previous?.failures ?? 0) + 1;
  return { failures, retryAt: now + Math.min(60_000, 1000 * 2 ** (failures - 1)) };
}
type PinDirectory = Pick<PinnedSession, "name" | "cwd">;
/** Reserve all configured writers before launching any, including a live unpinned assistant. */
export function conflictingAssistantPins(pins: readonly PinDirectory[], live: readonly PinDirectory[]): ReadonlySet<string> {
  const assistantDirectories = new Set([...pins, ...live].filter(p => p.name === "assistant").map(p => p.cwd));
  return new Set(pins.filter(pin => assistantDirectories.has(pin.cwd) && (
    pins.some(other => other.name !== pin.name && other.cwd === pin.cwd)
    || live.some(owner => owner.name !== pin.name && owner.cwd === pin.cwd)
  )).map(pin => pin.name));
}
/** Config and live names are authoritative; failures never justify replacing a live session. */
export function reconcilePinned(pins: readonly PinnedSession[], live: readonly string[], history: Readonly<Record<string, PinHistory>>, now: number): { name: string; action: "create" | "wait" | "failed" }[] {
  return pins.filter(p => !live.includes(p.name)).map(p => {
    const failure = history[p.name];
    return { name: p.name, action: failure && failure.failures >= PIN_FAILURE_LIMIT ? "failed" : failure && now < failure.retryAt ? "wait" : "create" };
  });
}
