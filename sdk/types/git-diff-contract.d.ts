/**
 * Read-only project data. No paths, commands or Git mutations are accepted from widgets.
 * Upper bound for each section's JSON-serialized form, so the identity envelope fits `EXTENSION_PEER_LIMITS.project`.
 */
export declare const MAX_GIT_DIFF_SECTION_BYTES: number;
/** Serialized-JSON cap for the untracked section, smaller so all three sections fit `EXTENSION_PEER_LIMITS.project`. */
export declare const MAX_GIT_DIFF_UNTRACKED_BYTES: number;
/** Unified diffs of tracked files (`git diff --cached` and `git diff`) and of untracked files as new files. */
export type ProjectGitDiff = {
    readonly state: "not-repository";
} | {
    readonly state: "ready";
    readonly staged: string;
    readonly unstaged: string;
    /** `git diff --no-index` of each listed untracked file against /dev/null; absent from older hosts. */
    readonly untracked?: string;
    /** A section was cut to a prefix ending at a line boundary, or untracked files were skipped; never describe a truncated result as complete. */
    readonly truncated: boolean;
};
export declare const serializedDiffBytes: (section: string) => number;
/** Validate host JSON before handing it to trusted package code. */
export declare function parseProjectGitDiff(value: unknown): ProjectGitDiff;
