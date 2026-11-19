#!/usr/bin/env node
/**
 * 网关运维 CLI。日常由 `router.mjs gateway <子命令>` 转发进来，也可以直接跑。
 *
 *   node gateway/cli.mjs key add --name dev --providers trae-local,zcode --days 30
 *   node gateway/cli.mjs key list
 *   node gateway/cli.mjs key rm zsk_abcd
 *   node gateway/cli.mjs status
 *   node gateway/cli.mjs usage --days 7
 *   node gateway/cli.mjs balance [provider...]
 *   node gateway/cli.mjs doctor
 *
 * 这里只做「离线」动作（改密钥库、读快照、打 HTTP 到正在跑的网关）。
 * 启停进程由 router.mjs 负责，避免两处各有一套 PID 逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, KEYS_FILE, CONFIG_FILE, PORT, HOST, REPO_ROOT, loadConfig, ensureDataDirs, readJson, writeJsonAtomic } from './config.mjs';
import { createKey, loadKeyDb, publicKey, removeKey, saveKeyDb } from './keys.mjs';
import { DESCRIPTORS, BY_ID, enabledIds, modelsOf, upstreamKeyFor } from './providers.mjs';
import { createUsageRecorder } from './usage.mjs';
import { normalizeCombos, comboId, COMBO_STRATEGIES } from './combo.mjs';
import { FREE_PROVIDERS, BY_ID as FREE_BY_ID } from './free-providers.mjs';
import {
  loadProviderStore,
  setProviderKey,
  removeProvider,
  keySource,
  PROVIDERS_FILE,
} from './provider-keys.mjs';

const C = {
  ok: '\x1b[1;32m✓\x1b[0m',
  bad: '\x1b[1;31m✗\x1b[0m',
  warn: '\x1b[1;33m!',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};
const say = (...a) => console.log(...a);

const require = createRequire(import.meta.url);

/**
 * opencode 的写入模块在 `integrations/qodbuddy2pi/assets/opencode-config.js`（CommonJS）。
 * router.mjs 里也有一个同功能的 requireShared；这里不能直接用——`router providers`
 * 是转给本文件执行的，router.mjs 的作用域不在。早先这里漏了这个函数，
 * `providers install` 一跑就 ReferenceError。
 */
function requireShared(name) {
  const dirs = [
    process.env.QODBUDDY_REPO,
    path.join(REPO_ROOT, 'integrations', 'qodbuddy2pi'),
    'E:\\qodbuddy2pi',
  ].filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, 'assets', name);
    try {
      if (fs.statSync(file).isFile()) return require(file);
    } catch {}
  }
  return null;
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function gatewayFetch(pathname, { method = 'GET', body, secret } = {}) {
  const headers = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (body) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`http://${HOST}:${PORT}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // 网关没起时不要把 ECONNREFUSED 的原始堆栈甩给用户
    const down = err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED';
    return {
      ok: false,
      status: 0,
      down,
      error: down ? `网关没在 http://${HOST}:${PORT} 上跑` : `连不上网关：${err.message}`,
    };
  }
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, text };
  }
}

// ---------------------------------------------------------------- key

