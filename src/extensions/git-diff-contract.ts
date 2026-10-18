/**
 * Read-only project data. No paths, commands or Git mutations are accepted from widgets.
 * Upper bound for each section's JSON-serialized form, so the identity envelope fits `EXTENSION_PEER_LIMITS.project`.
 */
export const MAX_GIT_DIFF_SECTION_BYTES = 96 * 1024;
/** Unified diffs of tracked files (`git diff --cached` and `git diff`); untracked files are not diffed. */
export type ProjectGitDiff = { readonly state: "not-repository" } | {
  readonly state: "ready";
  readonly staged: string;
  readonly unstaged: string;
  /** Either section is a bounded prefix ending at a line boundary; never describe a truncated result as complete. */
  readonly truncated: boolean;
};

export const serializedDiffBytes = (section: string) => new TextEncoder().encode(JSON.stringify(section)).byteLength;

/** Validate host JSON before handing it to trusted package code. */
export function parseProjectGitDiff(value: unknown): ProjectGitDiff {
  const fail = (): never => { throw new Error("invalid project Git diff"); };
  // Arrays and primitives carry no `state`, so property checks alone reject them.
  const object = value as { state?: unknown; staged?: unknown; unstaged?: unknown; truncated?: unknown } | null | undefined;
  if (object?.state === "not-repository") return Object.freeze({ state: "not-repository" });
  const section = (v: unknown): string => typeof v === "string" && serializedDiffBytes(v) <= MAX_GIT_DIFF_SECTION_BYTES ? v : fail();
  if (object?.state !== "ready" || typeof object.truncated !== "boolean") return fail();
  return Object.freeze({ state: "ready", staged: section(object.staged), unstaged: section(object.unstaged), truncated: object.truncated });
}
