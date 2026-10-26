/**
 * Read-only project data. No paths, commands or Git mutations are accepted from widgets.
 * Upper bound for each section's JSON-serialized form, so the identity envelope fits `EXTENSION_PEER_LIMITS.project`.
 */
export const MAX_GIT_DIFF_SECTION_BYTES = 96 * 1024;
export const MAX_GIT_DIFF_UNTRACKED_BYTES = 48 * 1024;
/** Unified diffs of tracked files (`git diff --cached` and `git diff`) and of untracked files as new files. */
export type ProjectGitDiff = { readonly state: "not-repository" } | {
  readonly state: "ready";
  readonly staged: string;
  readonly unstaged: string;
  /** `git diff --no-index` of each listed untracked file against /dev/null; absent from older hosts. */
  readonly untracked?: string;
  /** A section was cut to a prefix ending at a line boundary, or untracked files were skipped; never describe a truncated result as complete. */
  readonly truncated: boolean;
};

export const serializedDiffBytes = (section: string) => new TextEncoder().encode(JSON.stringify(section)).byteLength;

/** Validate host JSON before handing it to trusted package code. */
export function parseProjectGitDiff(value: unknown): ProjectGitDiff {
  const fail = (): never => { throw new Error("invalid project Git diff"); };
  // Arrays and primitives carry no `state`, so property checks alone reject them.
  const object = value as { state?: unknown; staged?: unknown; unstaged?: unknown; untracked?: unknown; truncated?: unknown } | null | undefined;
  if (object?.state === "not-repository") return Object.freeze({ state: "not-repository" });
  const section = (v: unknown, cap = MAX_GIT_DIFF_SECTION_BYTES): string => typeof v === "string" && serializedDiffBytes(v) <= cap ? v : fail();
  if (object?.state !== "ready" || typeof object.truncated !== "boolean") return fail();
  const untracked = object.untracked === undefined ? {} : { untracked: section(object.untracked, MAX_GIT_DIFF_UNTRACKED_BYTES) };
  return Object.freeze({ state: "ready", staged: section(object.staged), unstaged: section(object.unstaged), ...untracked, truncated: object.truncated });
}
