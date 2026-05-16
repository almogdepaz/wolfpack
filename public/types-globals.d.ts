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
 * Plus a few `(window as any).foo = ...` writes scattered through app.ts
 * (debug surface, wasm-bundle handoff). Declare them here so the rest of
 * the code doesn't need ad-hoc casts.
 *
 * This file is `.d.ts` so it contributes types only; it never emits.
 */

// `WP` is the runtime surface bundled from src/wolfpack-client-lib.ts.
// Re-export through the type system so all `WP.foo` access stays accurate
// to the source of truth.
import type * as WolfpackClientLib from "../src/wolfpack-client-lib";

declare global {
  const WP: typeof WolfpackClientLib;

  // ghostty-web globals. The bundle ships untyped (it's loaded as a UMD
  // bundle attached to `window`), so we type them as `any` here. Refining
  // to the real ghostty-web types is a follow-up — see PLAN-typecheck-frontend.md.
  const Terminal: any;
  const FitAddon: any;

  interface Window {
    // ghostty-web handoff (set by /ghostty-web.bundle.js at load time)
    Terminal: any;
    FitAddon: any;
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
