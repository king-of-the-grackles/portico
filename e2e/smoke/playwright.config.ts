import { defineConfig } from "@playwright/test";
import { BASE_URL, refuseProduction, runId } from "../lib/env";

refuseProduction();
runId();

// The recorded flows (e2e/smoke.sh). One at a time, no second try: a flow that fails leaves no video.
export default defineConfig({
  testDir: "./flows",
  testMatch: "*.flow.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "../test-results/smoke",
  // The browser suite's own cleanup: the run's Descope users, and the agents and Porticos its people made.
  globalTeardown: "../lib/teardown.ts",
  use: { baseURL: BASE_URL, browserName: "chromium" },
});
