/**
 * Read-only project data. No paths, commands or Git mutations are accepted from widgets.
 * Upper bound for each section's JSON-serialized form, so the identity envelope fits `EXTENSION_PEER_LIMITS.project`.
 */
export declare const MAX_GIT_DIFF_SECTION_BYTES: number;
/** Unified diffs of tracked files (`git diff --cached` and `git diff`); untracked files are not diffed. */
export type ProjectGitDiff = {
    readonly state: "not-repository";
} | {
    readonly state: "ready";
    readonly staged: string;
    readonly unstaged: string;
    /** Either section is a bounded prefix ending at a line boundary; never describe a truncated result as complete. */
    readonly truncated: boolean;
};
export declare const serializedDiffBytes: (section: string) => number;
/** Validate host JSON before handing it to trusted package code. */
export declare function parseProjectGitDiff(value: unknown): ProjectGitDiff;
