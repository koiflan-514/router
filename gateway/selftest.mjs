#!/usr/bin/env node
/**
 * 网关自测：不依赖任何反代在跑，也不消耗额度。
 *
 *   node gateway/selftest.mjs
 *
 * 覆盖三块最容易出错、且出错后最难发现的东西：
 *   1. 协议转换（Anthropic ⇄ OpenAI，含工具调用与 thinking）
 *   2. SSE 分块边界（半帧、CRLF、注释心跳）
 *   3. 调度器（权重、粘性、冷却只增不减、退避上限）
 *
 * 用 node:assert 而不是测试框架：本仓库没有 devDependencies，加框架会让
 * 「clone 下来就能跑」这件事失效。
 */

import assert from 'node:assert/strict';
import {
  messagesToChat,
  openaiSseToAnthropicEvents,
  collectOpenaiSse,
  collectAnthropicSse,
  renderAnthropic,
  renderChat,
  normalizeOpenaiJson,
  normalizeAnthropicJson,
} from './protocol.mjs';
import { sseEvents, sniffBody } from './sse.mjs';
import { createScheduler, sessionKeyOf } from './scheduler.mjs';
import { estimateRequest, estimateText } from './tokens.mjs';
import { splitModel } from './route.mjs';
import { ipAllowed, modelAllowed, hashSecret, generateSecret } from './keys.mjs';
import { classify } from './server.mjs';
import { classifyFailure, shouldRotate } from './failure.mjs';
import { repairToolPairing } from './pairing.mjs';
import { tryOptimizations, extractFilepathsFromCommand } from './local-answer.mjs';
import { normalizeCombos, chainFor, chainCapacity, canFallbackAfter, comboId } from './combo.mjs';
import { matchCombo } from './route.mjs';
import { FREE_PROVIDERS } from './free-providers.mjs';
import { gatewayPiProvider, freePiProvider } from '../scripts/lib/pi-sync.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`\x1b[1;32m✓\x1b[0m ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`\x1b[1;31m✗\x1b[0m ${name}\n    ${err.message}\n`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`\x1b[1;32m✓\x1b[0m ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`\x1b[1;31m✗\x1b[0m ${name}\n    ${err.message}\n`);
  }
}

/** 把字符串切成指定大小的块，模拟网络分片。 */
function* chunked(text, size) {
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function collect(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ---------------------------------------------------------------- SSE

await testAsync('sse: 半帧跨分块', async () => {
  const text = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  const frames = await collect(sseEvents(chunked(text, 3)));
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[0].data), { a: 1 });
  assert.deepEqual(JSON.parse(frames[1].data), { b: 2 });
});

await testAsync('sse: CRLF 与注释心跳', async () => {
  const text = ': ping\r\n\r\nevent: message_start\r\ndata: {"type":"message_start"}\r\n\r\n';
  const frames = await collect(sseEvents(chunked(text, 5)));
  assert.equal(frames.length, 1, '心跳不该产出帧');
  assert.equal(frames[0].event, 'message_start');
  assert.equal(JSON.parse(frames[0].data).type, 'message_start');
});

await testAsync('sse: 末尾没有空行也要收尾', async () => {
  const frames = await collect(sseEvents(chunked('data: {"x":1}', 4)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '{"x":1}');
});

// ---------------------------------------------------------------- 请求方向

test('protocol: system + 图片 + tool_result 的映射', () => {
  const chat = messagesToChat({
    system: '你是助手',
    max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
  });
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[0].content, '你是助手');
  const userParts = chat.messages[1].content;
  assert.ok(Array.isArray(userParts));
  assert.equal(userParts[1].type, 'image_url');
  assert.ok(userParts[1].image_url.url.startsWith('data:image/png;base64,'));
  const assistant = chat.messages[2];
  assert.equal(assistant.tool_calls[0].function.name, 'read');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"p":"a"}');
  // tool_result 必须变成独立的 tool 角色消息，不能混在 user parts 里
  assert.equal(chat.messages[3].role, 'tool');
  assert.equal(chat.messages[3].tool_call_id, 't1');
});

test('protocol: 未知内容块必须报错而不是静默丢弃', () => {
  assert.throws(
    () => messagesToChat({ messages: [{ role: 'user', content: [{ type: 'document' }] }] }),
    /document/,
  );
});

