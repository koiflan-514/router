import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

/**
 * 三档响应式：375 / 768 / 1440。
 * 每档对关键页面截图（存档在 frontend/test-results/screenshots/），
 * 并断言 document / body / #main 都没有横向滚动。
 */

const SHOTS: Array<{ path: string; title: string; slug: string }> = [
  { path: '/', title: '总览', slug: 'overview' },
  { path: '/usage', title: '用量', slug: 'usage' },
  { path: '/quota', title: '额度', slug: 'quota' },
  { path: '/reports', title: '报表', slug: 'reports' },
  { path: '/gateway', title: '调度快照', slug: 'gateway-scheduler' },
  { path: '/gateway/usage', title: '网关用量', slug: 'gateway-usage' },
  { path: '/gateway/combos', title: '降级链', slug: 'gateway-combos' },
  { path: '/gateway/keys', title: '密钥', slug: 'gateway-keys' },
];

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1000 },
  { width: 1440, height: 900 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`响应式 ${viewport.width}px`, () => {
    test.use({ viewport });

    test('关键页面无横向溢出并截图存档', async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      const outDir = path.resolve(process.cwd(), 'test-results/screenshots');
      await mkdir(outDir, { recursive: true });

      for (const shot of SHOTS) {
        await page.goto(shot.path);
        await expect(page.getByRole('heading', { level: 1, name: shot.title })).toBeVisible();
        await expect(page.locator('#main')).toBeVisible();
        await page.waitForTimeout(350);

        const overflow = await page.evaluate(() => {
          const de = document.documentElement;
          const main = document.querySelector('#main') as HTMLElement | null;
          const body = document.body;
          return {
            document: de.scrollWidth - de.clientWidth,
            body: body.scrollWidth - body.clientWidth,
            main: main ? main.scrollWidth - main.clientWidth : 0,
          };
        });
        expect(
          overflow.document,
          `${viewport.width}px ${shot.path} document 横向溢出：${JSON.stringify(overflow)}`,
        ).toBeLessThanOrEqual(1);
        expect(
          overflow.body,
          `${viewport.width}px ${shot.path} body 横向溢出：${JSON.stringify(overflow)}`,
        ).toBeLessThanOrEqual(1);
        expect(
          overflow.main,
          `${viewport.width}px ${shot.path} #main 横向溢出：${JSON.stringify(overflow)}`,
        ).toBeLessThanOrEqual(1);

        await page.screenshot({
          path: path.join(outDir, `${viewport.width}-${shot.slug}.png`),
          fullPage: false,
          animations: 'disabled',
        });
        await testInfo.attach(`${viewport.width}-${shot.slug}`, {
          path: path.join(outDir, `${viewport.width}-${shot.slug}.png`),
          contentType: 'image/png',
        });
      }
    });
  });
}