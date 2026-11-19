import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { accountGroupSchema, providerStatusSchema } from '@/lib/contract';
import { envSchema } from '@/lib/schemas';

/**
 * 真实模式冒烟（**默认跳过**）。
 *
 * 只在显式设置 `PANEL_REAL_SMOKE=1` 时运行：拉起 `node server/index.mjs --dev`，
 * 读真实 `router.mjs list/account --json` 与 doctor。全程只读，不执行写操作。
 *
 * 用途：把「内核 schema 对真实数据也成立」这件事验证一次（demo 数据覆盖不到
 * 真实 CLI 的字段组合，例如真实模式下 `gateway.reachable` 为 null）。
 */

const enabled = process.env.PANEL_REAL_SMOKE === '1';
const PORT = Number(process.env.PANEL_REAL_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | null = null;
let ready = false;

function killTree(proc: ChildProcess | null) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
}

async function waitForReady(timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 未就绪 */
    }
    await delay(300);
  }
  return false;
}

describe.skipIf(!enabled)('桥接契约（真实模式，只读）', () => {
  beforeAll(async () => {
    child = spawn(process.execPath, ['server/index.mjs', '--dev', '--port', String(PORT)], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    ready = await waitForReady();
  }, 30_000);

  afterAll(() => killTree(child));

  it('启动成功（能发现 router root）', () => {
    expect(ready).toBe(true);
  });

  it('/api/env 与 /api/providers 符合契约', async () => {
    if (!ready) return;
    const envRes = await fetch(`${BASE}/api/env`);
    const envBody = (await envRes.json()) as { ok: boolean; data: unknown };
    expect(envBody.ok).toBe(true);
    expect(envSchema.safeParse(envBody.data).success).toBe(true);

    const provRes = await fetch(`${BASE}/api/providers`);
    const provBody = (await provRes.json()) as { ok: boolean; data: unknown };
    expect(provBody.ok).toBe(true);
    expect(z.array(providerStatusSchema).safeParse(provBody.data).success).toBe(true);
  });

  it('/api/accounts 符合契约；/api/doctor 返回文本', async () => {
    if (!ready) return;
    const res = await fetch(`${BASE}/api/accounts`);
    const body = (await res.json()) as { ok: boolean; data: unknown };
    expect(body.ok).toBe(true);
    expect(z.array(accountGroupSchema).safeParse(body.data).success).toBe(true);

    const doc = await fetch(`${BASE}/api/doctor`);
    expect(doc.status).toBe(200);
    expect((doc.headers.get('content-type') ?? '').includes('text/plain')).toBe(true);
  });
});
