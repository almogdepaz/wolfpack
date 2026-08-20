import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const GUIDE_PATH = "docs/phone-pwa-notifications.md";
const CANONICAL_GUIDE_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/phone-pwa-notifications.md";

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("phone, PWA, and notifications guide", () => {
  test("documents trusted setup and platform-specific installation", () => {
    const guide = readRepoFile(GUIDE_PATH);

    for (const requirement of [
      "trusted Tailnet device",
      "verified Tailnet URL",
      "verified QR code",
      "same broker-owned session",
      "iPhone and iPad",
      "Safari",
      "Add to Home Screen",
      "Android",
      "Install app",
    ]) {
      expect(guide).toContain(requirement);
    }
  });

  test("distinguishes optional iOS browser use from installed-app Web Push", () => {
    const guide = readRepoFile(GUIDE_PATH);

    for (const requirement of [
      "Browser terminal use does not require installation",
      "iOS and iPadOS Web Push enrollment requires Add to Home Screen",
      "ordinary Safari tab cannot enroll for Web Push",
    ]) {
      expect(guide).toContain(requirement);
    }
  });

  test("documents notification enrollment, denied recovery, and per-origin scope", () => {
    const guide = readRepoFile(GUIDE_PATH);

    for (const requirement of [
      "Settings → Notifications",
      "denied",
      "browser or OS settings",
      "exact verified Wolfpack origin",
      "separate subscription",
      "does not migrate",
    ]) {
      expect(guide).toContain(requirement);
    }
  });

  test("states non-promises, shell-equivalent trust, and recovery routes", () => {
    const guide = readRepoFile(GUIDE_PATH);

    for (const requirement of [
      "shell-equivalent access",
      "PWA installation does not grant Tailnet access",
      "does not make Wolfpack public",
      "does not make Wolfpack offline-capable",
      "Cached shell UI or output is not live authority",
      "does not guarantee background notification delivery",
      "does not preserve a notification subscription when the origin changes",
      "stale",
      "offline",
      "reconnecting",
      "notification delivery fails",
      "[setup](./installation.md)",
      "[troubleshooting](./troubleshooting.md)",
      "[security and trust](./installation.md#security-and-trust)",
    ]) {
      expect(guide).toContain(requirement);
    }
  });

  test("routes the first-session phone checkpoint to the guide", () => {
    const firstSession = readRepoFile("docs/first-session.md");
    const checkpointIndex = firstSession.indexOf("*Phone checkpoint:");
    const guideLinkIndex = firstSession.indexOf(
      "[phone, PWA, and notifications guide](./phone-pwa-notifications.md)",
    );

    expect(checkpointIndex).toBeGreaterThan(-1);
    expect(guideLinkIndex).toBeGreaterThan(checkpointIndex);
  });

  test("uses one canonical runtime URL for the unconditional Settings help link", async () => {
    const { PHONE_PWA_NOTIFICATIONS_GUIDE_URL } = await import(
      "../../src/documentation-links.ts"
    );
    const html = readRepoFile("public/index.html");
    const app = readRepoFile("public/app.ts");
    const notificationBlock = html.match(
      /<div class="notification-setting">([\s\S]*?)<div id="notification-setting-status"/,
    )?.[1] ?? "";

    expect(PHONE_PWA_NOTIFICATIONS_GUIDE_URL).toBe(CANONICAL_GUIDE_URL);
    expect(notificationBlock).toContain('id="phone-pwa-notifications-guide-link"');
    expect(notificationBlock).toContain("Phone, PWA, and notification help");
    expect(app).toContain("PHONE_PWA_NOTIFICATIONS_GUIDE_URL");
    expect(app).not.toContain(CANONICAL_GUIDE_URL);
    expect(html).not.toContain(CANONICAL_GUIDE_URL);
    expect(app).toMatch(
      /phonePwaNotificationsGuideLink\.href\s*=\s*PHONE_PWA_NOTIFICATIONS_GUIDE_URL/,
    );
    expect(app).not.toMatch(
      /PHONE_PWA_NOTIFICATIONS_GUIDE_URL[\s\S]{0,200}(hostname|origin|userAgent|innerWidth|matchMedia|tailscale)/,
    );
  });
});