test('protocol: 纯文本用字符串而不是 parts 数组', () => {
  const chat = messagesToChat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] });
  assert.equal(chat.messages[0].content, 'ab');
});

// ---------------------------------------------------------------- 响应方向

await testAsync('protocol: OpenAI 流 → Anthropic 事件（文本 + 工具）', async () => {
  const sse = [
    'data: {"id":"c1","choices":[{"delta":{"role":"assistant","content":"你"}}]}',
    'data: {"id":"c1","choices":[{"delta":{"content":"好"}}]}',
    'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"p\\""}}]}}]}',
    'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
    'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const events = await collect(
    openaiSseToAnthropicEvents(sseEvents(chunked(sse, 7)), 'm'),
  );
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'message_start');
  assert.equal(types.at(-1), 'message_stop');
  // 文本块必须先 stop，才能开工具块（Anthropic 不允许同一 index 并行两种 delta）
  const textStart = events.findIndex((e) => e.type === 'content_block_start' && e.content_block.type === 'text');
  const textStop = events.findIndex((e) => e.type === 'content_block_stop' && e.index === events[textStart].index);
  const toolStart = events.findIndex((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  assert.ok(textStop > textStart && toolStart > textStop, `文本块未在工具块前收尾：${types.join(',')}`);
  const delta = events.find((e) => e.type === 'message_delta');
  assert.equal(delta.delta.stop_reason, 'tool_use');
  assert.equal(delta.usage.output_tokens, 5);
});

await testAsync('protocol: OpenAI 流里的 error 帧要变成 Anthropic error 事件', async () => {
  const sse = 'data: {"error":{"message":"10605 isQueued"}}\n\n';
  const events = await collect(openaiSseToAnthropicEvents(sseEvents(chunked(sse, 9)), 'm'));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].error.message, /isQueued/);
});

await testAsync('protocol: 上游无视 stream:false 回 SSE 时能聚合', async () => {
  const sse = [
    'data: {"id":"c1","choices":[{"delta":{"content":"你"}}]}',
    'data: {"id":"c1","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const acc = await collectOpenaiSse(sseEvents(chunked(sse, 11)), 'm');
  assert.equal(acc.text, '你好');
  assert.equal(acc.finish, 'stop');
  const msg = renderAnthropic(acc, 'm');
  assert.equal(msg.content[0].text, '你好');
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.usage.output_tokens, 2);
});

await testAsync('protocol: Anthropic 流 → 聚合 → OpenAI JSON', async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":7}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"嗨"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n');
  const acc = await collectAnthropicSse(sseEvents(chunked(sse, 13)), 'm');
  const chat = renderChat(acc, 'm');
  assert.equal(chat.choices[0].message.content, '嗨');
  assert.equal(chat.choices[0].finish_reason, 'stop');
  assert.equal(chat.usage.prompt_tokens, 7);
  assert.equal(chat.usage.completion_tokens, 1);
});

test('protocol: 完整 JSON 双向归一化', () => {
  const openai = normalizeOpenaiJson(
    {
      id: 'c9',
      choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 't', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    },
    'm',
  );
  const anth = renderAnthropic(openai, 'm');
  assert.equal(anth.stop_reason, 'tool_use');
  assert.deepEqual(anth.content[1].input, { a: 1 });

  const back = normalizeAnthropicJson(anth, 'm');
  const chat = renderChat(back, 'm');
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'f');
});

// ---------------------------------------------------------------- 调度器

function sched(opts = {}) {
  return createScheduler({
    ids: ['a', 'b', 'c'],
    settings: { topN: 3, maxAttempts: 3, ...(opts.settings || {}) },
    rng: opts.rng || (() => 0.5),
    now: opts.now || (() => 1000),
    weights: opts.weights || {},
    quota: opts.quota || null,
    // 默认关掉本地限流：调度测试用固定 now，限流器的时间窗会干扰它。
    // 要测限流本身的用例显式传 limits。
    limits: opts.limits === undefined ? false : opts.limits,
  });
}

test('scheduler: 权重为 0 的供应商被硬过滤', () => {
  const s = sched({ weights: { b: 0 } });
  for (let i = 0; i < 20; i++) assert.notEqual(s.pick().id, 'b');
});

