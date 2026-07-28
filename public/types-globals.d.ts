/**
 * Ambient global declarations for the browser bundle.
 *
 * The frontend loads several script tags that install globals on `window`
 * before `app.bundle.js` runs:
 *
 *   - `/ghostty-web.bundle.js` → `window.Terminal`, `window.FitAddon`
 *   - `/wolfpack-lib.js`       → `window.WP` (the surface re-exported from
 *                                 `src/wolfpack-client-lib.ts`)
 *
 * Plus a few window globals used by app.ts (debug surface, wasm-bundle
 * handoff). Declare them here so the rest of the code doesn't need ad-hoc
 * casts.
 *
 * This file is `.d.ts` so it contributes types only; it never emits.
 */

// `WP` is the runtime surface bundled from src/wolfpack-client-lib.ts.
// Re-export through the type system so all `WP.foo` access stays accurate
// to the source of truth.
import type * as WolfpackClientLib from "../src/wolfpack-client-lib";

declare global {
  interface GhosttyTerminal {
    readonly cols: number;
    readonly rows: number;
    readonly element?: HTMLElement;
    readonly textarea?: HTMLTextAreaElement;
    readonly renderer?: {
      getMetrics?: () => { readonly width: number; readonly height: number } | null;
      render?: (wasmTerm: unknown, forceAll: boolean, viewportY: unknown, scrollbackProvider: unknown) => void;
    };
    readonly options: { disableStdin: boolean; cursorBlink: boolean };
    readonly wasmTerm?: unknown;
    readonly viewportY?: unknown;
    loadAddon(addon: GhosttyFitAddon): void;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void;
    hasSelection(): boolean;
    getSelection(): string;
    onData(handler: (data: string) => void): void;
    onBinary?: (handler: (data: string) => void) => void;
    onResize(handler: (size: { readonly cols: number; readonly rows: number }) => void): void;
    open(element: HTMLElement): void;
    focus(): void;
    blur(): void;
    resize(cols: number, rows: number): void;
    scrollToBottom(): void;
    scrollToLine(line: number): void;
    scrollLines(amount: number): void;
    getMode(mode: number): boolean;
    getScrollbackLength?(): number;
    clear(): void;
    dispose(): void;
    write(data: Uint8Array | string): void;
  }

  interface GhosttyTerminalOptions {
    readonly cursorBlink: boolean;
    readonly disableStdin: boolean;
    readonly macOptionClickForcesSelection: boolean;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly fontFamily: string;
    readonly ghostty?: unknown;
    readonly theme: {
      readonly background: string;
      readonly foreground: string;
      readonly cursor: string;
      readonly selectionBackground: string;
      readonly black?: string;
      readonly red?: string;
      readonly green?: string;
      readonly yellow?: string;
      readonly blue?: string;
      readonly magenta?: string;
      readonly cyan?: string;
      readonly white?: string;
      readonly brightBlack?: string;
      readonly brightRed?: string;
      readonly brightGreen?: string;
      readonly brightYellow?: string;
      readonly brightBlue?: string;
      readonly brightMagenta?: string;
      readonly brightCyan?: string;
      readonly brightWhite?: string;
    };
    readonly scrollback: number;
  }

  interface GhosttyFitAddon {
    _terminal?: GhosttyTerminal;
    proposeDimensions?: () => { readonly cols: number; readonly rows: number } | undefined;
    fit(): void;
  }

  const WP: typeof WolfpackClientLib;

  // ghostty-web globals. The bundle ships untyped (it's loaded as a UMD
  // bundle attached to `window`), so this is the minimal structural surface
  // this frontend actually consumes.
  const Terminal: { new(options: GhosttyTerminalOptions): GhosttyTerminal };
  const FitAddon: { new(): GhosttyFitAddon };

  interface Window {
    // ghostty-web handoff (set by /ghostty-web.bundle.js at load time)
    Terminal: typeof Terminal;
    FitAddon: typeof FitAddon;
    WP: typeof WolfpackClientLib;

    // wasm-bundle bootstrap (set by /ghostty-web.bundle.js, signals readiness)
    ghosttyReady?: Promise<void>;
    wasmFailed?: boolean;
    /** Factory for per-Terminal WASM isolation; see public/app.ts:481 and
     *  scripts/bundle-ghostty.ts for context. */
    createIsolatedGhostty?: () => Promise<unknown>;
  }
}

export {};
