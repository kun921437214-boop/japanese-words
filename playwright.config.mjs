import { defineConfig } from '@playwright/test';

const useRoutedStaticBuild = process.env.E2E_ROUTE_STATIC === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: useRoutedStaticBuild ? 'http://app.test' : 'http://127.0.0.1:4174',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, ...(process.env.CI ? {} : { channel: 'chrome' }) }
    },
    {
      name: 'iphone-15-pro',
      use: { browserName: 'chromium', viewport: { width: 393, height: 852 }, isMobile: true, ...(process.env.CI ? {} : { channel: 'chrome' }) }
    },
    {
      name: 'iphone-16-pro',
      use: { browserName: 'chromium', viewport: { width: 402, height: 874 }, isMobile: true, ...(process.env.CI ? {} : { channel: 'chrome' }) }
    }
  ],
  webServer: useRoutedStaticBuild ? undefined : {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
