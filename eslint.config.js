import js from "@eslint/js";
import tseslint from "typescript-eslint";

const config = tseslint.config(
  { ignores: ["src/public-assets.ts", "public/**", "site/**", "sdk/**", "dist/**", "docs/**", "**/*.js"] },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);

// Preserve disabled rules and rule options; all enabled rules are report-only.
export default config.map((entry) => ({
  ...entry,
  ...(entry.rules && {
    rules: Object.fromEntries(Object.entries(entry.rules).map(([name, value]) => {
      const [severity, ...options] = Array.isArray(value) ? value : [value];
      return [name, [severity === "off" || severity === 0 ? "off" : "warn", ...options]];
    })),
  }),
}));