function cmdKey(args) {
  ensureDataDirs();
  const sub = positional(args)[0] || 'list';

  if (sub === 'add' || sub === 'create' || sub === 'new') {
    const name = flag(args, '--name', 'default');
    const providers = flag(args, '--providers', null);
    const models = flag(args, '--models', null);
    const ips = flag(args, '--ips', null);
    const days = Number(flag(args, '--days', 0)) || 0;
    const quota = Number(flag(args, '--quota', 0)) || 0;
    const note = flag(args, '--note', '');

    for (const p of splitList(providers)) {
      if (!BY_ID.has(p)) {
        say(`${C.bad} 未知供应商：${p}（可选：${[...BY_ID.keys()].join('、')}）`);
        return 1;
      }
    }

    const { key, secret } = createKey({
      name,
      providers: splitList(providers),
      models: splitList(models),
      ips: splitList(ips),
      tokenQuota: quota,
      expiresInDays: days,
      note,
    });
    say(`${C.ok} 已创建密钥 ${C.bold}${key.name}${C.reset} ${C.dim}${key.id}${C.reset}`);
    say('');
    say(`  ${C.bold}${secret}${C.reset}`);
    say('');
    say(`${C.warn} 明文只显示这一次。库里只存 SHA-256，丢了只能重建。`);
    say(`${C.dim}  供应商：${key.providers.length ? key.providers.join('、') : '全部'}　模型：${key.models.length ? key.models.join('、') : '全部'}　到期：${key.expiresAt || '不过期'}${C.reset}`);
    return 0;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const target = positional(args)[1];
    if (!target) {
      say(`${C.bad} 用法：key rm <key id 或前缀>`);
      return 1;
    }
    const db = loadKeyDb();
    const n = removeKey(db, target);
    if (!n) {
      say(`${C.bad} 没找到密钥 ${target}`);
      return 1;
    }
    saveKeyDb(db);
    say(`${C.ok} 已删除 ${n} 个密钥`);
    return 0;
  }

  if (sub === 'disable' || sub === 'enable') {
    const target = positional(args)[1];
    const db = loadKeyDb();
    const key = db.keys.find((k) => k.id === target || k.prefix === target);
    if (!key) {
      say(`${C.bad} 没找到密钥 ${target}`);
      return 1;
    }
    key.disabled = sub === 'disable';
    saveKeyDb(db);
    say(`${C.ok} ${key.name} 已${key.disabled ? '禁用' : '启用'}`);
    return 0;
  }

  if (sub === 'reset-usage') {
    const target = positional(args)[1];
    const db = loadKeyDb();
    const keys = target ? db.keys.filter((k) => k.id === target || k.prefix === target) : db.keys;
    for (const k of keys) k.usedTokens = 0;
    saveKeyDb(db);
    say(`${C.ok} 已清零 ${keys.length} 个密钥的 token 用量`);
    return 0;
  }

  // list
  const db = loadKeyDb();
  if (!db.keys.length) {
    say(`${C.dim}还没有密钥。创建：node router.mjs gateway key add --name dev --providers trae-local${C.reset}`);
    return 0;
  }
  say(`${C.bold}网关密钥${C.reset}  ${C.dim}${KEYS_FILE}${C.reset}`);
  say('─'.repeat(100));
  say(`  ${pad('名称', 14)} ${pad('前缀', 16)} ${pad('供应商', 22)} ${pad('模型', 18)} ${pad('用量', 16)} 到期`);
  for (const k of db.keys.map(publicKey)) {
    const used = k.tokenQuota ? `${fmt(k.usedTokens)}/${fmt(k.tokenQuota)}` : fmt(k.usedTokens);
    const expired = k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
    say(
      `  ${pad(k.name, 14)} ${pad(k.prefix, 16)} ${pad(k.providers.length ? k.providers.join(',') : '全部', 22)} ${pad(
        k.models.length ? k.models.join(',') : '全部',
        18,
      )} ${pad(used, 16)} ${expired ? `${C.bad}已过期${C.reset}` : k.expiresAt ? k.expiresAt.slice(0, 10) : '不过期'}${k.disabled ? ` ${C.warn}已禁用${C.reset}` : ''}`,
    );
  }
  say('─'.repeat(100));
  return 0;
}

function splitList(v) {
  if (!v || v === true) return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function pad(s, n) {
  const width = visibleWidth(String(s));
  return String(s) + ' '.repeat(Math.max(0, n - width));
}

function visibleWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60]/.test(ch) ? 2 : 1;
  return w;
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

// ---------------------------------------------------------------- status / usage

async function cmdStatus(args) {
  const json = args.includes('--json');
  const r = await gatewayFetch('/v1/gateway/status');
  if (!r.ok) {
    say(`${C.bad} ${r.error || r.json?.error?.message || r.text || `HTTP ${r.status}`}`);
    if (r.down) say(`${C.dim}  启动：node router.mjs gateway up${C.reset}`);
    return 1;
  }
  if (json) {
    say(JSON.stringify(r.json, null, 2));
    return 0;
  }
  const s = r.json;
  say(`${C.bold}网关${C.reset} v${s.version}  PID ${s.pid}  运行 ${s.uptimeSec}s  ${s.openMode ? `${C.warn}回环免密钥${C.reset}` : ''}`);
  say('─'.repeat(104));
  say(
    `  ${pad('供应商', 20)} ${pad('权重', 8)} ${pad('额度比', 8)} ${pad('并发', 10)} ${pad('速率', 14)} ${pad('成功率', 8)} ${pad('冷却', 12)} 粘性`,
  );
  for (const p of s.providers) {
    const cd = p.cooldownRemainingMs > 0 ? `${C.warn}${Math.ceil(p.cooldownRemainingMs / 1000)}s${C.reset}` : `${C.ok}就绪${C.reset}`;
    const limit = p.limit;
    // 并发列显示「在飞/生效上限」：上限已经取过网关设置与本地限额的最小值
    const conc = limit ? `${p.inFlight}/${limit.effectiveConcurrency}` : `${p.inFlight}`;
    // 速率列显示窗口用量与档位；被本地限流挡住时标出来
    const rate = limit
      ? `${limit.windowUsed}/${limit.rpm}${limit.throttled ? `${C.warn}*${C.reset}` : ''}`
      : '-';
    say(
      `  ${pad(p.id, 20)} ${pad(p.weight, 8)} ${pad(p.quotaRatio == null ? '-' : p.quotaRatio.toFixed(2), 8)} ${pad(
        conc,
        10,
      )} ${pad(rate, 14)} ${pad(`${Math.round(p.successRate * 100)}%`, 8)} ${pad(cd, 12)} ${p.stickySessions || 0}`,
    );
  }
  say('─'.repeat(104));
  say(`${C.dim}  调度：最多换 ${s.settings.maxAttempts} 家、topN ${s.settings.topN}、单家并发上限 ${s.settings.maxInFlight}（实际取本地限额的较小值）${C.reset}`);
  const tiers = s.providers.filter((p) => p.limit).map((p) => `${p.id}:${p.limit.tier}`);
  if (tiers.length) say(`${C.dim}  本机限额档位：${tiers.join('、')}（${C.reset}node router.mjs limits${C.dim}）${C.reset}`);
  const throttled = s.providers.filter((p) => p.limit && p.limit.throttled);
  if (throttled.length) {
    say(
      `${C.warn}  本地限流中：${throttled
        .map((p) => `${p.id}（${Math.ceil(p.limit.retryAfterMs / 1000)}s）`)
        .join('、')}${C.reset}`,
    );
  }
  return 0;
}

