#!/usr/bin/env node
/**
 * quota.test.js — 积分/签到数据层里能离线验证的部分。
 *
 * 真实取数要网络与本机服务，测不了；但「拿到上游原始数据之后怎么解读」全在纯函数
 * 里，而那正是最容易出错的地方：签到状态判反了，用户会以为还能领，点了却领不到；
 * 余额加错了，用户会以为还有额度。所以把这一层钉住。
 *
 * 跑法：node --test test/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const quota = require(path.join(__dirname, '..', 'assets', 'quota.js'));

// ---------------------------------------------------------------- 签到状态

/**
 * Qoder 的 status 字段见过 DISABLED 与 ENABLED。判「能不能领」不能只看字符串，
 * 因为活动会改名、会加新状态；按「有奖励 + 没有冷却时间」判断更稳。
 */
test('normalizeQoderCheckin: DISABLED 表示该区域没有签到活动', () => {
  const s = quota.normalizeQoderCheckin({ status: 'DISABLED', rewardCredits: 100, campaignKey: 'cn_daily_check_in_legacy' });
  assert.strictEqual(s.supported, false);
  assert.strictEqual(s.claimable, false, '活动没开时不该显示可领');
  assert.strictEqual(s.rewardCredits, 100, '奖励额度仍应保留，便于展示「本来能领多少」');
});

test('normalizeQoderCheckin: ENABLED 且没有冷却时间 → 可领', () => {
  const s = quota.normalizeQoderCheckin({ status: 'ENABLED', rewardCredits: 100, nextClaimAt: 0 });
  assert.strictEqual(s.supported, true);
  assert.strictEqual(s.claimable, true);
});

test('normalizeQoderCheckin: nextClaimAt 非 0 → 今天已经领过了', () => {
  const s = quota.normalizeQoderCheckin({ status: 'ENABLED', rewardCredits: 100, nextClaimAt: 1793700000000 });
  assert.strictEqual(s.claimable, false);
  assert.strictEqual(s.nextClaimAt, 1793700000000);
});

test('normalizeQoderCheckin: 奖励为 0 时不可领（避免空领）', () => {
  const s = quota.normalizeQoderCheckin({ status: 'ENABLED', rewardCredits: 0 });
  assert.strictEqual(s.claimable, false);
});

test('normalizeQoderCheckin: 缺字段不炸，状态标 UNKNOWN', () => {
  const s = quota.normalizeQoderCheckin({});
  assert.strictEqual(s.status, 'UNKNOWN');
  assert.strictEqual(s.currentStreakDays, 0);
  assert.strictEqual(s.totalRewardCredits, 0);
});

// ---------------------------------------------------------------- 汇总

const qoderRow = (remaining, total, extra = {}) => ({
  provider: 'qoder-cn',
  title: 'Qoder 国内版',
  available: true,
  kind: 'qoder',
  plan: 'Free',
  account: 'abcd1234…',
  buckets: [{ id: 'addon', label: '加购额度', remaining, total, used: total - remaining, unit: 'credits' }],
  checkin: { supported: false, claimable: false, rewardCredits: 0, currentStreakDays: 0, totalRewardCredits: 0 },
  ...extra,
});

const traeRow = (accounts) => ({
  provider: 'trae',
  title: 'Trae（免费积分）',
  available: true,
  kind: 'trae',
  accounts,
});

test('summarize: 把 Qoder 与 Trae 的余额加在一起', () => {
  const rows = [
    qoderRow(96, 800),
    traeRow([
      { name: 'a', remaining: 100, total: 200, unit: 'credits', checkin: { supported: true, claimed: true, rewardCredits: 100 } },
    ]),
  ];
  const s = quota.summarize(rows);
  assert.strictEqual(s.remaining, 196);
  assert.deepStrictEqual(s.available, ['qoder-cn', 'trae']);
});

test('summarize: 查不到的来源不计入合计', () => {
  const rows = [
    qoderRow(96, 800),
    { provider: 'qoder', title: 'Qoder 国际版', available: false, reason: '未登录' },
  ];
  const s = quota.summarize(rows);
  assert.strictEqual(s.remaining, 96);
  assert.deepStrictEqual(s.available, ['qoder-cn']);
});

test('summarize: 可签到的来源被单独列出来（用于提醒）', () => {
  const rows = [
    qoderRow(96, 800, { checkin: { supported: true, claimable: true, rewardCredits: 100, currentStreakDays: 1, totalRewardCredits: 100 } }),
    traeRow([
      { name: 'a', remaining: 10, total: 20, unit: 'credits', checkin: { supported: true, claimed: false, rewardCredits: 100 } },
      { name: 'b', remaining: 10, total: 20, unit: 'credits', checkin: { supported: true, claimed: true, rewardCredits: 100 } },
    ]),
  ];
  const s = quota.summarize(rows);
  assert.strictEqual(s.claimable.length, 2, '一个 Qoder + 一个 Trae 账号');
  assert.strictEqual(s.claimable.reduce((a, c) => a + c.reward, 0), 200);
});