test('scheduler: 额度耗尽的权重会掉下来', () => {
  const s = sched({ quota: { at: 1000, pools: { a: { ratio: 0 }, b: { ratio: 1 } } } });
  const w = Object.fromEntries(s.snapshot().map((x) => [x.id, x.weight]));
  assert.ok(w.b > w.a, `b(${w.b}) 应高于 a(${w.a})`);
});

test('scheduler: 过期额度快照不参与权重', () => {
  const s = sched({ now: () => 10 * 3600_000, quota: { at: 0, pools: { a: { ratio: 0 } } } });
  const row = s.snapshot().find((x) => x.id === 'a');
  assert.equal(row.quotaRatio, null);
});

test('scheduler: 冷却只增不减', () => {
  const s = sched({ settings: { breakerThreshold: 2, serverCooldownMs: 60_000, breakerCooldownMs: 100_000, breakerCapMs: 900_000 } });
  const acc = s.get('a');
  s.onUpstreamError(acc, { kind: 'server' }); // 60s
  const first = acc.cooldownUntil;
  s.onUpstreamError(acc, { kind: 'client' }); // 0s，不能把 60s 抹掉
  assert.equal(acc.cooldownUntil, first);
});

test('scheduler: 退避有上限（上限只约束退避本身，基础冷却仍生效）', () => {
  const s = sched({ settings: { breakerThreshold: 1, serverCooldownMs: 1000, breakerCooldownMs: 1000, breakerCapMs: 5000 } });
  const acc = s.get('a');
  for (let i = 0; i < 20; i++) s.onUpstreamError(acc, { kind: 'server' });
  const total = acc.cooldownUntil - 1000;
  // 取 max(基础冷却, 退避)，所以总时长上限是两者较大者，绝不会随失败次数无限增长
  assert.ok(total <= 5000, `退避超上限：${total}`);
  assert.ok(total >= 1000, `退避被抹掉了：${total}`);
});

test('scheduler: 本地限额把 maxInFlight 压到上游允许的并发', () => {
  const s = createScheduler({
    ids: ['zcode', 'raccoon'],
    settings: { topN: 2, maxInFlight: 8 },
    limits: { file: 'x', tier: 'fast', providers: {}, free: {} },
    now: () => 1000,
  });
  // zcode 的硬约束是 1（计划通道串行），raccoon 是 balanced 的 2
  assert.equal(s.concurrencyOf('zcode'), 1);
  assert.equal(s.concurrencyOf('raccoon'), 2);
});

test('scheduler: 本地限流挡住时 pick 会去挑别家', () => {
  let t = 1000;
  const s = createScheduler({
    ids: ['zcode', 'raccoon'],
    settings: { topN: 2, maxInFlight: 8 },
    limits: { file: 'x', tier: 'balanced', providers: {}, free: {} },
    now: () => t,
    rng: () => 0,
  });
  // 占满 zcode 的唯一执行位
  const rel = s.limiterFor('zcode').tryAcquire();
  assert.ok(rel);
  assert.equal(s.limiterFor('zcode').canStartNow(), false);
  for (let i = 0; i < 10; i++) {
    const picked = s.pick();
    assert.notEqual(picked?.id, 'zcode', 'zcode 已被本地限流挡住，不该再被选中');
  }
  rel();
  // 释放只归还并发位，令牌桶仍要等一个补发间隔（safe 档 4 秒）
  t += 4000;
  assert.equal(s.limiterFor('zcode').canStartNow(), true);
  assert.equal(s.snapshot().find((r) => r.id === 'zcode').limit.throttled, false);
});

test('scheduler: 本地限流档位出现在 status 快照里', () => {
  const s = createScheduler({
    ids: ['zcode'],
    settings: { maxInFlight: 8 },
    limits: { file: 'x', tier: 'balanced', providers: { zcode: { tier: 'fast' } }, free: {} },
    now: () => 1000,
  });
  const row = s.snapshot().find((r) => r.id === 'zcode');
  assert.equal(row.limit.tier, 'fast', '用户覆盖的档位要如实反映');
  assert.equal(row.limit.concurrency, 1, '但仍受硬约束封顶');
  assert.equal(row.limit.effectiveConcurrency, 1);
  assert.equal(row.limit.throttled, false);
});

