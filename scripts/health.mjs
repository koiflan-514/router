#!/usr/bin/env node
/**
 * health.mjs — 一键体检：端口、模型数、凭证有效期、端到端试打。
 *
 * 只读不改：不写任何配置文件、不改任何凭证。可以随时跑。
 *
 *   node health.mjs              # 全部检查
 *   node health.mjs --no-probe   # 跳过真实对话（省额度）
 *   node health.mjs qoder-cn     # 只查一个
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const PI_AUTH = path.join(HOME, '.pi', 'agent', 'auth.json');

/** 所有已知 endpoint。加新供应商就在这里加一行。 */
const SOURCES = [
  {
    id: 'qoder-cn',
    title: 'Qoder 国内版',
    url: 'http://127.0.0.1:8789/v1',
    modelsPath: '/models',
    authFile: PI_AUTH,
    authKey: 'qoder-cn',
    expiry: (a) => a.expires,
    probeModel: 'Qwen3.8-Flash',
  },
  {
    id: 'qoder',
    title: 'Qoder 国际版',
    url: 'http://127.0.0.1:8790/v1',
    modelsPath: '/models',
    authFile: PI_AUTH,
    authKey: 'qoder',
    expiry: (a) => a.expires,
    probeModel: 'Qwen3.8-Flash',
  },
  {
    id: 'codearts',
    title: 'CodeArts Agent',
    url: 'http://127.0.0.1:10087/v1',
    modelsPath: '/models',
    // 第三方 Go 网关；凭证由它自己从 IDE 的 state.vscdb 解密并续期
    authFile: null,
    // 签发密钥后 /v1/models 也要鉴权，key 从 pi 的 models.json 取
    probeModel: 'deepseek-v4.1-flash',
  },
  {
    id: 'trae-local',
    title: 'Trae',
    url: 'http://127.0.0.1:7863/v1',
    modelsPath: '/models',
    // 第三方反代，凭证不在本项目管
    authFile: null,
    probeModel: 'glm-5.3-flash',
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy 国内版',
    url: 'http://127.0.0.1:8787/v1',
    modelsPath: '/models',
    authFile: path.join(HOME, '.codebuddy-session.json'),
    expiry: (a) => a.auth && a.auth.expiresAt,
    probeModel: 'deepseek-v4-flash',
  },
  {
    id: 'workbuddy-global',
    title: 'WorkBuddy 国际版',
    url: 'http://127.0.0.1:8788/v1',
    modelsPath: '/models',
    authFile: path.join(HOME, '.codebuddy-global-session.json'),
    expiry: (a) => a.auth && a.auth.expiresAt,
    probeModel: 'deepseek-v4.1-flash',
  },
];

const C = {
  ok: '\x1b[1;32m✓\x1b[0m',
  bad: '\x1b[1;31m✗\x1b[0m',
  warn: '\x1b[1;33m!\x1b[0m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function getJson(url, timeout = 6000, apiKey) {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    const t = await r.text();
    try {
      return { ok: r.ok, status: r.status, json: JSON.parse(t) };
    } catch {
      return { ok: r.ok, status: r.status, json: null };
    }
  } catch (e) {
    return { ok: false, status: 0, error: e.code || e.message };
  }
}

/** 反代的模型列表有三种形状：{data:[]} / {models:[]} / []。 */
function modelIds(json) {
  if (!json) return [];
  const arr = Array.isArray(json) ? json : json.data || json.models || [];
  return arr.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
}

/**
 * 试打一次对话。对「排队中」（10605 / isQueued）自动重试：
 * 那是免费账号的并发上限，隔十几秒再发通常就成功，不该报成故障。
 * 见 docs/02-pitfalls.md P16。
 */
async function probe(url, model, apiKey, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await probeOnce(url, model, apiKey);
    if (r.ok) return r;
    if (!/10605|isQueued/.test(r.detail || '')) return r;
    if (attempt < retries) {
      console.log(`   ${C.warn} ${model} 排队中（第 ${attempt + 1} 次），20 秒后重试`);
      await new Promise((res) => setTimeout(res, 20000));
    } else {
      return { ...r, detail: `${r.detail}（重试 ${retries} 次仍排队）` };
    }
  }
}

