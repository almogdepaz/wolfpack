import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.e2e.ts",
  outputDir: "tests/e2e/test-results",
  timeout: 30_000,
  retries: 0,
  workers: 1, // serial — shares one server instance
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${process.env.WOLFPACK_TEST_PORT || 18799}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone-se",
      use: {
        ...devices["iPhone SE"],
        // override to ensure consistency
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        defaultBrowserType: "chromium",
      },
    },
    {
      name: "iphone-14",
      use: {
        ...devices["iPhone 14"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        defaultBrowserType: "chromium",
      },
    },
    {
      name: "desktop",
      use: {
        viewport: { width: 1280, height: 720 },
        isMobile: false,
        hasTouch: false,
        defaultBrowserType: "chromium",
      },
    },
    {
      name: "mobile-webkit",
      testMatch: [
        "accessibility-navigation.e2e.ts",
        "delegation-sessions.e2e.ts",
        "mobile-accessory-enter.e2e.ts",
        "mobile-scrolling.e2e.ts",
        "notification-routing.e2e.ts",
        "reconnect.e2e.ts",
        "refresh-coordinator.e2e.ts",
        "session-switch.e2e.ts",
        "terminal.e2e.ts",
      ],
      grep: /clicking a session navigates|direct card drag|mobile card swipe opens|mobile drawer groups|mobile moved card opens|terminal receives output|mobile accessory Enter|mobile touch drag scrolls|notification session route|open session drawer|mobile keyboard uses ghostty native input|mobile keyboard viewport shift|mobile settings navigation|terminal transcript|visibility resume|WS disconnect shows reconnecting banner then recovers/,
      use: {
        ...devices["iPhone 14"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        defaultBrowserType: "webkit",
      },
    },
  ],
});
