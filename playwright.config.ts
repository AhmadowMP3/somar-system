import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
const port = process.env.PORT ?? '8080';
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    ...devices['Pixel 7'],
    baseURL,
    locale: 'ar-SY',
    timezoneId: 'Asia/Damascus',
    channel: process.env.PW_CHANNEL || undefined,
    permissions: ['geolocation'],
    geolocation: { latitude: 36.2021, longitude: 37.1343, accuracy: 10 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node --env-file-if-exists=.env apps/api/dist/main.js',
        url: `${baseURL}/api/healthz`,
        reuseExistingServer: true,
        timeout: 60_000,
        // no external routing service during tests: route maps use straight lines between stops
        env: { DISABLE_CRON: 'true', ROUTING_URL: '' },
      },
});
