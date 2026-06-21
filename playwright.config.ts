import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the testing worktree.
 *
 * The frontend under test is expected to run at BASE_URL (default
 * http://localhost:3000). watch.ts re-runs these specs whenever the
 * backend/frontend worktrees change.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

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
