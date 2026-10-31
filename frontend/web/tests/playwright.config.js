import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.INTIME_TEST_PYTHON || path.join(root, ".venv", "Scripts", "python.exe");
const port = process.env.INTIME_TEST_PORT || "8766";
const artifacts = process.env.INTIME_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-frontend-qa");
export default defineConfig({
  testDir: ".", testMatch: ["dashboard.spec.js", "colors.spec.js", "fixes.spec.js", "controls.spec.js"], fullyParallel: false, workers: 1,
  timeout: 30000, expect: { timeout: 8000 },
  outputDir: path.join(artifacts, "results"), reporter: [["list"], ["json", { outputFile: path.join(artifacts, "e2e-results.json") }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 },
    timezoneId: "Europe/Moscow", locale: "ru-RU", trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: { channel: "chromium", executablePath: process.env.INTIME_BROWSER_PATH },
  },
  webServer: {
    command: `"${python}" tests/web/dashboard_server.py`, cwd: root,
    url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 30000,
    env: { RITM_NO_DOTENV: "1", RITM_LLM_API_KEY: "", INTIME_TEST_PORT: port },
  },
});
