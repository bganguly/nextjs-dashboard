import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for split dashboard development.
 *
 * The frontend under test is expected to run at BASE_URL. In split dev,
 * wt-frontend runs on 3003 and proxies API calls to wt-backend on 3004.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3003";

export default defineConfig({
  testDir: "./tests",
  // Each spec file is named *.spec.ts; notify.ts is a helper, not a test.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
