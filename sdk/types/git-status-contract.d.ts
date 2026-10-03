/** Read-only project data. No paths, commands or Git mutations are accepted from widgets. */
export declare const MAX_GIT_STATUS_FILES = 200;
export declare const GIT_CHANGE_KINDS: readonly ["added", "modified", "deleted", "renamed", "copied", "type-changed", "unmerged", "untracked"];
export type GitChangeKind = typeof GIT_CHANGE_KINDS[number];
export interface GitFileChange {
    readonly path: string;
    readonly status: GitChangeKind;
    readonly previousPath?: string;
}
export type ProjectGitStatus = {
    readonly state: "not-repository";
} | {
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
export declare function parseProjectGitStatus(value: unknown): ProjectGitStatus;