async function cmdUsage(args) {
  const days = Number(flag(args, '--days', 7)) || 7;
  const json = args.includes('--json');
  const r = await gatewayFetch(`/v1/gateway/usage?days=${days}`);
  if (!r.ok) {
    // 网关没跑也能读：用量是本地 JSONL
    const local = createUsageRecorder().summarize({ days });
    return renderUsage(local, { json });
  }
  return renderUsage(r.json, { json });
}

function renderUsage(data, { json }) {
  if (json) {
    say(JSON.stringify(data, null, 2));
    return 0;
  }
  if (!data.totals.requests) {
    say(`${C.dim}最近 ${data.days.length} 天没有请求记录。${C.reset}`);
    return 0;
  }
  say(`${C.bold}用量${C.reset}  最近 ${data.days.length} 天`);
  say('─'.repeat(88));
  say(`  ${pad('日期', 12)} ${pad('请求', 8)} ${pad('错误', 8)} ${pad('输入 token', 14)} ${pad('输出 token', 14)} 平均耗时`);
  for (const d of data.days) {
    if (!d.requests) continue;
    const rate = d.requests ? `${((d.errors / d.requests) * 100).toFixed(1)}%` : '-';
    say(
      `  ${pad(d.day, 12)} ${pad(d.requests, 8)} ${pad(d.errors ? `${C.bad}${d.errors}${C.reset} (${rate})` : '0', 8)} ${pad(fmt(d.inputTokens), 14)} ${pad(fmt(d.outputTokens), 14)} ${d.avgDurationMs}ms`,
    );
  }
  say('─'.repeat(88));
  const t = data.totals;
  say(
    `  合计 ${t.requests} 次请求，${t.errors} 次错误（${((t.errors / t.requests) * 100).toFixed(1)}%），${fmt(t.inputTokens)} in / ${fmt(t.outputTokens)} out，平均 ${t.avgDurationMs}ms`,
  );
  return 0;
}

// ---------------------------------------------------------------- balance

async function cmdBalance(args) {
  const wanted = positional(args);
  const json = args.includes('--json');
  const r = await gatewayFetch('/v1/gateway/balance');
  if (!r.ok) {
    say(`${C.bad} ${r.error || r.json?.error?.message || `HTTP ${r.status}`}`);
    say(`${C.dim}  账号级：node router.mjs account　额度：node router.mjs gateway refresh-quota${C.reset}`);
    return 1;
  }
  const rows = (r.json.providers || []).filter((row) => !wanted.length || wanted.includes(row.provider));
  if (json) {
    say(JSON.stringify(rows, null, 2));
    return 0;
  }
  say(`${C.bold}额度${C.reset}  ${C.dim}${r.json.fetchedAt}${C.reset}`);
  say('─'.repeat(88));
  for (const row of rows) {
    const head = `${pad(row.provider, 20)} ${row.available ? `${C.ok}可用${C.reset}` : `${C.warn}不可用${C.reset}`}`;
    const parts = [];
    for (const b of row.buckets || []) {
      if (b.unit === 'credits' || b.unit === 'tokens') parts.push(`${b.label || b.id}: ${fmt(b.remaining)}/${fmt(b.total)}`);
      else parts.push(`${b.label || b.id}: ${b.remaining}${b.unit || ''}`);
    }
    for (const a of row.accounts || []) {
      if (a.error) continue;
      parts.push(`${a.name}: ${fmt(a.remaining)}${a.unit || ''}`);
    }
    say(`  ${head} ${parts.length ? parts.join('　') : `${C.dim}${row.reason || '无数据'}${C.reset}`}`);
  }
  say('─'.repeat(88));
  return 0;
}

