import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8")) as Record<string, unknown>;

describe("app shell accessibility contracts", () => {
  test("exposes landmarks and an expanded-state session switcher", () => {
    expect(html).toContain('<main id="view-container">');
    expect(html).toContain('<nav id="desktop-sidebar"');
    expect(html).toContain('aria-controls="session-drawer"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("labels the session name without exposing an initial-task field", () => {
    expect(html).toContain('for="session-name-input"');
    expect(html).not.toContain('id="initial-task-input"');
    expect(html).not.toContain('id="initial-task-description"');
  });

  test("uses an in-app server folder view without native directory pickers", () => {
    expect(html).toContain('id="directory-browser-panel"');
    expect(html).toContain('id="directory-browser-selection-label"');
    expect(html).not.toContain('id="directory-browser-dialog"');
    expect(html).not.toContain('webkitdirectory');
  });

  test("loads the heavy terminal renderer lazily", () => {
    expect(html).not.toContain('<script defer src="/ghostty-web.bundle.js');
    expect(html).toContain('name="wolfpack-ghostty-src"');
  });

  test("keeps manifest and document theme colors consistent", () => {
    const theme = String(manifest.theme_color);
    expect(theme).toBe("#0a0a0a");
    expect(manifest.background_color).toBe(theme);
    expect(html).toContain(`<meta name="theme-color" content="${theme}"`);
  });

  test("makes drawers and dialogs available to assistive tech", () => {
    expect(html).toContain('id="session-drawer" aria-label="Switch session" aria-hidden="true" inert');
    expect(html).toContain('id="git-status-overlay" role="dialog" aria-modal="true"');
    expect(html).toContain('id="app-dialog" class="app-dialog" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"');
  });
});
