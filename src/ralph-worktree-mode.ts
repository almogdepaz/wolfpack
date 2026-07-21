export const RALPH_WORKTREE_MODE = {
  DISABLED: "false",
  PLAN: "plan",
  TASK: "task",
} as const;

export const RALPH_WORKTREE_MODES = [
  RALPH_WORKTREE_MODE.DISABLED,
  RALPH_WORKTREE_MODE.PLAN,
  RALPH_WORKTREE_MODE.TASK,
] as const;

export const ACTIVE_RALPH_WORKTREE_MODES = [
  RALPH_WORKTREE_MODE.PLAN,
  RALPH_WORKTREE_MODE.TASK,
] as const;

export type RalphWorktreeMode = typeof RALPH_WORKTREE_MODES[number];
export type ActiveRalphWorktreeMode = typeof ACTIVE_RALPH_WORKTREE_MODES[number];

const RALPH_WORKTREE_MODE_SET: ReadonlySet<string> = new Set(RALPH_WORKTREE_MODES);
const ACTIVE_RALPH_WORKTREE_MODE_SET: ReadonlySet<string> = new Set(ACTIVE_RALPH_WORKTREE_MODES);

export function isRalphWorktreeMode(value: string): value is RalphWorktreeMode {
  return RALPH_WORKTREE_MODE_SET.has(value);
}

export function isActiveRalphWorktreeMode(value: string): value is ActiveRalphWorktreeMode {
  return ACTIVE_RALPH_WORKTREE_MODE_SET.has(value);
}

export function normalizeRalphWorktreeMode(value: unknown): RalphWorktreeMode {
  return typeof value === "string" && isRalphWorktreeMode(value)
    ? value
    : RALPH_WORKTREE_MODE.DISABLED;
}
