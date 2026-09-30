import type { LayoutContext, TerminalLayout } from "./layout-contract.ts";
import type { ProjectGitStatus } from "./git-status-contract.ts";
/** Public authoring surface. It deliberately exposes no terminal DOM, auth token, or server filesystem. */
export interface ContextViewController {
    dispose(): void;
    setVisible?(visible: boolean): void;
}
export declare const MAX_RETAINED_CONTEXT_VIEWS_PER_SCOPE = 32;
export interface ExtensionViewContext {
    readonly signal: AbortSignal;
    readonly scope: Readonly<{
        installationId: string;
        sessionId: string;
    }>;
    readonly selection: Readonly<{
        selectedSessionId: string | null;
    }>;
    readonly theme: Readonly<Record<string, string>>;
    readonly storage: Readonly<{
        get(key: string): string | null;
        set(key: string, value: string): void;
        remove(key: string): void;
    }>;
    /** Local live session's server-owned project. No caller-supplied path or command. */
    readonly project: Readonly<{
        gitStatus(signal?: AbortSignal): Promise<ProjectGitStatus>;
    }>;
    readonly documents: Readonly<{
        /** Resolves the current plain document, or null when this exact scope has none. */
        read(documentId: string): Promise<unknown | null>;
        /** Delivers (document, revision), including the current initial state. */
        subscribe(documentId: string, listener: (value: unknown | null, revision: number) => void): () => void;
    }>;
}
export interface ContextViewContribution {
    readonly id: string;
    readonly title: string;
    mount(container: HTMLElement, context: ExtensionViewContext): ContextViewController;
}
export interface ExtensionRegistrationHost {
    registerContextView(contribution: ContextViewContribution): void;
    registerTerminalLayout(contribution: {
        readonly id: string;
        readonly title: string;
        arrange(context: LayoutContext): TerminalLayout;
    }): void;
}
export type ExtensionRegistration = (host: ExtensionRegistrationHost) => void | (() => void);
/** Lifecycle contract enforced by the future host implementation.
 * Registration is scoped to one loaded bundle. Views lazy-mount once per scope;
 * visited views remain mounted-but-hidden up to MAX_RETAINED_CONTEXT_VIEWS_PER_SCOPE. Scope
 * changes abort then dispose old resources before a replacement mounts. Disable,
 * remove, and failed registration dispose exactly once. Late async work must
 * observe `signal`/scope generation and cannot repaint a replacement scope.
 */
export declare const EXTENSION_LIFECYCLE_RULES_VERSION = 1;
