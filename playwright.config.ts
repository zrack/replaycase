import { defineConfig, devices } from "@playwright/test";

const inCi = process.env.CI === "true";
const externallyManagedBaseUrl =
  process.env.REPLAYCASE_E2E_BASE_URL?.trim() || process.env.NARROWSLINK_E2E_BASE_URL?.trim() || null;
const configuredPort = Number(process.env.REPLAYCASE_E2E_PORT ?? process.env.NARROWSLINK_E2E_PORT ?? "4173");
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("REPLAYCASE_E2E_PORT must be an integer between 1 and 65535.");
}
const baseUrl = externallyManagedBaseUrl ?? `http://127.0.0.1:${configuredPort}`;

if (externallyManagedBaseUrl) {
  const parsed = new URL(externallyManagedBaseUrl);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      "REPLAYCASE_E2E_BASE_URL must be an HTTP origin on 127.0.0.1.",
    );
  }
}

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: inCi,
  retries: inCi ? 1 : 0,
  failOnFlakyTests: inCi,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: inCi
    ? [["line"], ["html", { outputFolder: "output/playwright/report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: baseUrl,
    acceptDownloads: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: externallyManagedBaseUrl
    ? undefined
    : {
        command: `npm run preview -- --host 127.0.0.1 --port ${configuredPort} --strictPort`,
        url: baseUrl,
        reuseExistingServer: false,
        timeout: 30_000,
      },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
