import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, refuseProduction, runId } from "./lib/env";

refuseProduction();
runId();

export default defineConfig({
  testDir: "./tests",
  // One worker, files in name order: the server limits joins per address, and scenarios share people and agents.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.E2E_HTML_REPORT === "1" ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalTeardown: "./lib/teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
