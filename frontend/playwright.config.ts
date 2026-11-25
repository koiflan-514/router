import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 使用**演示模式**桥接：不 spawn 真实进程、不读真实文件，页面仍走真实的
 * 生产代码路径（桥接托管 dist、注入 token、浏览器请求 /api/*）。
 */
const PORT = Number(process.env.PANEL_E2E_PORT ?? 8792);
const BASE = `http://127.0.0.1:${PORT}`;

/** PANEL_E2E_REAL=1 时对真实 CLI 跑只读 E2E（桥接仍只监听回环）。 */
const REAL = process.env.PANEL_E2E_REAL === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: REAL
      ? `node server/index.mjs --read-only --port ${PORT}`
      : `node server/index.mjs --demo --port ${PORT}`,
    url: `${BASE}/api/health`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