test('summarize: 查询失败的 Trae 账号不计入合计，也不计入可签到', () => {
  const rows = [
    traeRow([
      { name: 'a', remaining: 10, total: 20, unit: 'credits', error: 'token 过期', checkin: { supported: true, claimed: false, rewardCredits: 100 } },
    ]),
  ];
  const s = quota.summarize(rows);
  assert.strictEqual(s.remaining, 0);
  assert.strictEqual(s.claimable.length, 0);
});

test('summarize: WorkBuddy 的「凭证有效期（天）」不算进积分合计', () => {
  const rows = [
    { provider: 'workbuddy', title: 'WorkBuddy 国内版', available: true, kind: 'workbuddy', buckets: [{ id: 'credential', label: '凭证有效期', remaining: 12, total: null, used: null, unit: '天' }] },
  ];
  const s = quota.summarize(rows);
  assert.strictEqual(s.remaining, 0, '天数和 credits 不能相加');
});

test('summarize: 空输入返回零值而不是崩', () => {
  const s = quota.summarize([]);
  assert.deepStrictEqual(s.available, []);
  assert.strictEqual(s.remaining, 0);
  assert.deepStrictEqual(s.claimable, []);
});

// ---------------------------------------------------------------- 文本渲染

test('renderText: 不可用的来源显示原因，而不是静默省略', () => {
  const text = quota.renderText([{ provider: 'qoder', title: 'Qoder 国际版', available: false, reason: '未登录' }]);
  assert.match(text, /未登录/, '应该把原因写出来');
});

test('renderText: 显示剩余/总量与百分比', () => {
  const text = quota.renderText([
    traeRow([{ name: 'acc', remaining: 100, total: 200, unit: 'credits', checkin: { supported: true, claimed: false, rewardCredits: 100 } }]),
  ]);
  assert.match(text, /剩 100/);
  assert.match(text, /共 200/);
  assert.match(text, /50%/);
  assert.match(text, /今日可领 100/);
});

test('renderText: 已签到显示为已签到，不再说可领', () => {
  const text = quota.renderText([
    traeRow([{ name: 'acc', remaining: 100, total: 200, unit: 'credits', checkin: { supported: true, claimed: true, rewardCredits: 100 } }]),
  ]);
  assert.match(text, /今日已签到/);
  assert.ok(!/今日可领/.test(text));
});

test('renderText: Qoder 无签到活动时明确说明', () => {
  const text = quota.renderText([qoderRow(96, 800)]);
  assert.match(text, /没有每日签到活动/);
});

test('renderText: Qoder 可签到时带出连续天数', () => {
  const text = quota.renderText([
    qoderRow(96, 800, { checkin: { supported: true, claimable: true, rewardCredits: 100, currentStreakDays: 3, totalRewardCredits: 300 } }),
  ]);
  assert.match(text, /今日可领 100 积分（连续 3 天）/);
});

test('renderText: 每个账号一行，不把多个账号挤成一行', () => {
  const text = quota.renderText([
    traeRow([
      { name: 'first', remaining: 10, total: 20, unit: 'credits', checkin: { supported: true, claimed: true, rewardCredits: 0 } },
      { name: 'second', remaining: 30, total: 40, unit: 'credits', checkin: { supported: true, claimed: true, rewardCredits: 0 } },
    ]),
  ]);
  assert.match(text, /first/);
  assert.match(text, /second/);
});

test('renderText: 尾部有合计行', () => {
  const text = quota.renderText([qoderRow(96, 800)]);
  assert.match(text, /合计剩 96/);
});

test('renderText: 查询失败的账号显示失败原因', () => {
  const text = quota.renderText([
    traeRow([{ name: 'acc', remaining: 0, total: 0, unit: 'credits', error: 'token 过期', checkin: { supported: false, claimed: false, rewardCredits: 0 } }]),
  ]);
  assert.match(text, /查询失败（token 过期）/);
});

test('renderText: 空输入也返回结构完整的一段文本', () => {
  const text = quota.renderText([]);
  assert.match(text, /积分余额与签到/);
  assert.match(text, /可查 0 个来源/);
});

// ---------------------------------------------------------------- 数据源清单

test('两个 Qoder 区域都指向官方 openapi', () => {
  assert.strictEqual(quota.QODER_REGIONS['qoder-cn'].provider, 'qoder-cn');
  assert.strictEqual(quota.QODER_REGIONS.qoder.provider, 'qoder');
  assert.match(quota.QODER_REGIONS['qoder-cn'].openapi, /qoder\.com\.cn/);
  assert.match(quota.QODER_REGIONS.qoder.openapi, /qoder\.sh/);
});