async function probeOnce(url, model, apiKey) {
  const t0 = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 16,
        // 国际站要求首条是 system，统一带上，对所有供应商都无害
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Say only: ok' },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) {
      // 尽量把业务错误码提出来（WorkBuddy 是 11128 这种）
      let code = '';
      try {
        const j = JSON.parse(text);
        code = (j.error && j.error.message) || j.code || '';
        const inner = typeof code === 'string' ? JSON.parse(code) : code;
        if (inner && inner.code) code = `code ${inner.code}: ${inner.msg || ''}`;
      } catch {}
      return { ok: false, ms, detail: `HTTP ${r.status} ${String(code).slice(0, 120)}` };
    }
    let out = '';
    try {
      const j = JSON.parse(text);
      out = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || '' : '';
    } catch {}
    return { ok: true, ms, detail: out.trim().slice(0, 40) || '(空回复)' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: e.code || e.message };
  }
}

/**
 * 从 pi 的 models.json 里取该 provider 的 apiKey。
 * Trae 这类第三方反代要求 /v1/models 也鉴权，没有 key 会被判 401。
 */
function keyFor(providerId) {
  const cfg = readJson(path.join(HOME, '.pi', 'agent', 'models.json'));
  const p = cfg && cfg.providers && cfg.providers[providerId];
  return p && p.apiKey ? p.apiKey : null;
}

function fmtDays(ms) {
  if (!ms) return null;
  const n = typeof ms === 'number' && ms < 1e12 ? ms * 1000 : Number(ms);
  if (!Number.isFinite(n)) return null;
  return Math.floor((n - Date.now()) / 86400000);
}

async function main() {
  const args = process.argv.slice(2);
  const noProbe = args.includes('--no-probe');
  const only = args.filter((a) => !a.startsWith('--'));

  const list = only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  let bad = 0;

  console.log('AI 路由体检');
  console.log('─'.repeat(62));

  for (const s of list) {
    // 有的反代要求 /v1/models 也带 key（Trae 的 trae2api 就是），401 说明服务是活的
    const apiKey = keyFor(s.id);
    const health = await getJson(`${s.url}${s.modelsPath}`, 6000, apiKey);
    const ids = modelIds(health.json);
    const reachable = health.ok || ids.length > 0 || health.status === 401 || health.status === 403;

    let line = `${reachable ? C.ok : C.bad} ${s.title.padEnd(18)} ${s.url}`;
    if (reachable && ids.length === 0 && (health.status === 401 || health.status === 403)) {
      line += `  ${C.dim}服务在线（列表需鉴权）${C.reset}`;
    } else if (reachable) {
      line += `  ${C.dim}${ids.length} 个模型${C.reset}`;
    } else {
      bad += 1;
      line += `  ${C.bad} 不可达 (${health.error || `HTTP ${health.status}`})${C.reset}`;
    }
    console.log(line);

    // 凭证有效期
    if (s.authFile && s.expiry) {
      const a = readJson(s.authFile);
      if (!a) {
        console.log(`   ${C.warn} 凭证文件不存在：${s.authFile}`);
      } else {
        const entry = s.authKey ? a[s.authKey] : a;
        if (!entry) {
          console.log(`   ${C.warn} 凭证里没有 ${s.authKey}`);
        } else {
          const days = fmtDays(s.expiry(entry));
          if (days === null) console.log(`   ${C.dim}凭证：到期时间未知`);
          else if (days < 0) {
            console.log(`   ${C.bad} 凭证已过期 ${-days} 天`);
            bad += 1;
          } else if (days < 3) console.log(`   ${C.warn} 凭证剩 ${days} 天，建议尽快续期`);
          else console.log(`   ${C.dim}凭证剩 ${days} 天`);
        }
      }
    }

    // 端到端试打
    if (!noProbe && reachable) {
      const model = s.probeModel || ids[0];
      if (!model) {
        console.log(`   ${C.warn} 没有可用模型可试打`);
      } else {
        const r = await probe(s.url, model, apiKey);
        if (r.ok) {
          console.log(`   ${C.ok} 试打 ${model} → ${r.detail} ${C.dim}(${r.ms}ms)${C.reset}`);
        } else if (/429|10605|isQueued|排队/.test(r.detail || '')) {
          // 排队不是故障：免费账号并发受限，服务本身是好的。
          // 报成 ✗ 会让人去改配置（改了也没用，见 P16）。
          console.log(`   ${C.warn} 试打 ${model}：排队限流（服务可用，稍后重试）`);
          console.log(`   ${C.dim}${r.detail.slice(0, 150)}${C.reset}`);
        } else {
          console.log(`   ${C.bad} 试打 ${model} 失败：${r.detail}`);
          bad += 1;
        }
      }
    }
  }

  console.log('─'.repeat(62));
  if (bad === 0) console.log(`${C.ok} 全部通过`);
  else console.log(`${C.warn} ${bad} 项需要处理`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
