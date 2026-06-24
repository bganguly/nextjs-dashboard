import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the merged dashboard app.
 *
 * The app under test is expected to run at BASE_URL. The merged dashboard
 * defaults to port 3004 to match npm run dev.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3004";

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