test('scheduler: 粘性会话续期并受冷却约束', () => {
  let t = 1000;
  const s = createScheduler({
    ids: ['a', 'b'],
    settings: { topN: 2, stickyTtlMs: 1000, serverCooldownMs: 10_000 },
    now: () => t,
    rng: () => 0,
  });
  const acc = s.get('b');
  s.stickySet('k', acc);
  assert.equal(s.stickyGet('k', { readyOnly: true }).id, 'b');
  t += 500;
  assert.equal(s.stickyGet('k', { readyOnly: true }).id, 'b', '命中应续期');
  s.onUpstreamError(acc, { kind: 'server' });
  assert.equal(s.stickyGet('k', { readyOnly: true }), null, '冷却中不该返回');
  assert.equal(s.stickyGet('k'), acc, '非 readyOnly 仍可取到');
  t += 2000;
  assert.equal(s.stickyGet('k'), null, '过期应清除');
});

test('scheduler: exclude 内的供应商绝不重试', () => {
  const s = sched({ settings: { topN: 3 } });
  const exclude = new Set(['a', 'b']);
  for (let i = 0; i < 10; i++) assert.equal(s.pick({ exclude }).id, 'c');
});

test('scheduler: 全在冷却时挑最早恢复的那家', () => {
  let t = 1000;
  const s = createScheduler({
    ids: ['a', 'b'],
    settings: { topN: 2, serverCooldownMs: 10_000 },
    now: () => t,
  });
  s.onUpstreamError(s.get('a'), { kind: 'server' });
  t += 1000;
  s.onUpstreamError(s.get('b'), { kind: 'server' });
  assert.equal(s.pick().id, 'a', 'a 更早恢复');
});

test('scheduler: 会话 key 混入密钥 id，且无来源时不启用粘性', () => {
  const k1 = sessionKeyOf({ req: { headers: { 'x-session-id': 's' } }, keyId: 'k1' });
  const k2 = sessionKeyOf({ req: { headers: { 'x-session-id': 's' } }, keyId: 'k2' });
  assert.notEqual(k1, k2);
  assert.equal(sessionKeyOf({ req: { headers: {} }, body: { messages: [] } }), null);
  const same = sessionKeyOf({ req: { headers: {} }, body: { messages: [{ role: 'user', content: 'hi' }] }, keyId: 'k' });
  const same2 = sessionKeyOf({ req: { headers: {} }, body: { messages: [{ role: 'user', content: 'hi' }] }, keyId: 'k' });
  assert.equal(same, same2, '同一 prompt 必须稳定');
});

// ---------------------------------------------------------------- 其他

test('scheduler: ordered 模式严格按候选顺序，忽略权重', () => {
  // c 权重最高，但显式指定了 a → 必须给 a
  const s = createScheduler({
    ids: ['a', 'b', 'c'],
    weights: { c: 20, a: 1 },
    quota: { at: 1000, pools: { c: { ratio: 1 }, a: { ratio: 0 } } },
    settings: { topN: 3 },
    now: () => 1000,
    // 固定随机源：加权分支是随机的，测试必须确定
    rng: () => 0,
  });
  assert.equal(s.pick({ prefer: ['a', 'b'], ordered: true }).id, 'a');
  // 不 ordered 时权重说了算（b 的权重 50 > a 的 5）
  assert.equal(s.pick({ prefer: ['a', 'b'] }).id, 'b');
});

test('scheduler: ordered 模式下冷却会顺延到下一个候选', () => {
  const s = createScheduler({
    ids: ['a', 'b'],
    settings: { topN: 2, serverCooldownMs: 10_000 },
    now: () => 1000,
  });
  s.onUpstreamError(s.get('a'), { kind: 'server' });
  assert.equal(s.pick({ prefer: ['a', 'b'], ordered: true }).id, 'b');
});

test('scheduler: ordered + prefer 只含首选时不会溢出到候选之外', () => {
  const s = createScheduler({
    ids: ['a', 'b', 'c'],
    settings: { topN: 3 },
    now: () => 1000,
  });
  // 模拟 pinned：candidates = ['a']，b/c 不该被选中
  for (let i = 0; i < 10; i++) assert.equal(s.pick({ prefer: ['a'], ordered: true }).id, 'a');
});