// ---------------------------------------------------------------- combo

function cmdCombo(args) {
  ensureDataDirs();
  const sub = positional(args)[0] || 'list';
  const cfg = readJson(CONFIG_FILE, {}) || {};

  if (sub === 'add' || sub === 'set') {
    const name = flag(args, '--name', positional(args)[1]);
    const models = splitList(flag(args, '--models', null));
    if (!name || name === true) {
      say(`${C.bad} 用法：combo add --name fast --models trae-local/glm-5.3-flash,zcode/glm-5.3`);
      return 1;
    }
    if (!models.length) {
      say(`${C.bad} --models 不能为空（逗号分隔的 <供应商>/<模型> 或裸模型名）`);
      return 1;
    }
    const strategy = String(flag(args, '--strategy', 'fallback'));
    if (!COMBO_STRATEGIES.includes(strategy)) {
      say(`${C.bad} 未知策略 ${strategy}（可选：${COMBO_STRATEGIES.join('、')}）`);
      return 1;
    }
    const stickyLimit = Number(flag(args, '--sticky', 3)) || 3;
    const combos = normalizeCombos(cfg.combos);
    const id = comboId(name);
    const idx = combos.findIndex((c) => c.id === id);
    const entry = { id, name: String(name), models, strategy, stickyLimit };
    if (idx >= 0) combos[idx] = entry;
    else combos.push(entry);
    writeJsonAtomic(CONFIG_FILE, { ...cfg, combos });
    say(`${C.ok} ${idx >= 0 ? '已更新' : '已添加'}降级链 ${C.bold}${name}${C.reset} ${C.dim}${id}${C.reset}`);
    say(`${C.dim}  ${models.join(' → ')}（${strategy}）${C.reset}`);
    say(`${C.dim}  重启生效：node router.mjs gateway restart${C.reset}`);
    return 0;
  }

  if (sub === 'rm' || sub === 'remove') {
    const target = positional(args)[1];
    if (!target) {
      say(`${C.bad} 用法：combo rm <名字>`);
      return 1;
    }
    const combos = normalizeCombos(cfg.combos);
    const id = comboId(target);
    const next = combos.filter((c) => c.id !== id && c.name !== target && c.id !== target);
    if (next.length === combos.length) {
      say(`${C.bad} 没找到降级链 ${target}`);
      return 1;
    }
    writeJsonAtomic(CONFIG_FILE, { ...cfg, combos: next });
    say(`${C.ok} 已删除 ${target}`);
    say(`${C.dim}  重启生效：node router.mjs gateway restart${C.reset}`);
    return 0;
  }

  // list
  const combos = normalizeCombos(cfg.combos);
  if (!combos.length) {
    say(`${C.dim}还没有降级链。${C.reset}`);
    say(`${C.dim}  添加：node router.mjs gateway combo add --name fast --models trae-local/glm-5.3-flash,zcode/glm-5.3${C.reset}`);
    return 0;
  }
  say(`${C.bold}降级链${C.reset}  ${C.dim}${CONFIG_FILE}${C.reset}`);
  say('─'.repeat(96));
  for (const c of combos) {
    const tag = c.disabled ? `${C.dim}已禁用${C.reset}` : c.strategy === 'round-robin' ? `${C.ok}轮转${C.reset}` : `${C.ok}顺序${C.reset}`;
    say(`  ${pad(c.name, 18)} ${pad(c.id, 24)} ${pad(tag, 10)} ${c.models.join(' → ')}`);
  }
  say('─'.repeat(96));
  say(`${C.dim}  调用：model = combo:<名字>（或直接用名字）；重启生效${C.reset}`);
  return 0;
}

// ---------------------------------------------------------------- 本地应答

