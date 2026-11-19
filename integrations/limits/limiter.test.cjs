const path = require('node:path');
const L = require(path.join('D:', 'router', 'integrations', 'limits', 'limiter.js'));
const assert = require('node:assert/strict');

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '\n   ', e.message);
    process.exitCode = 1;
  }
};
const ta = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '\n   ', e.message);
    process.exitCode = 1;
  }
};

t('预设档位存在且单调递增', () => {
  const s = L.PRESETS.safe, b = L.PRESETS.balanced, f = L.PRESETS.fast;
  assert.ok(s.concurrency <= b.concurrency && b.concurrency <= f.concurrency);
  assert.ok(s.rpm <= b.rpm && b.rpm <= f.rpm);
  assert.ok(s.minIntervalMs >= b.minIntervalMs && b.minIntervalMs >= f.minIntervalMs);
});

t('硬约束封顶：zcode 并发写 8 也只能是 1', () => {
  const cfg = { file: 'x', tier: 'fast', providers: { zcode: { concurrency: 8 } }, free: L.DEFAULT_FREE_LIMITS };
  assert.equal(L.resolveLimits('zcode', cfg).concurrency, 1);
});

t('硬约束封顶：codearts 最多 3', () => {
  const cfg = { file: 'x', tier: 'fast', providers: { codearts: { concurrency: 99 } }, free: L.DEFAULT_FREE_LIMITS };
  assert.equal(L.resolveLimits('codearts', cfg).concurrency, 3);
});

t('未登记的上游（免费供应商）走 free 档', () => {
  const cfg = { file: 'x', tier: 'fast', providers: {}, free: { concurrency: 3, rpm: 30, minIntervalMs: 1000, burst: 2, dailyCap: 0 } };
  const row = L.resolveLimits('some-cloud', cfg);
  assert.equal(row.tier, 'free');
  assert.equal(row.concurrency, 3);
  assert.equal(row.rpm, 30);
});

t('并发上限：第 3 个被挡，释放后可再进', () => {
  const lim = L.createLimiter({ concurrency: 2, rpm: 1000, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => 0 });
  const r1 = lim.tryAcquire();
  const r2 = lim.tryAcquire();
  assert.ok(r1 && r2);
  assert.equal(lim.tryAcquire(), null);
  r1();
  assert.ok(lim.tryAcquire());
  r2();
});

t('第一次请求不会被自己挡住（令牌桶初值满）', () => {
  const lim = L.createLimiter({ concurrency: 1, rpm: 100, minIntervalMs: 4000, burst: 1, dailyCap: 0 }, { now: () => 0 });
  assert.ok(lim.tryAcquire(), 't=0 的第一发必须放行');
});

t('rpm 滑动窗口：3 次后挡住，60 秒后恢复', () => {
  let now = 0;
  const lim = L.createLimiter({ concurrency: 10, rpm: 3, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => now });
  for (let i = 0; i < 3; i++) assert.ok(lim.tryAcquire(), `第 ${i + 1} 次应放行`);
  assert.equal(lim.tryAcquire(), null);
  assert.ok(lim.retryAfterMs() > 0);
  now = 60_001;
  assert.ok(lim.tryAcquire());
});

t('minInterval：桶空后按间隔补令牌', () => {
  let now = 0;
  const lim = L.createLimiter({ concurrency: 5, rpm: 100, minIntervalMs: 2000, burst: 1, dailyCap: 0 }, { now: () => now });
  const r = lim.tryAcquire();
  assert.ok(r, '第一发');
  r();
  assert.equal(lim.tryAcquire(), null, '2000ms 内第二发要挡');
  assert.ok(lim.retryAfterMs() > 1000);
  now = 2000;
  assert.ok(lim.tryAcquire(), '过一个间隔后补到令牌');
});

t('burst 允许短促并发（不是一律串行）', () => {
  let now = 0;
  const lim = L.createLimiter({ concurrency: 4, rpm: 100, minIntervalMs: 1000, burst: 3, dailyCap: 0 }, { now: () => now });
  assert.ok(lim.tryAcquire());
  assert.ok(lim.tryAcquire());
  assert.ok(lim.tryAcquire());
  assert.equal(lim.tryAcquire(), null, 'burst=3 之后要等补令牌');
});

t('dailyCap：用完即拒，且 retryAfter 给一天内的值', () => {
  let now = 0;
  const lim = L.createLimiter({ concurrency: 5, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 2 }, { now: () => now });
  lim.tryAcquire()();
  lim.tryAcquire()();
  assert.equal(lim.tryAcquire(), null);
  assert.equal(lim.snapshot().dayCount, 2);
});

t('dailyCap 跨日自动重置', () => {
  let now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const lim = L.createLimiter({ concurrency: 5, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 1 }, { now: () => now });
  lim.tryAcquire()();
  assert.equal(lim.tryAcquire(), null);
  now += 86_400_000;
  assert.ok(lim.tryAcquire(), '第二天应重置');
});

ta('acquire 在并发满时排队，release 后立刻放行', async () => {
  const lim = L.createLimiter({ concurrency: 1, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => 0 });
  const first = await lim.acquire();
  let second = false;
  const p = lim.acquire().then((rel) => {
    second = true;
    return rel;
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(second, false, '并发满时必须排队');
  assert.equal(lim.snapshot().queued, 1);
  first();
  const rel = await p;
  assert.equal(second, true);
  rel();
  assert.equal(lim.snapshot().inFlight, 0);
});

ta('acquire 支持 abort：排队中被取消不留泄漏', async () => {
  const lim = L.createLimiter({ concurrency: 1, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => 0 });
  const first = await lim.acquire();
  const ac = new AbortController();
  const p = lim.acquire({ signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(lim.snapshot().queued, 0);
  first();
  assert.equal(lim.snapshot().inFlight, 0);
});

ta('acquire 在 dailyCap 用尽时立刻抛 daily_cap', async () => {
  const lim = L.createLimiter({ concurrency: 5, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 1 }, { now: () => 0 });
  const r = await lim.acquire();
  r();
  await assert.rejects(lim.acquire(), (e) => e.name === 'LimiterBusy' && e.kind === 'daily_cap');
});

t('createLimiterFor 同进程复用同一实例', () => {
  const a = L.createLimiterFor('raccoon');
  const b = L.createLimiterFor('raccoon');
  assert.equal(a, b);
  const c = L.createLimiterFor('qoder-cn');
  assert.notEqual(a, c);
});

t('describeLimits 标明档位来源', () => {
  const cfg = { file: 'x', tier: 'balanced', providers: { raccoon: { tier: 'fast' } }, free: L.DEFAULT_FREE_LIMITS };
  const rows = L.describeLimits(['raccoon', 'qoder-cn', 'openrouter'], { cfg });
  assert.equal(rows[0].tierSource, 'override');
  assert.equal(rows[1].tierSource, 'provider-default');
  assert.equal(rows[2].tierSource, 'free');
});

console.log(`\n${pass} 项通过`);