test('tokens: 中文比英文更密', () => {
  assert.ok(estimateText('你好世界') > estimateText('abcd'));
  assert.ok(estimateRequest({ messages: [{ role: 'user', content: 'hi' }] }) >= 1);
});

test('route: 只按第一个 / 切分', () => {
  assert.deepEqual(splitModel('trae-local/qwen/qwen3'), { provider: 'trae-local', model: 'qwen/qwen3' });
  assert.deepEqual(splitModel('glm-5.3'), { provider: null, model: 'glm-5.3' });
  assert.throws(() => splitModel(''), /不能为空/);
});

test('keys: 前缀与哈希稳定', () => {
  const s = generateSecret();
  assert.ok(s.startsWith('zsk_'));
  assert.equal(hashSecret(s), hashSecret(s));
  assert.notEqual(hashSecret(s), hashSecret(`${s}x`));
});

test('keys: IP 白名单支持 CIDR', () => {
  assert.equal(ipAllowed('127.0.0.1', []), true);
  assert.equal(ipAllowed('10.0.0.5', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('11.0.0.5', ['10.0.0.0/8']), false);
});

test('keys: 模型白名单支持通配', () => {
  assert.equal(modelAllowed('glm-5.3', []), true);
  assert.equal(modelAllowed('glm-5.3', ['glm-*']), true);
  assert.equal(modelAllowed('gpt-5', ['glm-*']), false);
  assert.equal(modelAllowed('任意', ['*']), true);
});

test('classify: 402 归额度、429 归限流、401 归鉴权', () => {
  assert.equal(classify(402, '').kind, 'quota');
  assert.equal(classify(429, '').kind, 'rate_limit');
  assert.equal(classify(401, '').kind, 'auth');
  assert.equal(classify(500, '').kind, 'server');
  // 上游把额度错误放在 200/400 的 body 里 —— 新分类器比旧实现强的地方
  assert.equal(classify(400, '{"error":"exceed quota limit"}').kind, 'rate_limit');
  assert.equal(classify(200, '{"code":1005,"msg":"exceed quota limit"}').kind, 'rate_limit');
});

test('classify: 上下文溢出归 client 且不换家', () => {
  const v = classify(400, '{"error":"maximum context length is 128000"}');
  assert.equal(v.kind, 'client');
  assert.equal(v.verdict.kind, 'context_window');
  assert.equal(v.verdict.retryable, false);
  assert.equal(shouldRotate(v.verdict), false);
});

test('classify: 中文额度文案', () => {
  assert.equal(classify(400, '{"error":"额度不足，请充值"}').kind, 'quota');
});

test('failure: 退避单调且封顶', () => {
  let prev = 0;
  for (let level = 0; level < 20; level++) {
    const v = classifyFailure({ status: 429, level });
    assert.ok(v.cooldownMs >= prev, `level ${level} 冷却回退了`);
    assert.ok(v.cooldownMs <= 300_000, `level ${level} 超过上限`);
    prev = v.cooldownMs;
  }
});

test('failure: 上游报的 reset 会被封顶到 30 分钟', () => {
  const v = classifyFailure({ status: 429, retryAfterMs: 4 * 3600_000 });
  assert.equal(v.cooldownMs, 30 * 60_000);
});

test('pairing: 丢掉没有结果的调用（文本保留）', () => {
  const repaired = repairToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }] },
  ]);
  assert.equal(repaired.length, 2);
  assert.equal(repaired[1].content.filter((b) => b.type === 'tool_use').length, 0);
  assert.equal(repaired[1].content.filter((b) => b.type === 'text').length, 1);
});

test('pairing: 丢掉没有调用的结果', () => {
  const repaired = repairToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
  ]);
  assert.equal(repaired.length, 1);
});

test('pairing: 完整的配对原样保留', () => {
  const input = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  assert.equal(repairToolPairing(input).length, 3);
});

test('pairing: 无名的调用要丢掉', () => {
  const repaired = repairToolPairing([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: '', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: unknown tool ""' }] },
  ]);
  assert.equal(repaired.length, 0);
});