function cmdLocal(args) {
  ensureDataDirs();
  const cfg = readJson(CONFIG_FILE, {}) || {};
  const sub = positional(args)[0] || 'status';
  const all = ['quota', 'prefix', 'title', 'suggestion', 'filepath'];
  const current = cfg.localAnswers && typeof cfg.localAnswers === 'object' ? cfg.localAnswers : {};

  if (sub === 'off' || sub === 'on') {
    const target = positional(args)[1];
    if (!target || target === 'all') {
      const value = sub === 'on';
      writeJsonAtomic(CONFIG_FILE, {
        ...cfg,
        localAnswers: Object.fromEntries(all.map((k) => [k, value])),
      });
      say(`${C.ok} 已${value ? '开启' : '关闭'}全部本地应答`);
    } else {
      if (!all.includes(target)) {
        say(`${C.bad} 未知项 ${target}（可选：${all.join('、')}）`);
        return 1;
      }
      writeJsonAtomic(CONFIG_FILE, { ...cfg, localAnswers: { ...current, [target]: sub === 'on' } });
      say(`${C.ok} ${target} 已${sub === 'on' ? '开启' : '关闭'}`);
    }
    say(`${C.dim}  重启生效：node router.mjs gateway restart${C.reset}`);
    return 0;
  }

  say(`${C.bold}本地应答${C.reset}  ${C.dim}不调用上游、不消耗额度${C.reset}`);
  say('─'.repeat(72));
  const labels = {
    quota: '额度探测（max_tokens:1 + "quota"）',
    prefix: '权限提示的命令前缀',
    title: '会话标题生成',
    suggestion: '建议模式',
    filepath: '文件路径提取',
  };
  for (const k of all) {
    const on = current[k] !== false;
    say(`  ${pad(k, 14)} ${on ? `${C.ok}开${C.reset}` : `${C.dim}关${C.reset}`}  ${C.dim}${labels[k]}${C.reset}`);
  }
  say('─'.repeat(72));
  say(`${C.dim}  切换：gateway local on|off [${all.join('|')}]；重启生效${C.reset}`);
  return 0;
}

// ---------------------------------------------------------------- 免费供应商

