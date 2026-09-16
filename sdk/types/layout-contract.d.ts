export declare const LAYOUT_CONTRACT_VERSION = 1;
export declare const MAX_LAYOUT_TRACKS = 12;
export declare const MAX_LAYOUT_PANES = 12;
export interface TerminalPaneReference {
    readonly id: string;
}
export interface LayoutTrack {
    readonly size: number;
}
export interface PanePlacement {
    readonly paneId: string;
    readonly row: number;
    readonly column: number;
    readonly rowSpan?: number;
    readonly columnSpan?: number;
}
export interface TerminalLayout {
    readonly version: typeof LAYOUT_CONTRACT_VERSION;
    readonly rows: readonly LayoutTrack[];
    readonly columns: readonly LayoutTrack[];
    readonly placements: readonly PanePlacement[];
}
export interface LayoutContext {
    readonly panes: readonly TerminalPaneReference[];
    readonly selectedPaneId: string | null;
    readonly viewport: Readonly<{
        width: number;
        height: number;
    }>;
}
export interface TerminalLayoutContribution {
    readonly id: string;
    readonly title: string;
    readonly arrange: (context: LayoutContext) => TerminalLayout;
}
export type LayoutValidationErrorCode = "TOO_MANY_PANES" | "EMPTY_TRACKS" | "TOO_MANY_TRACKS" | "INVALID_TRACK" | "UNKNOWN_PANE" | "DUPLICATE_PANE" | "MISSING_PANE" | "INVALID_PLACEMENT" | "OVERLAPPING_PLACEMENT";
export declare class LayoutValidationError extends Error {
    readonly code: LayoutValidationErrorCode;
    constructor(code: LayoutValidationErrorCode, message: string);
}
/** Geometry only; return detached known fields, never plugin-owned mutable objects. */
export declare function validateTerminalLayout(layout: unknown, panes: unknown): TerminalLayout;
export declare function equalGridLayout(input: LayoutContext): TerminalLayout;
export declare function leadStackLayout(input: LayoutContext): TerminalLayout;
export declare function verticalStackLayout(input: LayoutContext): TerminalLayout;