test('pairing: OpenAI 形状（role:tool + tool_calls）也能修', () => {
  const repaired = repairToolPairing([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'tool', tool_call_id: 'c2', content: '孤儿' },
  ]);
  assert.equal(repaired.length, 2);
});

test('sniff: 按响应体形状判断，不看 header', () => {
  assert.equal(sniffBody('data: {"a":1}\n\n'), 'sse');
  assert.equal(sniffBody(': ping\n\n'), 'sse');
  assert.equal(sniffBody('{"choices":[]}'), 'json');
  assert.equal(sniffBody('[1,2]'), 'json');
  assert.equal(sniffBody('   '), 'empty');
  assert.equal(sniffBody('random text'), 'unknown');
  assert.equal(sniffBody('\ufeff{"a":1}'), 'json');
});

// ---------------------------------------------------------------- 本地应答

test('local: 额度探测（max_tokens:1 + quota）', () => {
  const r = tryOptimizations({ max_tokens: 1, messages: [{ role: 'user', content: 'quota check' }] });
  assert.equal(r.kind, 'quota');
  assert.equal(r.text, 'Quota check passed.');
});

test('local: 额度探测要求 max_tokens 恰好是 1', () => {
  assert.equal(tryOptimizations({ max_tokens: 100, messages: [{ role: 'user', content: 'quota' }] }), null);
});

test('local: 权限提示的命令前缀', () => {
  const body = {
    messages: [{ role: 'user', content: '<policy_spec>allow git</policy_spec>\nCommand: git commit -m "x"' }],
  };
  assert.equal(tryOptimizations(body).text, 'git commit');
});

test('local: 命令注入要如实报告，不执行', () => {
  const body = {
    messages: [{ role: 'user', content: '<policy_spec>x</policy_spec>\nCommand: git status && $(rm -rf /)' }],
  };
  assert.equal(tryOptimizations(body).text, 'command_injection_detected');
});

test('local: 会话标题', () => {
  const body = { system: 'Generate a sentence-case title for this conversation', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(tryOptimizations(body).text, 'Conversation');
});

test('local: 带工具的请求不做标题应答', () => {
  const body = {
    system: 'Generate a sentence-case title for this conversation',
    tools: [{ name: 'x' }],
    messages: [{ role: 'user', content: 'hi' }],
  };
  assert.equal(tryOptimizations(body), null);
});

test('local: 建议模式返回空字符串', () => {
  const body = { messages: [{ role: 'user', content: '[SUGGESTION MODE: on] hi' }] };
  const r = tryOptimizations(body);
  assert.equal(r.kind, 'suggestion');
  assert.equal(r.text, '');
});

test('local: 文件路径提取（读命令）', () => {
  const body = {
    system: 'extract any file paths that this command reads',
    messages: [{ role: 'user', content: 'Command: cat src/a.js src/b.js\nOutput: content' }],
  };
  assert.equal(tryOptimizations(body).text, '<filepaths>\nsrc/a.js\nsrc/b.js\n</filepaths>');
});

test('local: 文件路径提取（列表命令给空块）', () => {
  const body = {
    system: 'extract any file paths that this command reads',
    messages: [{ role: 'user', content: 'Command: ls -la src\nOutput: ...' }],
  };
  assert.equal(tryOptimizations(body).text, '<filepaths>\n</filepaths>');
});

test('local: grep 的 pattern 不算路径', () => {
  assert.equal(extractFilepathsFromCommand('grep -rn "needle" src/'), '<filepaths>\nsrc/\n</filepaths>');
});

test('local: Windows 路径不被反斜杠转义吃掉', () => {
  assert.equal(extractFilepathsFromCommand('type C:\\notes\\todo.md'), '<filepaths>\nC:\\notes\\todo.md\n</filepaths>');
});

test('local: 单项开关能关掉', () => {
  const body = { max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] };
  assert.equal(tryOptimizations(body, { enabled: { quota: false } }), null);
});

test('local: 不匹配的请求必须原样放过', () => {
  assert.equal(tryOptimizations({ messages: [{ role: 'user', content: '帮我写个函数' }] }), null);
  // 两个 user 轮次形状不对，不猜
  assert.equal(
    tryOptimizations({ max_tokens: 1, messages: [{ role: 'user', content: 'quota' }, { role: 'user', content: 'quota' }] }),
    null,
  );
});

