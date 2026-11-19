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

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const PI_AUTH = path.join(HOME, '.pi', 'agent', 'auth.json');

/** Loomy 桌面端的登录态文件；hash 规则与 Loomy 的 config-path.js 一致。 */
function loomyAuthFile() {
  const explicit = String(process.env.LOOMY_AUTH_FILE || '').trim();
  if (explicit) return explicit;
  const override = String(process.env.LOOMY_CONFIG_ROOT || '').trim();
  const root = override || (process.platform === 'win32'
    ? path.join('C:', 'Users', 'Public', 'Loomy', crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12))
    : path.join(HOME, '.config', 'loomy'));
  for (const file of [path.join(root, 'userData', 'auth-session.json'), path.join(HOME, '.config', 'loomy', 'auth-session.json')]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return path.join(root, 'userData', 'auth-session.json');
}

function maskPhone(phone) {
  const s = String(phone || '').trim();
  if (s.length < 7) return s ? `${s.slice(0, 2)}***` : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 商汤小浣熊桌面端把 IAM token 写在 agent/config/auth.json（旧版在 ~/.box-agent）。 */
function raccoonAuthFile() {
  const explicit = String(process.env.RACCOON_AUTH_FILE || '').trim();
  if (explicit) return explicit;
  for (const file of [
    path.join(HOME, '.office-raccoon', 'agent', 'config', 'auth.json'),
    path.join(HOME, '.box-agent', 'config', 'auth.json'),
  ]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return path.join(HOME, '.office-raccoon', 'agent', 'config', 'auth.json');
}

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
{
    id: 'zcode',
    title: 'ZCode (Z.ai)',
    url: 'http://127.0.0.1:20131/v1',
    modelsPath: '/models',
    // 凭据在 accounts.json 或 ~/.zcode 的桌面端凭据里，到期由 router account 判
    authFile: null,
    probeModel: 'glm-5.3-flash',
  },
  {
    id: 'loomy',
    title: 'Loomy（讯飞）',
    url: 'http://127.0.0.1:8791/v1',
    // 生图模型不能走 chat/completions，体检只看对话模型
    modelsPath: '/models?type=chat',
    // Loomy 的登录态由桌面端写，没有命令行续期
    sessionAuthFile: loomyAuthFile(),
    // spark-x2.6 是 reasoning 模型，短试打会把 token 全花在思考上；auto 会选一个
    // 能直接回答的对话模型（少量积分）。
    probeModel: 'auto',
  },
  {
    id: 'raccoon',
    title: '商汤小浣熊',
    url: 'http://127.0.0.1:8793/v1',
    modelsPath: '/models',
    // IAM token 由桌面端写入；没有命令行续期，token 到期靠桌面端刷新
    authFile: raccoonAuthFile(),
    expiry: (a) => {
      const token = String((a && a.access_token) || '');
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload && payload.exp ? Number(payload.exp) * 1000 : null;
      } catch {
        return null;
      }
    },
    // 用最便宜的对话模型试打；raccoon-* 是桌面端默认的通用模型
    probeModel: 'sn-glm-5-3-flash',
  },
  {
    id: 'qwenwork',
    title: '千问办公',
    url: 'http://127.0.0.1:8794/v1',
    modelsPath: '/models',
    // 推理凭据在 Electron 的 OSCrypt 容器里，由反代自己解密并续期；
    // 体检只探反代端口与试打，不重复实现那一层。
    authFile: null,
    // flash 是桌面端默认的「标准」模式，最便宜
    probeModel: 'flash',
  },
  {
    id: 'dumate',
    title: '百度搭子',
    url: 'http://127.0.0.1:8795/v1',
    modelsPath: '/models',
    // 登录态在 DuMate 桌面端的 auth.json（没有到期时间）；反代自己读它，
    // 体检这里只确认账号还在。main-server 的随机端口由反代发现，不在这里探。
    profileFile: path.join(
      process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
      'qianfan-desktop-app',
      'auth.json',
    ),
    // 桌面端目录里的通用模型；glm-5 是最稳的一个
    probeModel: 'glm-5',
  },
  {
    id: 'gateway',
    title: '统一网关',
    url: 'http://127.0.0.1:8785/v1',
    modelsPath: '/models',
    // 网关自己不持有凭证：它靠下面十家的凭证工作，所以这里没有 authFile。
    // 它没起来不影响十家任何一家，所以体检里只报「未开」而不是错误。
    authFile: null,
    // 打裸模型名：网关会在所有能提供它的供应商里挑一家，顺带验证了调度
    probeModel: 'glm-5.3-flash',
    optional: true,
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

/**
 * 客户端实际能选的模型数。
 *
 * WorkBuddy 反代的 /v1/models 是静态表，和 pi/opencode 的真实目录对不上
 * （docs/02-pitfalls.md P3）。表格里报客户端的数量，避免 23 vs 31 的假象。
 */
function clientModelCount(providerId) {
  const dir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
    : path.join(HOME, '.config', 'opencode');
  const cfg = readJson(path.join(dir, 'opencode.json'));
  const models = cfg && cfg.provider && cfg.provider[providerId] && cfg.provider[providerId].models;
  return models && typeof models === 'object' ? Object.keys(models).length : null;
}

/** Trae 的 /v1/models 混着内部子代理，客户端实际不会把它们列出来。 */
function usableModelIds(providerId, ids) {
  if (providerId !== 'trae-local') return ids;
  return ids.filter((id) => !/^custom_model|_(sub)?agent(_v\d)?$|^summary$|^computer_use|^browser_use|^file_search/.test(id));
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
        max_tokens: 64,
        // Loomy 的 spark-x2.6 是 reasoning 模型：16 token 会全花在思考上，回复为空。
        // 短试打统一软关推理；未知字段对其它 OpenAI 兼容上游是 noop。
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
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
    const ids = usableModelIds(s.id, modelIds(health.json));
    const reachable = health.ok || ids.length > 0 || health.status === 401 || health.status === 403;
    const count = s.id.startsWith('workbuddy') ? (clientModelCount(s.id) ?? ids.length) : ids.length;

    const mark = reachable ? C.ok : s.optional ? `${C.dim}-${C.reset}` : C.bad;
    let line = `${mark} ${s.title.padEnd(18)} ${s.url}`;
    if (reachable && ids.length === 0 && (health.status === 401 || health.status === 403)) {
      line += `  ${C.dim}服务在线（列表需鉴权）${C.reset}`;
    } else if (reachable) {
      line += `  ${C.dim}${count} 个模型${C.reset}`;
    } else {
      // optional 的条目（统一网关、免费供应商）没起不算故障：
      // 它们默认就是关的，报成「需要处理」只会训练人忽略这条汇总。
      if (s.optional) line += `  ${C.dim}未启动（可选）${C.reset}`;
      else {
        bad += 1;
        line += `  ${C.bad} 不可达 (${health.error || `HTTP ${health.status}`})${C.reset}`;
      }
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

    // 会话型登录态（Loomy）：文件里没有到期时间，只能确认 token 非空
    if (s.sessionAuthFile) {
      const a = readJson(s.sessionAuthFile);
      if (!a || !String(a.session || '').trim()) {
        console.log(`   ${C.warn} 未登录：${s.sessionAuthFile}（打开桌面端登录后自动生效）`);
      } else {
        const who = maskPhone(a.phone) || (a.userid ? `user ${String(a.userid).slice(0, 8)}…` : '已登录');
        console.log(`   ${C.dim}登录态：${who}${C.reset}`);
      }
    }

    // 百度搭子：auth.json 只有账号列表，没有到期时间
    if (s.profileFile) {
      const a = readJson(s.profileFile);
      const profiles = (a && Array.isArray(a.accountProfiles) && a.accountProfiles) || [];
      if (!profiles.length) {
        console.log(`   ${C.warn} 未登录：${s.profileFile}（打开百度搭子桌面端登录后自动生效）`);
      } else {
        const p = profiles.find((x) => x && x.profileId === a.activeProfileId) || profiles[0];
        console.log(`   ${C.dim}登录态：${(p && p.displayName) || '已登录'}${C.reset}`);
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
