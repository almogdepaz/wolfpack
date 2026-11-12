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
    // Plan 005: first 20 reports per rule found no defects for these rules.
    // Keep unsampled rules and no-async-promise-executor enabled at warn.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
      "no-empty": "off",
      "prefer-const": "off",
      "no-control-regex": "off",
      "no-unsafe-finally": "off",
      "no-empty-pattern": "off",
      "no-useless-escape": "off",
    },
  },
);

// Preserve disabled rules and rule options; base rules remain report-only.
export default [...config.map((entry) => ({
  ...entry,
  ...(entry.rules && {
    rules: Object.fromEntries(Object.entries(entry.rules).map(([name, value]) => {
      const [severity, ...options] = Array.isArray(value) ? value : [value];
      return [name, [severity === "off" || severity === 0 ? "off" : "warn", ...options]];
    })),
  }),
})), {
  files: ["src/**/*.ts"],
  rules: { "@typescript-eslint/no-floating-promises": "error" },
}];