test('Trae 的候选地址包含 pi 里配的那个端口（换端口也能找到）', () => {
  const urls = quota.traeBaseUrls();
  assert.ok(urls.some((u) => u.includes(':7863')), '应兜底试 7863');
  assert.ok(urls.every((u) => !u.endsWith('/v1')), '应该剥掉 /v1 后缀再拼 /admin/api/credits');
});

// ---------------------------------------------------------------- 国际版的两个边界

/**
 * Qoder 国际站的签到接口是 404（活动只挂在网页里）。这与「活动没开」是两件事：
 * 前者无论等多久都不会有，后者只是当前窗口没开。混在一起会误导用户。
 */
test('normalizeQoderCheckin: 国际站的 404 由调用方区分，不当作活动关闭', () => {
  // 纯函数本身只处理「拿到了 status 响应」的情况
  const disabled = quota.normalizeQoderCheckin({ status: 'DISABLED', rewardCredits: 100 });
  assert.strictEqual(disabled.supported, false);
  assert.strictEqual(disabled.note, undefined, 'note 由调用方补充，不该由纯函数编造');
});

test('renderText: 有 note 时优先显示 note（区分「没接口」与「没活动」）', () => {
  const text = quota.renderText([
    {
      provider: 'qoder',
      title: 'Qoder 国际版',
      available: true,
      kind: 'qoder',
      buckets: [],
      quotaExhausted: true,
      checkin: { supported: false, status: 'UNSUPPORTED', claimable: false, rewardCredits: 0, note: '该区域没有签到接口（活动只在网页里）' },
    },
  ]);
  assert.match(text, /没有签到接口/, '应显示接口不存在');
  assert.ok(!/没有每日签到活动/.test(text), '不该误报成活动未开');
});

test('renderText: 额度为 0 但账号可用时，说明「已用尽」而不是「查不到」', () => {
  const text = quota.renderText([
    { provider: 'qoder', title: 'Qoder 国际版', available: true, kind: 'qoder', buckets: [], quotaExhausted: true, checkin: null },
  ]);
  assert.match(text, /额度已用尽/, '应说清是 0 额度');
  assert.match(text, /模型仍可调用/, '免费号额度为 0 但模型可用，这点要说出来');
});

// ---------------------------------------------------------------- CodeArts

/**
 * CodeArts（华为云）由第三方 Go 网关 codearts2api 提供服务。它自带控制台接口
 * （/admin/api/credits 与 /admin/api/claim），所以这里只需读它的结果。
 *
 * 注意它和 Qoder 的语义差别：CodeArts 的积分是**真实扣费**的（免费权益通道
 * 2026-10 下线），所以「剩余」就是能用的量；而 Qoder 的免费号额度为 0 但模型仍可用。
 */
const codeartsRow = (acc = {}) => ({
  provider: 'codearts',
  title: 'CodeArts Agent',
  available: true,
  kind: 'codearts',
  accounts: [
    {
      id: 'x',
      name: 'GT-demo',
      remaining: 6599.25,
      total: 6600,
      used: 0.75,
      unit: 'credits',
      package: '体验版',
      expiring: 99.25,
      resetDate: '2026-11-24',
      ...acc,
    },
  ],
  checkin: { supported: true, claimed: false, rewardCredits: 0 },
});

test('renderText: CodeArts 显示剩余/总量/套餐，并单独提示即将过期', () => {
  const text = quota.renderText([codeartsRow()]);
  assert.match(text, /\[CodeArts Agent\]/);
  assert.match(text, /剩 6599\.25/);
  assert.match(text, /共 6600/);
  assert.match(text, /体验版/);
  // 即将过期的那部分是浪费风险，必须单独显示
  assert.match(text, /即将过期 99\.25/);
  assert.match(text, /2026-11-24 重置/);
});

test('summarize: CodeArts 的余额计入合计', () => {
  const s = quota.summarize([codeartsRow()]);
  assert.strictEqual(s.remaining, 6599.25);
  assert.deepStrictEqual(s.available, ['codearts']);
});

test('summarize: CodeArts 查询失败的账号不计入', () => {
  const s = quota.summarize([codeartsRow({ error: '网关不可用', remaining: 0 })]);
  assert.strictEqual(s.remaining, 0);
});

test('fmtNum: 整数不显示小数点，小数最多两位', () => {
  assert.strictEqual(quota.fmtNum(6600), '6600');
  assert.strictEqual(quota.fmtNum(6599.25), '6599.25');
  assert.strictEqual(quota.fmtNum(6599.1), '6599.1');
  assert.strictEqual(quota.fmtNum('6600.00'), '6600');
});

test('CODEARTS 常量指向第三方网关的默认端口', () => {
  assert.strictEqual(quota.CODEARTS.provider, 'codearts');
  assert.strictEqual(quota.CODEARTS.port, 10087);
});
