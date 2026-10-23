import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Replit provides a wrapped Chromium with its required system libraries.
// Other machines use Playwright's normal installed browser unless overridden.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync('/repl/tools/bin/chromium') ? '/repl/tools/bin/chromium' : undefined);

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: 'list',
  outputDir: '../../../generated-artifacts/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    browserName: 'chromium',
    launchOptions: { executablePath },
    headless: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --config e2e/vite.config.ts',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  },
});