// ---------------------------------------------------------------- combo

test('combo: 名字归一化', () => {
  assert.equal(comboId('My Fast Chain'), 'combo:my-fast-chain');
  assert.equal(comboId('快速链'), comboId('快速链'), '同一中文名要稳定');
  assert.ok(comboId('快速链').startsWith('combo:u-'));
});

test('combo: 配置整形（丢非法项）', () => {
  const rows = normalizeCombos([
    { name: 'a', models: ['x/y'] },
    { name: 'b', models: [] },
    { name: 'c', models: ['z'], strategy: '乱写' },
    { models: ['q'] },
    null,
  ]);
  assert.equal(rows.length, 2, '空链与 null 该被丢掉');
  assert.equal(rows[0].strategy, 'fallback');
  assert.equal(rows[1].strategy, 'fallback', '未知策略回退');
});

test('combo: fallback 永远从链头开始', () => {
  const c = { models: ['a', 'b', 'c'], strategy: 'fallback' };
  assert.deepEqual(chainFor(c, 0), ['a', 'b', 'c']);
  assert.deepEqual(chainFor(c, 99), ['a', 'b', 'c']);
});

test('combo: round-robin 按 stickyLimit 轮换', () => {
  const c = { models: ['a', 'b', 'c'], strategy: 'round-robin', stickyLimit: 2 };
  assert.deepEqual(chainFor(c, 0), ['a', 'b', 'c']);
  assert.deepEqual(chainFor(c, 1), ['a', 'b', 'c'], '未到 stickyLimit 不轮换');
  assert.deepEqual(chainFor(c, 2), ['b', 'c', 'a']);
  assert.deepEqual(chainFor(c, 4), ['c', 'a', 'b']);
});

test('combo: 容量取交集', () => {
  const cap = chainCapacity([
    { supportsVision: true, contextWindow: 1_000_000, supportsTools: true },
    { supportsVision: false, contextWindow: 128_000, supportsTools: true },
  ]);
  assert.equal(cap.supportsVision, false, '链尾不支持视觉，链就不该声明支持');
  assert.equal(cap.contextWindow, 128_000, '窗口取最小值');
  assert.equal(cap.supportsTools, true);
});

test('combo: 有一环窗口未知时不给数字', () => {
  const cap = chainCapacity([{ contextWindow: 1_000_000 }, {}]);
  assert.equal(cap.contextWindow, null);
});

test('combo: 正文已交付后不能再降级', () => {
  assert.equal(canFallbackAfter(false), true);
  assert.equal(canFallbackAfter(true), false);
});

test('combo: 按名字匹配（三种写法）', () => {
  const config = { combos: [{ name: 'fast', models: ['a/x'] }] };
  assert.ok(matchCombo('fast', config));
  assert.ok(matchCombo('combo:fast', config));
  assert.ok(matchCombo('FAST', config), '大小写不敏感');
  assert.equal(matchCombo('nope', config), null);
});

test('combo: 禁用的链当作不存在', () => {
  const config = { combos: [{ name: 'fast', models: ['a/x'], disabled: true }] };
  assert.equal(matchCombo('fast', config), null);
});

// ---------------------------------------------------------------- 免费供应商

test('free: 注册表只收有免费额度的（3 本机 + 15 需 key）', () => {
  const local = FREE_PROVIDERS.filter((p) => p.local);
  const keyed = FREE_PROVIDERS.filter((p) => !p.local);
  assert.equal(local.length, 3, '本机免账号应为 3 家');
  assert.equal(keyed.length, 15, '有免费额度的应为 15 家');
  // 本机三家不该有 env（不需要 key）
  for (const p of local) assert.equal(p.env, null, `${p.id} 不该要求 key`);
  // 需 key 的每家都要声明 env 与申请页
  for (const p of keyed) {
    assert.ok(p.env, `${p.id} 缺 env 声明`);
    assert.ok(p.keyUrl, `${p.id} 缺申请页`);
  }
});

