/** Read-only project data. No paths, commands or Git mutations are accepted from widgets. */
export const MAX_GIT_STATUS_FILES = 200;
export const GIT_CHANGE_KINDS = ["added", "modified", "deleted", "renamed", "copied", "type-changed", "unmerged", "untracked"] as const;
export type GitChangeKind = typeof GIT_CHANGE_KINDS[number];
export interface GitFileChange { readonly path: string; readonly status: GitChangeKind; readonly previousPath?: string; }
export type ProjectGitStatus = { readonly state: "not-repository" } | {
  readonly state: "ready";
  readonly branch: string | null;
  readonly detached: boolean;
  readonly staged: readonly GitFileChange[];
  readonly unstaged: readonly GitFileChange[];
  readonly untracked: readonly GitFileChange[];
  /** A bounded prefix only; never describe a truncated result as clean. */
  readonly truncated: boolean;
};

/** Validate host JSON before handing it to trusted package code. */
export function parseProjectGitStatus(value: unknown): ProjectGitStatus {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const fail = (): never => { throw new Error("invalid project Git status"); };
  if (!object(value)) return fail();
  if (value.state === "not-repository") return Object.freeze({ state: "not-repository" });
  if (value.state !== "ready" || !(value.branch === null || typeof value.branch === "string" && value.branch.length <= 1024) || typeof value.detached !== "boolean" || typeof value.truncated !== "boolean") return fail();
  const path = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0");
  const files = (v: unknown): readonly GitFileChange[] => {
    if (!Array.isArray(v) || v.length > MAX_GIT_STATUS_FILES) return fail();
    return Object.freeze(v.map(file => {
      if (!object(file) || !path(file.path) || !GIT_CHANGE_KINDS.includes(file.status as GitChangeKind) || file.previousPath !== undefined && !path(file.previousPath)) return fail();
      return Object.freeze({ path: file.path, status: file.status as GitChangeKind, ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath as string }) });
    }));
  };
  return Object.freeze({ state: "ready", branch: typeof value.branch === "string" ? value.branch : null, detached: value.detached, truncated: value.truncated, staged: files(value.staged), unstaged: files(value.unstaged), untracked: files(value.untracked) });
}
