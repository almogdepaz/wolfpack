import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import pkg from "../../package.json";

const README_PATH = "README.md";
const INSTALLATION_GUIDE_PATH = "docs/installation.md";
const SITE_PATH = "site/index.html";
const SITE_DEMO_PATH = "site/assets/wolfpack-usage-demo.gif";
const MOBILE_SCREENSHOTS = [
  "docs/mobile-sessions.png",
  "docs/mobile-terminal.png",
] as const;

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

  test("shows representative mobile UI captures after the interactive demo", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const demoPosition = readme.indexOf("docs/assets/wolfpack-usage-demo.gif");

    expect(demoPosition).toBeGreaterThan(-1);
    for (const screenshot of MOBILE_SCREENSHOTS) {
      expect(existsSync(screenshot)).toBe(true);
      expect(readme.indexOf(screenshot)).toBeGreaterThan(demoPosition);
    }
  });

  test("uses the interactive demo as the homepage's first product preview", () => {
    const site = readFileSync(SITE_PATH, "utf-8");
    const hero = site.match(/<div class="hero-visual">([\s\S]*?)<\/section>/)?.[1];

    expect(hero).toBeDefined();
    expect(existsSync(SITE_DEMO_PATH)).toBe(true);
    expect(hero?.match(/<img src="([^"]+)"/)?.[1]).toBe("assets/wolfpack-usage-demo.gif");
  });
});
