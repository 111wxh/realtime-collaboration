import { defineConfig, devices } from '@playwright/test';

/**
 * 多人协作 e2e：默认假设 web(3000) 与 api(3001) 已在运行。
 * 跑法：
 *   pnpm exec playwright install chromium
 *   pnpm exec playwright test
 * 被测栈：web 由 `pnpm --filter web dev`（或 next start）起，api 由 `pnpm --filter api start` 起，
 * postgres/redis 由 `docker compose up -d postgres redis` 起。
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 90_000,
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
