import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.AIVRITM_MOBILE_PORT || "8791";
export default defineConfig({
  testDir: ".",
  testMatch: ["mobile.spec.js", "mobile-ai.spec.js", "mobile-repair.spec.js"],
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 8000 },
  outputDir: path.join(root, "../artifacts/mobile-qa/results"),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/Moscow",
    locale: "ru-RU",
    launchOptions: { executablePath: process.env.AIVRITM_BROWSER_PATH || "/opt/google/chrome/chrome" },
  },
  webServer: {
    command: `node tests/mobile-harness.mjs`,
    cwd: path.join(root, ".."),
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 20000,
    env: { AIVRITM_MOBILE_PORT: port },
  },
});
