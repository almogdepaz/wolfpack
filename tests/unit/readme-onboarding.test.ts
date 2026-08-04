import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import pkg from "../../package.json";

const README_PATH = "README.md";
const INSTALLATION_GUIDE_PATH = "docs/installation.md";

describe("README onboarding", () => {
  test("gives curl, Bunx, and npm users executable diagnosis and uninstall commands", () => {
    const readme = readFileSync(README_PATH, "utf-8");

    expect(readme).toStartWith("# Wolfpack — browser terminal manager for AI coding agents");

    for (const command of [
      "curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash",
      "bunx wolfpack-bridge@latest",
      "npx --yes wolfpack-bridge@latest",
      "wolfpack doctor",
      "wolfpack uninstall --yes",
      "bunx wolfpack-bridge@latest doctor",
      "bunx wolfpack-bridge@latest uninstall --yes",
      "npx --yes wolfpack-bridge@latest doctor",
      "npx --yes wolfpack-bridge@latest uninstall --yes",
    ]) expect(readme).toContain(command);
  });

  test("links a packaged installation guide instead of embedding platform detail", () => {
    expect(existsSync(INSTALLATION_GUIDE_PATH)).toBe(true);
    expect(pkg.files).toContain(INSTALLATION_GUIDE_PATH);

    const readme = readFileSync(README_PATH, "utf-8");
    expect(readme).toContain(INSTALLATION_GUIDE_PATH);
  });
});