test('free: 每家都有 id / name / baseUrl / format', () => {
  const seen = new Set();
  for (const p of FREE_PROVIDERS) {
    assert.ok(p.id, '缺 id');
    assert.ok(!seen.has(p.id), `id 重复：${p.id}`);
    seen.add(p.id);
    assert.ok(p.name, `${p.id} 缺 name`);
    assert.ok(p.baseUrl, `${p.id} 缺 baseUrl`);
    assert.equal(p.format, 'openai-chat', `${p.id} 的 format 目前只支持 openai-chat`);
    assert.ok(p.free, `${p.id} 缺免费额度说明`);
  }
});

test('free: baseUrl 有占位符的必须写明要替换什么', () => {
  for (const p of FREE_PROVIDERS) {
    if (!p.baseUrl.includes('{')) continue;
    assert.ok(p.needs, `${p.id} 的 baseUrl 含占位符但没写 needs`);
  }
});

await testAsync('free: 模型列表端点要跟着 baseUrl 覆盖走', async () => {
  // 这是真实踩过的坑：覆盖 baseUrl 指向镜像后，仍去拉官方 /models，
  // 拿到的是一份「看起来能选、实际调不通」的清单。
  const { freeModelsOf, invalidateFreeModels } = await import('./free-upstream.mjs');
  invalidateFreeModels('openrouter');
  // 指向一个必然连不上的地址 + 给个 key（没 key 会直接返回空，走不到兜底逻辑）。
  // 显式传 env 是为了不受本机真实环境变量影响。
  const store = { providers: { openrouter: { baseUrl: 'http://127.0.0.1:1/v1' } } };
  const env = { ROUTER_PROVIDER_KEY_OPENROUTER: 'test-key' };
  const models = await freeModelsOf('openrouter', { force: true, store, env, timeout: 300 });
  const ids = models.map((m) => m.id);
  invalidateFreeModels('openrouter');
  assert.ok(
    ids.includes('openrouter/free'),
    `覆盖 baseUrl 后不该再返回官方列表，实际拿到：${ids.slice(0, 5).join(', ') || '(空)'}`,
  );
});

await testAsync('free: 环境变量覆盖 baseUrl 时同样不拉官方列表', async () => {
  const { freeModelsOf, invalidateFreeModels } = await import('./free-upstream.mjs');
  invalidateFreeModels('ollama');
  const models = await freeModelsOf('ollama', {
    force: true,
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:1/v1' },
    timeout: 300,
  });
  invalidateFreeModels('ollama');
  // 本机服务的静态表为空，所以应该是空数组而不是任何官方内容
  assert.equal(models.length, 0);
});

// ---------------------------------------------------------------- pi 模型表

await testAsync('pi: 网关 provider 用 <供应商>/<模型> 命名并带上下文', async () => {
  const p = await gatewayPiProvider({
    entries: [
      { id: 'trae-local/glm-5.3-flash', name: 'trae-local/glm', context: 128000 },
      { id: 'codearts/deepseek-v4.1-flash' },
    ],
    combos: [{ id: 'combo:fast', name: 'fast', context_length: 200000, supports_vision: true }],
  });
  assert.match(p.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(p.api, 'openai-completions');
  assert.ok(p.apiKey, 'pi 要求非空 apiKey');
  const byId = new Map(p.models.map((m) => [m.id, m]));
  assert.equal(byId.get('trae-local/glm-5.3-flash').contextWindow, 128000);
  assert.equal(byId.get('trae-local/glm-5.3-flash').name, 'trae-local/glm');
  assert.ok(byId.get('combo:fast'), 'combo 应一并广播给 pi');
  assert.deepEqual(byId.get('combo:fast').input, ['text', 'image']);
});

test('pi: 免费供应商 provider 去尾斜杠、空值不写进 models.json', () => {
  const p = freePiProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/',
    models: [
      { id: 'a/b:free', name: 'A', context: 32000 },
      { id: 'c', context: 0 },
    ],
  });
  assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(p.apiKey, 'local');
  assert.equal(p.models[0].contextWindow, 32000);
  assert.equal(p.models[1].contextWindow, undefined, '0 不该写成 contextWindow');
});

// ---------------------------------------------------------------- 汇总

console.log('');
if (failures.length) {
  console.log(`\x1b[1;31m${failures.length} 项失败\x1b[0m，${passed} 项通过`);
  process.exit(1);
}
console.log(`\x1b[1;32m全部通过\x1b[0m（${passed} 项）`);