async function cmdProviders(args) {
  ensureDataDirs();
  const sub = positional(args)[0] || 'list';
  const json = args.includes('--json');
  const store = loadProviderStore();

  const { activeProviders } = await import('./provider-keys.mjs');
  const { probeFree } = await import('./free-upstream.mjs');

  if (sub === 'list') {
    const rows = activeProviders(store);
    // 本机服务「有 key」不代表装了就绪：补一次轻量探测，把「可用」改成如实的三种状态。
    const { freeModelsOf } = await import('./free-upstream.mjs');
    const probed = await Promise.all(
      rows.map(async (r) => {
        if (!r.ok || !r.def.local) return r;
        const models = await freeModelsOf(r.def.id, { store, timeout: 1200 });
        return models.length
          ? r
          : { ...r, ok: false, reason: '本机服务没在跑（或没装）' };
      }),
    );
    if (json) {
      say(
        JSON.stringify(
          {
            providers: probed.map((r) => ({
              id: r.def.id,
              name: r.def.name,
              local: Boolean(r.def.local),
              format: r.def.format,
              baseUrl: r.baseUrl,
              env: r.def.env,
              keySource: keySource(r.def.id, store),
              ok: r.ok,
              reason: r.reason,
              free: r.def.free,
              freeModels: r.def.freeModels || [],
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const local = probed.filter((r) => r.def.local);
    const keyed = probed.filter((r) => !r.def.local);

    say(`${C.bold}免费供应商${C.reset}  ${C.dim}共 ${probed.length} 家：${local.length} 家本机免账号，${keyed.length} 家有免费额度（需 key）${C.reset}`);
    say('─'.repeat(104));
    say(`  ${pad('id', 16)} ${pad('名称', 20)} ${pad('状态', 10)} ${pad('key', 10)} 免费额度`);
    for (const r of probed) {
      const state = r.ok ? `${C.ok}可用${C.reset}` : `${C.dim}待配置${C.reset}`;
      const src = keySource(r.def.id, store);
      const keyLabel = r.def.local ? `${C.dim}免${C.reset}` : src === 'none' ? `${C.warn}缺${C.reset}` : `${C.ok}${src}${C.reset}`;
      say(`  ${pad(r.def.id, 16)} ${pad(r.def.name, 20)} ${pad(state, 10)} ${pad(keyLabel, 10)} ${C.dim}${truncate(r.def.free, 40)}${C.reset}`);
    }
    say('─'.repeat(104));
    const ready = probed.filter((r) => r.ok).length;
    say(`  ${ready}/${probed.length} 可用`);
    if (ready < probed.length) {
      say(`${C.dim}  配 key：node router.mjs providers key <id> <key>${C.reset}`);
      say(`${C.dim}  或设环境变量（见 providers show <id>）${C.reset}`);
    }
    return 0;
  }

  if (sub === 'show') {
    const id = positional(args)[1];
    const def = FREE_BY_ID.get(id);
    if (!def) {
      say(`${C.bad} 未知供应商 ${id}（可选：${FREE_PROVIDERS.map((p) => p.id).join('、')}）`);
      return 1;
    }
    say(`${C.bold}${def.name}${C.reset}  ${C.dim}${def.id}${C.reset}`);
    say('─'.repeat(80));
    say(`  线协议    ${def.format}`);
    say(`  baseUrl   ${def.baseUrl}`);
    if (def.needs) say(`  ${C.warn}注意${C.reset}      ${def.needs}`);
    say(`  免费额度  ${def.free}`);
    if (def.local) {
      say(`  key       ${C.ok}不需要（本机服务）${C.reset}`);
      if (def.baseUrlEnv) say(`  可覆盖    ${def.baseUrlEnv}=http://127.0.0.1:<port>/v1`);
    } else {
      say(`  环境变量  ${def.env || '（未声明）'}`);
      say(`  申请页面  ${def.keyUrl || '（未声明）'}`);
      say(`  key 来源  ${keySource(def.id, store)}`);
    }
    if ((def.freeModels || []).length) {
      say(`  免费模型  ${def.freeModels.join('、')}`);
    }
    say('─'.repeat(80));
    say(`${C.dim}  配 key：node router.mjs providers key ${def.id} <key>${C.reset}`);
    return 0;
  }

  if (sub === 'key' || sub === 'set-key') {
    const id = positional(args)[1];
    const value = positional(args)[2];
    if (!id) {
      say(`${C.bad} 用法：providers key <id> <key>（空字符串 = 清除）`);
      return 1;
    }
    const def = FREE_BY_ID.get(id);
    if (!def) {
      say(`${C.bad} 未知供应商 ${id}（可选：${FREE_PROVIDERS.map((p) => p.id).join('、')}）`);
      return 1;
    }
    if (def.local) {
      say(`${C.dim}${def.name} 是本机服务，不需要 key${C.reset}`);
      return 0;
    }
    try {
      const r = setProviderKey(id, value ?? '', { baseUrl: flag(args, '--base-url', null) || undefined });
      if (!value) {
        say(`${C.ok} 已清除 ${def.name} 的 key`);
      } else if (r.stored === 'vault') {
        say(`${C.ok} ${def.name} 的 key 已加密写入 ${C.dim}${PROVIDERS_FILE}${C.reset}`);
      } else {
        say(`${C.ok} ${def.name} 的 key 已写入`);
        if (r.warning) say(`${C.warn} ${r.warning}${C.reset}`);
      }
      say(`${C.dim}  验证：node router.mjs providers test ${id}${C.reset}`);
      return 0;
    } catch (err) {
      say(`${C.bad} ${err.message}`);
      return 1;
    }
  }

  if (sub === 'rm' || sub === 'remove') {
    const id = positional(args)[1];
    if (!id) {
      say(`${C.bad} 用法：providers rm <id>`);
      return 1;
    }
    say(removeProvider(id) ? `${C.ok} 已移除 ${id} 的配置` : `${C.dim}${id} 本来就没有配置`);
    // 写成 pi provider 时 key 是落盘的；配置删了还留着 provider，等于留一份坏凭据。
    const { removePiProviders } = await import('../scripts/lib/pi-sync.mjs');
    const pis = removePiProviders([id]);
    if (pis.removed.length) say(`${C.ok} 已从 pi 移除 ${id}`);
    return 0;
  }

  if (sub === 'test') {
    const wanted = positional(args).slice(1);
    const deep = args.includes('--deep');
    const targets = wanted.length ? wanted : activeProviders(store).map((r) => r.def.id);
    let failed = 0;
    for (const id of targets) {
      const def = FREE_BY_ID.get(id);
      if (!def) {
        say(`${C.bad} 未知供应商 ${id}`);
        failed += 1;
        continue;
      }
      const r = await probeFree(id, { store, deep });
      if (r.ok) {
        const note = r.verified ? `${C.ok}key 已验证${C.reset}` : `${C.dim}地址通（未验 key）${C.reset}`;
        say(`${C.ok} ${pad(def.name, 22)} ${r.models.length} 个模型  ${note}`);
      } else {
        say(`${C.warn} ${pad(def.name, 22)} ${r.reason}`);
        failed += 1;
      }
    }
    if (!deep && !failed) {
      say(`${C.dim}  注意：多数上游的 /models 不校验 key，所以这只证明地址通。${C.reset}`);
      say(`${C.dim}  真要验 key：providers test <id> --deep（会花一次最小生成）${C.reset}`);
    }
    return failed ? 1 : 0;
  }

  if (sub === 'install' || sub === 'sync') {
    // 把可用的免费供应商写成 opencode provider + pi models
    const wanted = positional(args).slice(1);
    const rows = activeProviders(store).filter((r) => r.ok && (!wanted.length || wanted.includes(r.def.id)));
    if (!rows.length) {
      say(`${C.bad} 没有可用的免费供应商（先配 key：node router.mjs providers key <id> <key>）`);
      return 1;
    }
    const mod = requireShared('opencode-config.js');
    if (!mod) {
      say(`${C.bad} 找不到 opencode-config.js`);
      return 1;
    }
    const providers = [];
    const piEntries = [];
    const skipped = [];
    for (const r of rows) {
      const { freeModelsOf } = await import('./free-upstream.mjs');
      const models = await freeModelsOf(r.def.id, { force: true, store });
      if (!models.length) {
        skipped.push(`${r.def.id}（拿不到模型清单）`);
        continue;
      }
      providers.push({
        id: r.def.id,
        name: r.def.name,
        baseURL: r.baseUrl,
        apiKey: r.key || 'local',
        models: mod.toOpencodeModels(models.map((m) => ({ id: m.id, name: m.name, context_window: m.context }))),
      });
      // pi 侧同一份数据，模型名与 baseURL 不变（直连上游，与 opencode 同口径）
      piEntries.push({ id: r.def.id, name: r.def.name, baseURL: r.baseUrl, apiKey: r.key || 'local', models });
    }
    if (!providers.length) {
      say(`${C.bad} 一家都写不进去${skipped.length ? `：${skipped.join('、')}` : ''}`);
      return 1;
    }
    const result = mod.mergeProviders(providers);
    for (const p of result.added) say(`${C.ok} ${pad(p.name, 22)} ${p.models} 个模型 → opencode`);
    if (result.backup) say(`${C.dim}  备份：${result.backup}${C.reset}`);

    const { freePiProvider, mergePiProviders } = await import('../scripts/lib/pi-sync.mjs');
    const pi = mergePiProviders(piEntries.map((p) => freePiProvider(p)));
    if (pi.added.length) {
      for (const p of pi.added) say(`${C.ok} ${pad(p.id, 22)} ${p.models} 个模型 → pi`);
      if (pi.backup) say(`${C.dim}  pi 备份：${pi.backup}${C.reset}`);
    } else {
      say(`${C.dim}pi 里这些 provider 已是最新${C.reset}`);
    }

    for (const s of skipped) say(`${C.warn} 跳过 ${s}`);
    say(`${C.dim}  走网关也行：node router.mjs gateway install（统一入口，含本机 9 家）${C.reset}`);
    return 0;
  }

  say(`用法：node router.mjs providers <命令>

  list [--json]              列出 18 家免费供应商与可用状态
  show <id>                  看一家的详情（baseUrl / 免费额度 / key 从哪来）
  key <id> <key>             配置 key（加密写入 data/providers.json；空串 = 清除）
  rm <id>                    移除配置
  test [id...]               探活：拉一次模型列表验证 key
  install [id...]            把可用的写成 opencode + pi provider

本机免账号：${FREE_PROVIDERS.filter((p) => p.local).map((p) => p.id).join('、')}
有免费额度：${FREE_PROVIDERS.filter((p) => !p.local).map((p) => p.id).join('、')}`);
  return 1;
}

function truncate(text, width) {
  const s = String(text || '');
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

// ---------------------------------------------------------------- doctor

async function cmdDoctor() {
  let issues = 0;
  say(`${C.bold}网关自检${C.reset}`);
  say('─'.repeat(88));
  say(`  ${C.ok} node ${process.version}`);
  say(`  ${C.ok} 数据目录 ${DATA_DIR}`);

  try {
    ensureDataDirs();
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    say(`  ${C.ok} 数据目录可写`);
  } catch (e) {
    say(`  ${C.bad} 数据目录不可写：${e.message}`);
    issues += 1;
  }

  const cfg = loadConfig();
  say(`  ${C.ok} 配置 ${path.join(DATA_DIR, 'config.json')}（strict=${cfg.strict}，最多换 ${cfg.settings.maxAttempts} 家）`);

  const db = loadKeyDb();
  say(`  ${C.ok} 密钥库 ${db.keys.length} 个${db.keys.length ? '' : '（回环免密钥可用）'}`);

  const quota = readJson(path.join(DATA_DIR, 'quota.json'), null);
  if (quota?.at) {
    const age = Math.round((Date.now() - quota.at) / 60_000);
    say(`  ${age > 30 ? C.warn : C.ok} 额度快照 ${age} 分钟前（>30 分钟不参与权重）`);
  } else {
    say(`  ${C.warn} 没有额度快照，权重按「额度未知」处理（不影响转发）`);
  }

  const ids = enabledIds();
  for (const id of ids) {
    const models = await modelsOf(id);
    const key = upstreamKeyFor(id);
    if (models.length) {
      say(`  ${C.ok} ${pad(id, 20)} :${BY_ID.get(id).port}  ${models.length} 个模型  ${key ? `key ${key.slice(0, 8)}…` : '无 key'}`);
    } else {
      say(`  ${C.warn} ${pad(id, 20)} :${BY_ID.get(id).port}  拿不到模型清单（没起？）`);
    }
  }

  const probe = await gatewayFetch('/health').catch(() => null);
  if (probe?.ok) say(`  ${C.ok} 网关在 http://${HOST}:${PORT}`);
  else say(`  ${C.warn} 网关未启动：node router.mjs up gateway`);

  say('─'.repeat(88));
  if (issues === 0) say(`${C.ok} 自检通过`);
  else say(`${C.warn} ${issues} 项需要处理`);
  return issues ? 1 : 0;
}

// ---------------------------------------------------------------- 快照（给 router 用）

/**
 * 采集各家额度并写 `data/quota.json`，让调度器把「余额比例」算进权重。
 * 由 `router.mjs gateway refresh-quota` 调用；失败只报错，不写坏文件。
 */
export async function refreshQuotaSnapshot() {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const candidates = [
    path.join(import.meta.dirname, '..', 'integrations', 'qodbuddy2pi', 'assets', 'quota.js'),
  ];
  let mod = null;
  for (const file of candidates) {
    try {
      fs.accessSync(file);
      mod = req(file);
      break;
    } catch {}
  }
  if (!mod) throw new Error('找不到 quota.js');
  const ids = enabledIds();
  const rows = await mod.collectAll({ only: ids });
  const pools = {};
  for (const row of rows) {
    if (!row.available) continue;
    let remaining = 0;
    let total = 0;
    for (const b of row.buckets || []) {
      if (b.unit !== 'credits' && b.unit !== 'tokens') continue;
      remaining += Number(b.remaining) || 0;
      total += Number(b.total) || 0;
    }
    for (const a of row.accounts || []) {
      if (a.error) continue;
      if (a.unit !== 'credits' && a.unit !== 'tokens') continue;
      remaining += Number(a.remaining) || 0;
      total += Number(a.total) || 0;
    }
    pools[row.provider] = {
      remaining,
      total: total || null,
      ratio: total > 0 ? Math.min(1, Math.max(0, remaining / total)) : null,
      unit: row.buckets?.[0]?.unit || row.accounts?.[0]?.unit || 'credits',
    };
  }
  const snapshot = { at: Date.now(), pools };
  writeJsonAtomic(path.join(DATA_DIR, 'quota.json'), snapshot);
  return snapshot;
}

// ---------------------------------------------------------------- 入口

const COMMANDS = { key: cmdKey, status: cmdStatus, usage: cmdUsage, balance: cmdBalance, doctor: cmdDoctor, combo: cmdCombo, local: cmdLocal, providers: cmdProviders };

export async function main(argv = process.argv.slice(2)) {
  const cmd = (argv[0] || 'status').toLowerCase();
  const args = argv.slice(1);
  if (cmd === 'refresh-quota') {
    const snap = await refreshQuotaSnapshot();
    say(`${C.ok} 额度快照已写入（${Object.keys(snap.pools).length} 家）`);
    return 0;
  }
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    say(`用法：node router.mjs gateway <命令>

  key add --name dev --providers trae-local,zcode --days 30 [--quota 2000000]
  key list / key rm <id> / key disable <id> / key reset-usage
  combo add --name fast --models trae-local/glm-5.3-flash,zcode/glm-5.3 [--strategy fallback|round-robin]
  combo list / combo rm <名字>      降级链：一个名字 = 一条有序链
  local [on|off] [quota|prefix|title|suggestion|filepath|all]
                                   本地应答开关（省额度）
  status [--json]          调度快照：权重、冷却、并发、粘性
  usage [--days 7] [--json] 用量聚合（网关没跑也能读本地 JSONL）
  balance [provider...]    各家额度（经网关的采集器）
  doctor                   自检
  refresh-quota            采集额度并写 data/quota.json（影响调度权重）`);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    say(`${C.bad} 未知命令：${cmd}`);
    return 1;
  }
  return fn(args);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    say(`${C.bad} ${e.stack || e.message}`);
    process.exit(1);
  });
}
