import { minify } from "terser";
import minifier from "terser/package.json";
import project from "../package.json";

export const APP_MINIFIER_VERSION = minifier.version;

/** Second-stage app IIFE optimization only. Never used for fetched extension
 * modules or Ghostty's pinned distribution. No property/unsafe transforms. */
export async function minifyBrowserIife(source: string): Promise<string> {
  if (APP_MINIFIER_VERSION !== project.devDependencies.terser) throw new Error("app minifier version drift: use the exact locked development dependency");
  try {
    const result = await minify({ "app.bundle.js": source }, {
      ecma: 2020, module: false, toplevel: false,
      keep_classnames: true, keep_fnames: true,
      mangle: { properties: false, keep_classnames: true, keep_fnames: true },
      // keep_fnames alone does not preserve inferred arrow names when variable
      // reduction inlines their binding; retain that runtime observation too.
      compress: { passes: 1, pure_getters: false, unsafe: false, reduce_vars: false,
        drop_console: false, drop_debugger: false, keep_fargs: true },
      format: { comments: "some", ascii_only: false },
    });
    if (!result.code?.trim()) throw new Error("minifier emitted no app code");
    return result.code;
  } catch (error) {
    throw new Error(`app minification failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
