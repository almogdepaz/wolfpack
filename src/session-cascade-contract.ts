/**
 * Child cleanup cascade contract: the policy a child records at spawn, and the
 * per-child outcome a parent kill reports in `cascaded`.
 */

/** A recorded child policy; `none` reports a child without one (pre-upgrade or top-level). */
export const CHILD_CLEANUP = {
  /** The child is killed when its parent is killed or dies. Default for new children. */
  CASCADE: "cascade",
  /** The child keeps running after its parent (`--outlive-parent`). */
  OUTLIVE: "outlive",
  /** No recorded policy: the child never cascades. */
  NONE: "none",
} as const;

export type ChildCleanupPolicy = typeof CHILD_CLEANUP.CASCADE | typeof CHILD_CLEANUP.OUTLIVE;
export type ChildCleanupReport = (typeof CHILD_CLEANUP)[keyof typeof CHILD_CLEANUP];

export const CHILD_CLEANUP_POLICIES: readonly ChildCleanupPolicy[] = [CHILD_CLEANUP.CASCADE, CHILD_CLEANUP.OUTLIVE];
export const CHILD_CLEANUP_REPORTS: readonly ChildCleanupReport[] = [...CHILD_CLEANUP_POLICIES, CHILD_CLEANUP.NONE];

export function isChildCleanupPolicy(value: unknown): value is ChildCleanupPolicy {
  return value === CHILD_CLEANUP.CASCADE || value === CHILD_CLEANUP.OUTLIVE;
}

export const CASCADE_OUTCOME = {
  KILLED: "killed",
  /** The child had already exited; skipped, not an error. */
  ALREADY_GONE: "already_gone",
  FAILED: "failed",
} as const;

export type CascadeOutcome = (typeof CASCADE_OUTCOME)[keyof typeof CASCADE_OUTCOME];
export const CASCADE_OUTCOMES: readonly CascadeOutcome[] = Object.values(CASCADE_OUTCOME);

export interface CascadedChild {
  readonly sessionId: string;
  readonly session: string;
  readonly outcome: CascadeOutcome;
  /** `failed` only: why the kill failed. */
  readonly reason?: string;
}
