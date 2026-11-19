const path = require('node:path');
const assert = require('node:assert/strict');
const L = require(path.join('D:', 'router', 'integrations', 'limits', 'limiter.js'));

let pass = 0;
async function ta(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '\n   ', e.message);
    process.exitCode = 1;
  }
}

async function main() {
  await ta('maxWaitMs：要等 60 秒时立刻拒，不挂住客户端', async () => {
    let now = 0;
    const lim = L.createLimiter({ concurrency: 5, rpm: 1, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => now });
    const r = lim.tryAcquire();
    r();
    await assert.rejects(lim.acquire({ maxWaitMs: 1000 }), (e) => {
      assert.equal(e.name, 'LimiterBusy');
      assert.ok(e.retryAfterMs >= 59_000, `retryAfter=${e.retryAfterMs}`);
      return true;
    });
  });

  await ta('maxWaitMs：等待在预算内则正常排队并放行', async () => {
    let now = 0;
    const lim = L.createLimiter({ concurrency: 1, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => now });
    const first = await lim.acquire({ maxWaitMs: 5000 });
    let done = false;
    const p = lim.acquire({ maxWaitMs: 5000 }).then((rel) => {
      done = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(done, false);
    first();
    const rel = await p;
    rel();
    assert.ok(done);
  });

  await ta('canStartNow 不消耗额度', async () => {
    let now = 0;
    const lim = L.createLimiter({ concurrency: 1, rpm: 100, minIntervalMs: 0, burst: 1, dailyCap: 0 }, { now: () => now });
    assert.equal(lim.canStartNow(), true);
    assert.equal(lim.canStartNow(), true, '探测不应把额度用掉');
    assert.equal(lim.snapshot().dayCount, 0);
    const r = await lim.acquire();
    assert.equal(lim.canStartNow(), false);
    r();
    assert.equal(lim.canStartNow(), true);
  });

  console.log(`\n${pass} 项通过`);
}

main();
