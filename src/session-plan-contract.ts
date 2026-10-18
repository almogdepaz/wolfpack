/**
 * `--plan` launch contract shared by the CLI and the server routes that run the
 * child. The server resolves `path` against the selected project directory, so
 * a relative plan means the same file the child reads.
 */
export interface SessionPlanRequest {
  readonly path: string;
  readonly notifyParent?: true;
}

export const SESSION_PLAN_MAX_PATH_LENGTH = 4096;
export const PLAN_FILE_UNREADABLE = "PLAN_FILE_UNREADABLE";
export const PLAN_FILE_UNREADABLE_MESSAGE = "plan file not readable";

export const NOTIFY_PARENT_PROMPT = "when done or blocked, run `wolfpack agent notify-parent` once, then summarize changes, verification, and concerns.";

export function isSessionPlanRequest(value: unknown, allowNotifyParent: boolean): value is SessionPlanRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return Object.keys(plan).every(key => key === "path" || (allowNotifyParent && key === "notifyParent"))
    && typeof plan.path === "string"
    && plan.path.length > 0
    && plan.path.length <= SESSION_PLAN_MAX_PATH_LENGTH
    && !plan.path.includes("\0")
    && (plan.notifyParent === undefined || plan.notifyParent === true);
}

/** Compact startup prompt: points the child at the plan without copying it. */
export function compactPlanPrompt(planPath: string, notifyParent?: true): string {
  const base = `implement ${planPath}. read repo instructions and the full plan first; update plan status as work progresses. preserve unrelated dirty work. follow the plan's commit/push boundary; if it states none, do not commit, push, merge, or deploy. when done or blocked, leave this session open and summarize changes, verification, and concerns.`;
  return notifyParent ? `${base} ${NOTIFY_PARENT_PROMPT}` : base;
}
