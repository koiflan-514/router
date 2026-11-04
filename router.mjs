#!/usr/bin/env node
/**
 * router.mjs — 统一启动、停止、重启、探活本机所有反代。
 *
 * 六家全常驻会同时挂着 7 个子进程（Trae 两段式），而多数时候你只用其中一两个。这里让
 * 「开哪几个」变成一个显式选择，并且这个选择要落到三处，缺一处就会出现
 * 「以为关了其实还在跑」或「以为开了但客户端看不到」：
 *
 *   1. 后端进程（代理/反代）—— 真正干活的那一层
 *   2. pi 的模型可见性     —— provider 注册与模型目录
 *   3. opencode 的 provider —— 写进 opencode.json 的那份
 *
 * 从 2026-11 起，router 直接托管全部六家反代，不再依赖 qoder2pi /
 * workbuddy2pi 的计划任务来拉起进程（计划任务在本机并不总是可靠）：
 *
 *   - 每家的命令行、环境变量、日志、端口都写在 PROVIDERS 里
 *   - PID 与启动信息落在 .run/processes.json
 *   - 停止时按「PID 树 + 监听端口」双重清理，避免 Windows 上常见的
 *     「停了包装进程、子进程还在监听」
 *   - 登录自启用 `service install` 生成 router-<id> 计划任务
 *
 * qoder2pi / workbuddy2pi 仍用于登录、切账号、续期，以及 WorkBuddy 写 opencode
 * 时读取 pi 的模型清单；启动和停止不再经过它们。
 *
 * 用法：
 *   node router.mjs list                 看各家状态与开关
 *   node router.mjs up / start           按当前选择启动（也可以带 id）
 *   node router.mjs down / stop          停止（不带 id 时停全部）
 *   node router.mjs restart [id...]      重启
 *   node router.mjs logs <id> [行数]     看日志尾部
 *   node router.mjs on qoder-cn trae     只开这两家（其余关掉）
 *   node router.mjs off workbuddy        额外关掉某几家
 *   node router.mjs all / none           全开 / 全关
 *   node router.mjs reload               改完选择后重放一次（down + up）
 *   node router.mjs service ...          登录自启（Windows 计划任务）
 *   node router.mjs doctor               自检
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// 本文件是 ESM（.mjs），而 E:\qodbuddy2pi 里的共享模块是 CommonJS，
// 所以 require 要经由 createRequire 拿回来——同一套加载器不能混用。
const require = createRequire(import.meta.url);

const WIN = process.platform === 'win32';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HOME = os.homedir();
const STATE_FILE = path.join(HERE, 'router.json');
const RUN_DIR = path.join(HERE, '.run');
const PROCESS_FILE = path.join(RUN_DIR, 'processes.json');

/** 优先用仓库内整合进来的源码；旧的外部目录只作迁移期兜底。 */
function localOr(local, fallback) {
  try {
    if (fs.existsSync(local)) return local;
  } catch {}
  return fallback;
}

const INTEGRATIONS_DIR = path.join(HERE, 'integrations');
const QODBUDDY_REPO =
  process.env.QODBUDDY_REPO || localOr(path.join(INTEGRATIONS_DIR, 'qodbuddy2pi'), 'E:\\qodbuddy2pi');
const TRAE_DIR =
  process.env.ROUTER_TRAE_DIR ||
  localOr(path.join(INTEGRATIONS_DIR, 'traework2api'), 'E:\\trae-free-credits\\1-traework2api');
const CODEARTS_DIR =
  process.env.ROUTER_CODEARTS_DIR || localOr(path.join(INTEGRATIONS_DIR, 'codearts2api'), path.join(HOME, 'codearts2api'));

// 登录态的文件位置。只读/只写这些文件，不通过日志或表格输出 token。
const PI_AUTH_FILE = path.join(HOME, '.pi', 'agent', 'auth.json');
const CODEARTS_DATA_FILE = path.join(CODEARTS_DIR, 'codearts2api-data.json');
const WORKBUDDY_LIVE_FILES = {
  workbuddy: path.join(HOME, '.codebuddy-session.json'),
  'workbuddy-global': path.join(HOME, '.codebuddy-global-session.json'),
};

// ---------------------------------------------------------------- 输出

const C = {
  ok: '\x1b[1;32m✓\x1b[0m',
  bad: '\x1b[1;31m✗\x1b[0m',
  warn: '\x1b[1;33m!\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

const say = (...a) => console.log(...a);
const ok = (m) => say(`${C.ok} ${m}`);
const bad = (m) => say(`${C.bad} ${m}`);
const warn = (m) => say(`${C.warn} ${m}`);
const dim = (m) => `${C.dim}${m}${C.reset}`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** 去掉 ANSI 序列后的可见长度。表格对齐必须按它算，否则带色的单元格会错列。 */
const visibleWidth = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** 按可见宽度左侧补齐（含中日韩宽字符按 2 列计）。 */
function padEnd(text, width) {
  let w = 0;
  for (const ch of text.replace(/\x1b\[[0-9;]*m/g, '')) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 读 .env 一类的 KEY=VALUE 文件；值两侧的引号会去掉。 */
function readDotEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

/** 优先返回存在的可执行文件；都不存在时返回第一个候选，让报错信息能指出该放到哪。 */
function resolveExecutable(dir, names) {
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return path.join(dir, names[0]);
}

/** 从 pi 的 models.json 取该 provider 的 apiKey（反代列表接口常要鉴权）。 */
function keyFor(providerId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.pi', 'agent', 'models.json'), 'utf8'));
    const p = cfg && cfg.providers && cfg.providers[providerId];
    return p && p.apiKey ? p.apiKey : null;
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 到期时间只用于提示，不参与「是否已登录」的判断。 */
function expiryLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const days = Math.ceil((n - Date.now()) / 86400000);
  return days < 0 ? '，已过期' : `，剩 ${days} 天`;
}

function shortUser(id) {
  return id ? `userID ${String(id).slice(0, 8)}…` : '已登录';
}

function qoderAuth(provider) {
  const entry = (readJsonFile(PI_AUTH_FILE) || {})[provider];
  if (!entry || !entry.access) return { ok: false, label: '未登录（auth.json 里没有 access）' };
  return { ok: true, label: `已登录（${shortUser(entry.userID)}${expiryLabel(entry.expires)}）` };
}

function workbuddyAuth(id) {
  const live = readJsonFile(WORKBUDDY_LIVE_FILES[id]);
  const token = live && live.auth && live.auth.accessToken;
  if (typeof token !== 'string' || !token) return { ok: false, label: '未登录（无生效凭证）' };
  const who = (live.account && (live.account.nickname || live.account.uid)) || '已登录';
  return { ok: true, label: `已登录（${who}${expiryLabel(live.auth.expiresAt)}）` };
}

function traeAuth() {
  const dir = path.join(TRAE_DIR, 'auths');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^trae-.*\.json$/i.test(f));
  } catch {}
  for (const file of files) {
    const d = readJsonFile(path.join(dir, file));
    if (d && d.auth && d.auth.accessToken) {
      const who = (d.account && (d.account.nickname || d.account.uid)) || '已登录';
      return { ok: true, label: `已登录（${who}${expiryLabel(d.auth.expiresAt)}）` };
    }
  }
  return { ok: false, label: '未登录（auths 里没有有效凭证）' };
}

function codeartsAuth() {
  const data = readJsonFile(CODEARTS_DATA_FILE);
  const accounts = (data && Array.isArray(data.accounts) && data.accounts) || [];
  const usable = accounts.filter((a) => a && a.enabled !== false && a.session);
  if (!usable.length) return { ok: false, label: '未登录（账号池为空）' };
  const names = usable.map((a) => a.name || '账号').slice(0, 2).join('、');
  return { ok: true, label: `已登录（${names}${usable.length > 2 ? ' 等' : ''}）` };
}

function authStatus(p) {
  switch (p.kind) {
    case 'qoder':
      return qoderAuth(p.ocProvider);
    case 'workbuddy':
      return workbuddyAuth(p.id);
    case 'trae':
      return traeAuth();
    case 'codearts':
      return codeartsAuth();
    default:
      return { ok: true, label: '未知' };
  }
}

/** Trae 的 tw2api 启动环境；key 优先读它自己的 .env.local，其次复用 pi 里的。 */
function traeEnv() {
  const env = readDotEnv(path.join(TRAE_DIR, '.env.local'));
  const key = env.TW2A_API_KEY || keyFor('trae-local') || '';
  if (!key) return null;
  return {
    TW2A_API_KEY: key,
    TW2A_LISTEN: ':7864',
    TW2A_AUTH_DIR: path.join(TRAE_DIR, 'auths'),
    TW2A_STATE_FILE: path.join(TRAE_DIR, 'data', 'state.json'),
    TW2A_CALLBACK_PORT: '18080',
    TW2A_DEFAULT_MODEL: 'DeepSeek-V4-Flash',
  };
}

/** Qoder 代理脚本：优先用 integrations 里 git 管理的那份。 */
function qoderProxyScript() {
  const candidates = [
    path.join(QODBUDDY_REPO, 'assets', 'qoder-proxy.js'),
    path.join(HOME, '.qoder2pi', 'vendor', 'qoder-proxy.js'),
    path.join(HERE, '..', 'qodbuddy2pi', 'assets', 'qoder-proxy.js'),
  ];
  for (const f of candidates) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return candidates[0];
}

function qoderProxyArgs(region, port) {
  const script = qoderProxyScript();
  if (!fs.existsSync(script)) throw new Error(`找不到 qoder-proxy.js：${script}`);
  // 不传 --log-file：让代理把日志打到 stdout，由 router 统一重定向到 cn.log/global.log，
  // 这样不会出现「文件里一份、控制台里一份」的重复行。
  return [script, '--region', region, '--port', String(port)];
}

function findUv() {
  return resolveExecutable(path.join(HOME, '.local', 'bin'), ['uv.exe', 'uv']);
}

/** 找到最新的 WorkBuddy 反代 wheel；找不到时抛错，让 inspectSpec 报出明确路径。 */
function findWorkbuddyWheel() {
  const dirs = [
    path.join(QODBUDDY_REPO, 'assets', 'vendor'),
    path.join(HOME, '.workbuddy2api', 'vendor'),
    path.join(HERE, '..', 'qodbuddy2pi', 'assets', 'vendor'),
  ];
  for (const dir of dirs) {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^workbuddy2api-.*\.whl$/i.test(f))
        .map((f) => {
          const file = path.join(dir, f);
          return { file, mtime: fs.statSync(file).mtimeMs };
        })
        // 按修改时间取最新：文件名里的 2.0.10 按字符串排序会排在 2.0.7 前面
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length) return files[0].file;
    } catch {}
  }
  throw new Error(`找不到 workbuddy2api-*.whl（看过：${dirs.join('、')}）`);
}

function workbuddyArgs(region, port) {
  const wheel = findWorkbuddyWheel();
  const logDir =
    region === 'global'
      ? path.join(HOME, '.workbuddy2api', 'global')
      : path.join(HOME, '.workbuddy2api');
  const args = [
    'run',
    '--with',
    wheel,
    'python',
    '-m',
    'codebuddy_proxy',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ];
  if (region === 'global') args.push('--global', '--endpoint', 'https://www.codebuddy.ai');
  args.push('--desensitize', '--log-file', path.join(logDir, 'codebuddy-proxy.jsonl'));
  return args;
}

// ---------------------------------------------------------------- 供应商表
//
// 每个供应商说清四件事：怎么探活、怎么启停、日志在哪、怎么在 opencode 里增删。
//
// 全部由 router 直接 spawn：不再依赖 qoder2pi / workbuddy2pi 的计划任务来拉起。
// 计划任务在本机并不总是可靠（任务状态 Queued、进程没起来），而反代本体只关心
// 「命令行 + 环境变量 + 端口」，router 自己拉起反而更可控：
//
//   - PID 记在 .run/processes.json
//   - stdout/stderr 落到各家的日志文件
//   - 停止时先按 PID 树杀，再按监听端口兜底
//   - 登录自启由 `service install` 生成 router-<id> 计划任务
//
// 加第七家：在这里加一项；并在 scripts/health.mjs 的 SOURCES 里加一行。

const PROVIDERS = [
  {
    id: 'qoder-cn',
    title: 'Qoder 国内版',
    port: 8789,
    kind: 'qoder',
    control: 'spawn',
    processes: [
      {
        name: 'qoder-proxy',
        port: 8789,
        command: () => process.execPath,
        args: () => qoderProxyArgs('cn', 8789),
        cwd: () => HOME,
        env: () => ({}),
        log: () => path.join(HOME, '.qoder2pi', 'proxy', 'cn.log'),
        errLog: () => path.join(HOME, '.qoder2pi', 'proxy', 'cn.log'),
        waitMs: 20000,
      },
    ],
    logs: [path.join(HOME, '.qoder2pi', 'proxy', 'cn.log')],
    // 老的工具计划任务：router 直管时先把它 /End，避免它和 router 抢同一个端口
    legacyTask: 'qoder2pi-proxy',
    // 模型目录从代理的 /v1/models 拉（网关的实时清单最准），不再走 qoder2pi opencode install
    ocProvider: 'qoder-cn',
    // 反代不校验这个 key，但沿用用户原来的占位值，避免重写 provider 时制造无谓 diff
    ocApiKey: 'qoder-local',
  },
  {
    id: 'qoder',
    title: 'Qoder 国际版',
    port: 8790,
    kind: 'qoder',
    control: 'spawn',
    processes: [
      {
        name: 'qoder-proxy',
        port: 8790,
        command: () => process.execPath,
        args: () => qoderProxyArgs('global', 8790),
        cwd: () => HOME,
        env: () => ({}),
        log: () => path.join(HOME, '.qoder2pi', 'proxy', 'global.log'),
        errLog: () => path.join(HOME, '.qoder2pi', 'proxy', 'global.log'),
        waitMs: 20000,
      },
    ],
    logs: [path.join(HOME, '.qoder2pi', 'proxy', 'global.log')],
    legacyTask: 'qoder2pi-proxy-global',
    ocProvider: 'qoder',
    ocApiKey: 'qoder-local',
  },
  {
    id: 'trae-local',
    title: 'Trae',
    port: 7863,
    kind: 'trae',
    control: 'spawn',
    // Trae 是两段式：tw2api(:7864) 真正对接云端，img-proxy(:7863) 在前面做
    // 图片转文字。对外只暴露 7863；停止时按相反顺序收。
    processes: [
      {
        name: 'tw2api',
        port: 7864,
        command: () => resolveExecutable(TRAE_DIR, ['tw2api.exe', 'tw2api']),
        args: () => [],
        cwd: () => TRAE_DIR,
        env: () => traeEnv(),
        log: () => path.join(TRAE_DIR, 'tw2api.log'),
        errLog: () => path.join(TRAE_DIR, 'tw2api.err.log'),
        ensureDirs: [
          path.join(TRAE_DIR, 'auths'),
          path.join(TRAE_DIR, 'data'),
          path.join(TRAE_DIR, '.run'),
        ],
        waitMs: 30000,
      },
      {
        name: 'img-proxy',
        port: 7863,
        command: () => process.execPath,
        args: () => {
          const script = path.join(TRAE_DIR, 'img-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 img-proxy.js：${script}`);
          return [script];
        },
        cwd: () => TRAE_DIR,
        env: () => ({ LISTEN: '127.0.0.1:7863', UPSTREAM: 'http://127.0.0.1:7864' }),
        log: () => path.join(TRAE_DIR, 'img-proxy.log'),
        errLog: () => path.join(TRAE_DIR, 'img-proxy.err.log'),
        waitMs: 15000,
      },
    ],
    logs: [
      path.join(TRAE_DIR, 'img-proxy.log'),
      path.join(TRAE_DIR, 'img-proxy.err.log'),
      path.join(TRAE_DIR, 'tw2api.log'),
      path.join(TRAE_DIR, 'tw2api.err.log'),
    ],
    ocProvider: 'trae-local',
    // Trae 的 /v1/models 里混着内部子代理（summary、*_subagent、custom_model_*），
    // 选进客户端只会报错，写 opencode 时按 id 形状剔掉
    ocSkip: INTERNAL_MODEL_ID,
  },
  {
    id: 'codearts',
    title: 'CodeArts Agent',
    port: 10087,
    kind: 'codearts',
    control: 'spawn',
    // 第三方 Go 网关。它自己从 IDE 的 state.vscdb 读凭据并续期；
    // router 只负责拉起、收尸和写 opencode provider。
    processes: [
      {
        name: 'codearts2api',
        port: 10087,
        command: () => resolveExecutable(CODEARTS_DIR, ['codearts2api.exe', 'codearts2api']),
        args: () => ['-data', path.join(CODEARTS_DIR, 'codearts2api-data.json'), '-port', '10087'],
        cwd: () => CODEARTS_DIR,
        env: () => ({}),
        log: () => path.join(CODEARTS_DIR, 'run.log'),
        // CodeArts 把日志写到 stderr；和 stdout 合到同一个文件，和旧版 run.log 保持一致
        errLog: () => path.join(CODEARTS_DIR, 'run.log'),
        waitMs: 30000,
      },
    ],
    logs: [path.join(CODEARTS_DIR, 'run.log')],
    ocProvider: 'codearts',
    ocName: 'CodeArts Agent（华为云）',
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy 国内版',
    port: 8787,
    kind: 'workbuddy',
    control: 'spawn',
    processes: [
      {
        name: 'codebuddy_proxy',
        port: 8787,
        command: () => findUv(),
        args: () => workbuddyArgs('domestic', 8787),
        cwd: () => path.join(HOME, '.workbuddy2api'),
        env: () => ({ PYTHONUTF8: '1' }),
        log: () => path.join(HOME, '.workbuddy2api', 'proxy-stdout.log'),
        errLog: () => path.join(HOME, '.workbuddy2api', 'proxy-stdout.log'),
        ensureDirs: [path.join(HOME, '.workbuddy2api')],
        waitMs: 60000,
      },
    ],
    logs: [
      path.join(HOME, '.workbuddy2api', 'proxy.log'),
      path.join(HOME, '.workbuddy2api', 'proxy-stdout.log'),
    ],
    legacyTask: 'workbuddy2pi',
    // WorkBuddy 反代的静态模型表不可靠（见 docs/02-pitfalls.md P3），
    // 写 opencode 时仍用 workbuddy2pi 的「优先取 pi 清单」逻辑。
    ocAdd: ['workbuddy2pi', 'opencode', 'install'],
    ocRemove: ['workbuddy2pi', 'opencode', 'uninstall'],
    ocProvider: 'workbuddy',
  },
  {
    id: 'workbuddy-global',
    title: 'WorkBuddy 国际版',
    port: 8788,
    kind: 'workbuddy',
    control: 'spawn',
    processes: [
      {
        name: 'codebuddy_proxy',
        port: 8788,
        command: () => findUv(),
        args: () => workbuddyArgs('global', 8788),
        cwd: () => path.join(HOME, '.workbuddy2api', 'global'),
        env: () => ({ PYTHONUTF8: '1' }),
        log: () => path.join(HOME, '.workbuddy2api', 'global', 'proxy-stdout.log'),
        errLog: () => path.join(HOME, '.workbuddy2api', 'global', 'proxy-stdout.log'),
        ensureDirs: [path.join(HOME, '.workbuddy2api', 'global')],
        waitMs: 60000,
      },
    ],
    logs: [
      path.join(HOME, '.workbuddy2api', 'global', 'proxy.log'),
      path.join(HOME, '.workbuddy2api', 'global', 'proxy-stdout.log'),
    ],
    legacyTask: 'workbuddy2pi-global',
    ocAdd: ['workbuddy2pi', 'global', 'opencode', 'install'],
    ocRemove: ['workbuddy2pi', 'global', 'opencode', 'uninstall'],
    ocProvider: 'workbuddy-global',
  },
];

// ---------------------------------------------------------------- 状态文件

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // 只保留认识的 id，未知条目（升级后删掉的供应商）忽略
    const known = new Set(PROVIDERS.map((p) => p.id));
    const enabled = Array.isArray(s.enabled) ? s.enabled.filter((id) => known.has(id)) : null;
    return enabled ? { ...s, enabled } : null;
  } catch {
    return null;
  }
}

function writeState(enabled) {
  // 顺序统一按 PROVIDERS 声明，diff 才稳定
  const ordered = PROVIDERS.map((p) => p.id).filter((id) => enabled.includes(id));
  const state = { enabled: ordered, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  return ordered;
}

/** 没写过配置时默认「全开」——这样第一次用的人不会以为坏了。 */
function currentEnabled() {
  const s = readState();
  return s ? s.enabled : PROVIDERS.map((p) => p.id);
}

/**
 * 解析 id。先精确匹配，再前缀匹配；前缀命中多个时报歧义。
 * 老实现直接 startsWith，导致 `qoder` 永远命中 qoder-cn，国际版只能写全名。
 */
function resolveId(arg) {
  const exact = PROVIDERS.find((p) => p.id === arg);
  if (exact) return { p: exact };
  const matches = PROVIDERS.filter((p) => p.id.startsWith(arg));
  if (matches.length === 1) return { p: matches[0] };
  if (matches.length > 1) {
    return { error: `${arg} 有歧义：${matches.map((p) => p.id).join('、')}` };
  }
  return { error: `未知供应商：${arg}` };
}

function resolveIds(args) {
  const ids = [];
  for (const a of args) {
    const r = resolveId(a);
    if (r.error) return { error: r.error };
    if (!ids.includes(r.p.id)) ids.push(r.p.id);
  }
  return { ids };
}

// ---------------------------------------------------------------- 运行时状态（PID）

function readRuntime() {
  try {
    const r = JSON.parse(fs.readFileSync(PROCESS_FILE, 'utf8'));
    if (r && typeof r === 'object' && r.processes && typeof r.processes === 'object') return r;
  } catch {}
  return { processes: {} };
}

function writeRuntime(rt) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(PROCESS_FILE, `${JSON.stringify(rt, null, 2)}\n`);
}

function recordProcess(providerId, entry) {
  const rt = readRuntime();
  const arr = rt.processes[providerId] || [];
  rt.processes[providerId] = [...arr.filter((e) => e.name !== entry.name), entry];
  writeRuntime(rt);
}

function clearProviderRuntime(providerId) {
  const rt = readRuntime();
  if (!rt.processes[providerId]) return;
  delete rt.processes[providerId];
  writeRuntime(rt);
}

/** 清理已经死掉的 PID；不做任何终止动作，只让列表不显示幽灵进程。 */
function pruneRuntime() {
  const rt = readRuntime();
  let changed = false;
  for (const [id, entries] of Object.entries(rt.processes)) {
    const alive = entries.filter((e) => pidAlive(e.pid));
    if (alive.length !== entries.length) {
      if (alive.length) rt.processes[id] = alive;
      else delete rt.processes[id];
      changed = true;
    }
  }
  if (changed) writeRuntime(rt);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 取 PID 的映像名，用来防止 PID 复用后误杀别的进程。 */
function pidImage(pid) {
  if (WIN) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const line = (r.stdout || '').trim().split(/\r?\n/)[0] || '';
    const m = line.match(/^"([^"]+)"/);
    return m ? m[1].toLowerCase() : null;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return (r.stdout || '').trim().toLowerCase() || null;
}

function pidMatches(pid, command) {
  if (!command) return false;
  const image = pidImage(pid);
  if (!image) return false;
  const expected = path.basename(command).toLowerCase();
  if (image === expected) return true;
  // Windows 的 node 映像名是 node.exe，Linux/macOS 是 node
  return expected.startsWith('node') && image.startsWith('node');
}

/** 终止整棵进程树。Windows 先礼后兵；POSIX 走进程组（spawn 时 detached）。 */
async function killTree(pid, { force = false } = {}) {
  if (!pid) return;
  if (WIN) {
    if (!force) {
      spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      await sleep(800);
    }
    if (pidAlive(pid)) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
  if (!force) {
    await sleep(800);
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
}

/** 找出监听某端口的全部 PID。Windows 用 netstat 末列，与系统语言无关。 */
function portPids(port) {
  const pids = new Set();
  if (WIN) {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      if (cols[3] !== 'LISTENING') continue;
      if (!cols[1] || !cols[1].endsWith(`:${port}`)) continue;
      const pid = Number(cols[4]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  for (const line of (r.stdout || '').split('\n')) {
    const pid = Number(line.trim());
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** 按端口收尸，直到端口真空或重试次数用完。 */
async function killPort(port, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    const pids = portPids(port);
    if (!pids.length) return true;
    for (const pid of pids) await killTree(pid, { force: true });
    await sleep(600);
  }
  return portPids(port).length === 0;
}

// ---------------------------------------------------------------- 探活

async function probePort(port, timeout = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(timeout),
    });
    // 401/403 说明服务活着，只是要鉴权（Trae/CodeArts 就是这样）
    return { up: true, status: res.status, needsKey: res.status === 401 || res.status === 403 };
  } catch (e) {
    return { up: false, error: e.code || e.message };
  }
}

async function waitPort(port, timeoutMs, interval = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = { up: false };
  while (Date.now() < deadline) {
    last = await probePort(port, 1500);
    if (last.up) return last;
    await sleep(interval);
  }
  return last;
}

async function waitPortDown(port, timeoutMs, interval = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await probePort(port, 800);
    if (!p.up) return true;
    await sleep(interval);
  }
  return false;
}

async function fetchModels(port, apiKey, timeout = 6000) {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = Array.isArray(j) ? j : j.data || j.models || [];
    return arr.length ? arr : null;
  } catch {
    return null;
  }
}

/** Trae 的模型清单里哪些不是可对话的模型（与 scripts/pi-models.mjs 保持一致）。 */
function INTERNAL_MODEL_ID(id) {
  return /^custom_model|_(sub)?agent(_v\d)?$|^summary$|^computer_use|^browser_use|^file_search/.test(String(id || ''));
}

async function modelCount(provider) {
  const models = await fetchModels(provider.port, keyFor(provider.id));
  if (!models) return null;
  // 和写 opencode 时用同一份过滤，否则表格里的数字比客户端实际能选的多数十个
  const usable = provider.ocSkip ? models.filter((m) => !provider.ocSkip(m.id || m.slug)) : models;
  return usable.length;
}

async function fetchModelsRetry(port, apiKey, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const models = await fetchModels(port, apiKey);
    if (models) return models;
    await sleep(1000 * (i + 1));
  }
  return null;
}

// ---------------------------------------------------------------- 调运维命令

/**
 * 调本项目的运维命令。优先用 integrations/qodbuddy2pi/assets 里的源码，
 * 兼容旧的 ~/.local/bin 安装副本。
 *
 * 用 node 直接跑脚本而不是起 .cmd：Windows 上 spawn .cmd 需要 cmd.exe 包一层，
 * 还容易被引号坑到；这些脚本本身就以 #!/usr/bin/env node 开头，直接交给 node 最稳。
 */
function runTool(name, args, { env, timeout = 300000 } = {}) {
  const script = findToolScript(name);
  if (!script) return { ok: false, reason: `找不到 ${name}（先跑安装器）` };
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, status: r.status, out };
}

function findToolScript(name) {
  const candidates = [
    path.join(QODBUDDY_REPO, 'assets', name),
    path.join(HOME, '.local', 'bin', name),
    path.join(HERE, '..', 'qodbuddy2pi', 'assets', name),
  ];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- 浏览器登录

/** 用系统默认浏览器打开 URL；打不开时只把链接打出来，不阻塞主流程。 */
function openBrowser(url) {
  if (!url) return false;
  try {
    const cmd = WIN ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = WIN ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function promptLine(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 10000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = (data && (data.message || (data.error && data.error.message))) || text.slice(0, 300);
    throw new Error(`${res.status} ${res.statusText}：${msg}`);
  }
  return data;
}

/** 交互式调用运维命令：浏览器登录会把提示直接打在终端上。 */
function runToolLive(name, args, { cwd, env, timeout = 600000 } = {}) {
  const script = findToolScript(name);
  if (!script) return { ok: false, status: -1, reason: `找不到 ${name}（先跑安装器）` };
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    cwd: cwd || path.dirname(script),
    timeout,
    windowsHide: false,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { ok: r.status === 0, status: r.status, error: r.error };
}

function qoderMachineId() {
  const candidates = [path.join(HOME, '.qoder', '.auth', 'machine_id'), path.join(HOME, '.pi', 'agent', 'qoder-machine-id')];
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {}
  }
  const id = randomUUID();
  try {
    const file = candidates[1];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, 'utf8');
  } catch {}
  return id;
}

function saveQoderAuth(provider, credentials) {
  const file = PI_AUTH_FILE;
  const data = readJsonFile(file) || {};
  data[provider] = { type: 'oauth', ...credentials };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function parseExpiresAt(value, expiresInSeconds) {
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (expiresInSeconds && Number(expiresInSeconds) > 0) {
    return Date.now() + Number(expiresInSeconds) * 1000;
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

/**
 * Qoder 国际版的浏览器 OAuth：生成 PKCE，打开选账号页，轮询 deviceToken。
 * 不依赖 pi 的交互界面，也不需要用户复制 PAT。
 */
async function loginQoderGlobal() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const nonce = randomUUID();
  const machineID = qoderMachineId();
  const authUrl =
    `https://qoder.com/device/selectAccounts?challenge=${encodeURIComponent(challenge)}` +
    `&challenge_method=S256&machine_id=${encodeURIComponent(machineID)}&nonce=${encodeURIComponent(nonce)}`;
  const pollUrl =
    `https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}` +
    `&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;

  say(`  ${dim('浏览器已打开；登录成功后这个命令会自动继续。')}`);
  say(`  ${dim(authUrl)}`);
  if (!openBrowser(authUrl)) warn('浏览器没有自动打开，请手动复制上面的链接');

  for (let i = 0; i < 150; i += 1) {
    await sleep(2000);
    let res;
    try {
      res = await fetch(pollUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'router-login' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      if (i % 15 === 0) say(dim(`  · 等待浏览器登录…（${e.message}）`));
      continue;
    }
    if (res.status === 202 || res.status === 404) continue;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`deviceToken/poll ${res.status}：${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.token) throw new Error('deviceToken/poll 没有返回 access token');

    let email = '';
    let name = '';
    try {
      const info = await fetch('https://openapi.qoder.sh/api/v1/userinfo', {
        headers: { Authorization: `Bearer ${data.token}`, Accept: 'application/json', 'User-Agent': 'router-login' },
        signal: AbortSignal.timeout(10000),
      });
      if (info.ok) {
        const user = await info.json();
        email = user.email || '';
        name = user.name || user.username || '';
      }
    } catch {}

    const expires = parseExpiresAt(data.expires_at, data.expires_in) - 5 * 60 * 1000;
    const creds = {
      refresh: `${data.refresh_token || ''}|${data.user_id || ''}|${machineID}`,
      access: data.token,
      expires,
      userID: data.user_id || '',
      email,
      name,
      machineID,
    };
    saveQoderAuth('qoder', creds);
    ok(`Qoder 国际版浏览器登录成功${name ? `（${name}）` : ''}`);
    return true;
  }
  throw new Error('浏览器登录超时（5 分钟）');
}

function qoderPatFromEnv(regionKey) {
  const names =
    regionKey === 'cn'
      ? ['QODERCN_API_KEY', 'QODERCN_PERSONAL_ACCESS_TOKEN', 'QODERCN_PAT']
      : ['QODER_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN', 'QODER_PAT'];
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

async function qoderLoginWithPat(p, pat) {
  const regionKey = p.id === 'qoder-cn' ? 'cn' : 'global';
  say(`  ${dim('用 PAT 登录；PAT 只通过环境变量传给子进程，不写命令行。')}`);
  const r = runTool('qoder2pi', ['login', regionKey], { env: { QODER_PAT: pat } });
  if (r.out) say(r.out.trim());
  const st = authStatus(p);
  if (r.ok && st.ok) {
    ok(`${p.title} ${st.label}`);
    return true;
  }
  bad(`${p.title} PAT 登录没有生效`);
  return false;
}

async function loginQoder(p) {
  const regionKey = p.id === 'qoder-cn' ? 'cn' : 'global';
  const pat = qoderPatFromEnv(regionKey);
  if (pat) return qoderLoginWithPat(p, pat);

  if (regionKey === 'global') {
    try {
      return await loginQoderGlobal();
    } catch (e) {
      bad(`Qoder 国际版浏览器登录失败：${e.message}`);
      return false;
    }
  }

  const page = 'https://qoder.com.cn/account/integrations';
  say(`  Qoder 国内版只支持 PAT。已打开 ${page}`);
  if (!openBrowser(page)) say(`  ${dim(page)}`);
  if (!process.stdin.isTTY) {
    warn('当前不是交互终端，无法粘贴 PAT；请在浏览器创建后运行：');
    say(`  ${dim(`QODER_PAT=pt-... node router.mjs login ${p.id}`)}`);
    return false;
  }
  const entered = (await promptLine('  粘贴 Qoder CN PAT（pt-...，直接回车跳过）：')).trim();
  if (!entered) {
    warn('已跳过 Qoder 国内版登录');
    return false;
  }
  return qoderLoginWithPat(p, entered);
}

function ensureWorkbuddyVendorWheel() {
  try {
    const wheel = findWorkbuddyWheel();
    const dir = path.join(HOME, '.workbuddy2api', 'vendor');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(wheel));
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(wheel, dest);
      say(dim(`  · 已把 ${path.basename(wheel)} 放进 ${dir}（workbuddy2pi 登录要用）`));
    }
  } catch {}
}

async function loginWorkbuddy(p) {
  const args = p.id === 'workbuddy-global' ? ['global', 'login'] : ['login'];
  ensureWorkbuddyVendorWheel();
  say(`  ${dim('WorkBuddy 会打开浏览器，完成后自动把凭证写入账号池。')}`);
  const r = runToolLive('workbuddy2pi', args, {
    cwd: QODBUDDY_REPO,
    timeout: 600000,
    // 让整合进来的 workbuddy2pi 直接用仓库里的 wheel，而不是 home 里的旧副本
    env: { WORKBUDDY2API_VENDOR: path.join(QODBUDDY_REPO, 'assets', 'vendor') },
  });
  if (!r.ok) {
    bad(`${p.title} 浏览器登录未完成${r.error ? `：${r.error.message}` : ''}`);
    return false;
  }
  const st = authStatus(p);
  if (!st.ok) {
    bad(`${p.title} 登录流程结束，但仍没有生效凭证`);
    return false;
  }
  ok(`${p.title} ${st.label}`);
  return true;
}

async function loginTrae(p) {
  const script = path.join(TRAE_DIR, 'login.ps1');
  if (!fs.existsSync(script)) {
    bad(`找不到 Trae 登录脚本：${script}`);
    return false;
  }
  if (!fs.existsSync(path.join(TRAE_DIR, '.env.local'))) {
    warn(`缺少 ${path.join(TRAE_DIR, '.env.local')}，tw2api 可能起不来`);
  }

  const up = await probePort(p.port, 1000);
  if (!up.up) {
    say(dim('  · 先启动 tw2api，登录脚本要用它的 /admin/api/login'));
    const failed = await doUp([p], { quiet: true });
    if (failed) {
      bad('Trae 反代没有启动，无法登录');
      return false;
    }
  }

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  say(`  ${dim('浏览器会自动打开；登录成功后回调 127.0.0.1:18080。')}`);
  let r = spawnSync('pwsh', args, { stdio: 'inherit', cwd: TRAE_DIR, timeout: 660000, windowsHide: false });
  if (r.error && r.error.code === 'ENOENT') {
    r = spawnSync('powershell.exe', args, { stdio: 'inherit', cwd: TRAE_DIR, timeout: 660000, windowsHide: false });
  }
  if (r.error) {
    bad(`启动 PowerShell 登录失败：${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    bad('Trae 浏览器登录未完成（超时、取消或浏览器里没有登录成功）');
    return false;
  }
  const st = authStatus(p);
  if (!st.ok) {
    bad('Trae 登录流程结束，但 auths 里没有有效凭证');
    return false;
  }
  ok(`Trae ${st.label}`);
  return true;
}

async function loginCodearts(p) {
  const up = await probePort(p.port, 1000);
  if (!up.up) {
    say(dim('  · 先启动 CodeArts 网关，浏览器登录要走它的 /admin/api/login'));
    const failed = await doUp([p], { quiet: true });
    if (failed) {
      bad('CodeArts 网关没有启动，无法登录');
      return false;
    }
  }

  const state = readJsonFile(CODEARTS_DATA_FILE) || {};
  const adminPassword = (state.settings && state.settings.admin_password) || '';
  const headers = { 'Content-Type': 'application/json' };
  if (adminPassword) headers['X-Admin-Password'] = adminPassword;
  const base = `http://127.0.0.1:${p.port}/admin/api/login`;

  let start;
  try {
    start = await fetchJson(`${base}/start`, { method: 'POST', headers, body: '{}' });
  } catch (e) {
    bad(`启动 CodeArts 浏览器登录失败：${e.message}`);
    return false;
  }
  const authUrl = start && (start.auth_url || start.authUrl);
  if (!authUrl) {
    bad('CodeArts 没有返回授权地址');
    return false;
  }
  say(`  ${dim('浏览器已打开；登录成功后这个命令会自动继续。')}`);
  say(`  ${dim(authUrl)}`);
  if (!openBrowser(authUrl)) warn('浏览器没有自动打开，请手动复制上面的链接');

  const sessionId = start.session_id || start.sessionId;
  if (!sessionId) {
    bad('CodeArts 没有返回登录会话 id');
    return false;
  }

  for (let i = 0; i < 150; i += 1) {
    await sleep(2000);
    let poll;
    try {
      poll = await fetchJson(`${base}/poll`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch (e) {
      if (i % 10 === 0) say(dim(`  · 等待浏览器登录…（${e.message}）`));
      continue;
    }
    if (poll && (poll.status === 'confirmed' || poll.account_id)) {
      ok(`CodeArts 浏览器登录成功${poll.account_name ? `（${poll.account_name}）` : ''}`);
      return true;
    }
    if (poll && ['failed', 'expired', 'canceled'].includes(poll.status)) {
      bad(`CodeArts 登录未完成：${poll.message || poll.status}`);
      return false;
    }
  }
  bad('CodeArts 浏览器登录超时（5 分钟）');
  return false;
}

async function loginProvider(p, { force = false } = {}) {
  const before = authStatus(p);
  if (before.ok && !force) {
    ok(`${p.title} ${before.label}`);
    return { ok: true, skipped: true, wasUp: false };
  }

  const wasUp = (await probePort(p.port, 1000)).up;
  let success = false;
  if (p.kind === 'qoder') success = await loginQoder(p);
  else if (p.kind === 'workbuddy') success = await loginWorkbuddy(p);
  else if (p.kind === 'trae') success = await loginTrae(p);
  else if (p.kind === 'codearts') success = await loginCodearts(p);
  else bad(`不知道怎么登录 ${p.title}`);

  // Trae/CodeArts 的登录必须先把网关跑起来；如果它本来没在跑，登录后恢复「停止」。
  if (!wasUp && (p.kind === 'trae' || p.kind === 'codearts')) {
    await doDown([p], { quiet: true });
  } else if (success && wasUp) {
    say(dim(`  · ${p.title} 重启以加载新凭证`));
    await doRestart([p], { quiet: true });
  }
  return { ok: success, skipped: false, wasUp };
}

/** auto=false 时只提示；auto=true 时逐个打开浏览器。 */
async function ensureLogins(list, { auto = false } = {}) {
  const missing = list.filter((p) => !authStatus(p).ok);
  if (!missing.length) return { ok: true, failed: [] };
  if (!auto) {
    for (const p of missing) {
      warn(`${p.title} ${authStatus(p).label}`);
      say(`  ${dim(`登录：node router.mjs login ${p.id}`)}`);
    }
    return { ok: false, failed: missing.map((p) => p.id) };
  }

  const failed = [];
  for (const p of missing) {
    say(`${C.bold}登录${C.reset} ${p.title}`);
    const r = await loginProvider(p);
    if (!r.ok) failed.push(p.id);
  }
  return { ok: failed.length === 0, failed };
}

// ---------------------------------------------------------------- 直接托管的进程

function inspectSpec(spec, { create = false } = {}) {
  try {
    const command = typeof spec.command === 'function' ? spec.command() : spec.command;
    const args = typeof spec.args === 'function' ? spec.args() : spec.args || [];
    const cwd = typeof spec.cwd === 'function' ? spec.cwd() : spec.cwd;
    const env = typeof spec.env === 'function' ? spec.env() : spec.env || {};
    const log = typeof spec.log === 'function' ? spec.log() : spec.log;
    const errLog = typeof spec.errLog === 'function' ? spec.errLog() : spec.errLog || log;

    if (!command) return { error: '没有可执行文件' };
    if (path.isAbsolute(command) && !fs.existsSync(command)) return { error: `找不到可执行文件：${command}` };
    if (env === null) return { error: '缺少启动凭证（例如 Trae 的 TW2A_API_KEY）' };

    // 先建目录再校验 cwd：ensureDirs 里就包含 cwd（workbuddy-global 的
    // ~/.workbuddy2api/global），反过来的话首次启动永远报「工作目录不存在」。
    if (create) {
      for (const d of spec.ensureDirs || []) fs.mkdirSync(d, { recursive: true });
      fs.mkdirSync(path.dirname(log), { recursive: true });
      if (errLog !== log) fs.mkdirSync(path.dirname(errLog), { recursive: true });
    }

    if (!cwd || !fs.existsSync(cwd)) return { error: `工作目录不存在：${cwd}` };

    return { command, args, cwd, env, log, errLog };
  } catch (e) {
    return { error: e.message };
  }
}

function spawnDaemon(r) {
  const outFd = fs.openSync(r.log, 'a');
  const errFd = r.errLog && r.errLog !== r.log ? fs.openSync(r.errLog, 'a') : outFd;
  const errorRef = { error: null };
  try {
    const child = spawn(r.command, r.args, {
      cwd: r.cwd,
      env: { ...process.env, ...r.env },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', (e) => {
      errorRef.error = e;
    });
    child.unref();
    return { child, errorRef };
  } finally {
    fs.closeSync(outFd);
    if (errFd !== outFd) fs.closeSync(errFd);
  }
}

/** 失败时把本轮已经拉起的子进程收回，避免留下半个 Trae 之类。 */
async function rollbackStarted(p, started) {
  for (const s of [...started].reverse()) {
    await killTree(s.pid, { force: true });
    await killPort(s.spec.port);
  }
  clearProviderRuntime(p.id);
}

/** 拉起一个 spawn 型供应商；按 processes 顺序启动，失败时只回滚本轮拉起的进程。 */
async function upSpawn(p, { quiet = false } = {}) {
  const started = [];
  let legacyStopped = false;

  for (const spec of p.processes) {
    const ready = await probePort(spec.port, 1200);
    if (ready.up) {
      if (!quiet) say(dim(`  · ${p.title}/${spec.name} 已在 :${spec.port}`));
      continue;
    }

    // 端口空着但老的计划任务可能正卡在 Queued/启动中。先把它 /End，
    // 免得 router 拉起进程后两个实例抢同一个端口。
    if (p.legacyTask && !legacyStopped) {
      legacyStopped = true;
      if (taskExists(p.legacyTask)) runSchtasks(['/End', '/TN', p.legacyTask]);
    }

    const r = inspectSpec(spec, { create: true });
    if (r.error) {
      await rollbackStarted(p, started);
      return { ok: false, reason: `${spec.name}：${r.error}` };
    }

    let spawned;
    try {
      spawned = spawnDaemon(r);
    } catch (e) {
      await rollbackStarted(p, started);
      return { ok: false, reason: `${spec.name} 启动失败：${e.message}` };
    }

    await sleep(250);
    if (spawned.errorRef.error) {
      await rollbackStarted(p, started);
      return { ok: false, reason: `${spec.name} 启动失败：${spawned.errorRef.error.message}` };
    }
    const pid = spawned.child.pid;
    if (!pid) {
      await rollbackStarted(p, started);
      return { ok: false, reason: `${spec.name} 启动失败：spawn 没有返回 PID` };
    }

    recordProcess(p.id, {
      name: spec.name,
      pid,
      port: spec.port,
      startedAt: new Date().toISOString(),
      command: r.command,
      args: r.args,
      log: r.log,
    });
    started.push({ spec, pid });
    if (!quiet) say(dim(`  · ${spec.name} 已拉起（PID ${pid}，:${spec.port}）`));

    const waitMs = spec.waitMs || 30000;
    const after = await waitPort(spec.port, waitMs);
    if (!after.up) {
      await rollbackStarted(p, started);
      return {
        ok: false,
        reason: `${spec.name} 未能在 ${Math.round(waitMs / 1000)} 秒内监听 :${spec.port}`,
      };
    }
  }

  const primary = await probePort(p.port, 1500);
  if (!primary.up) {
    await rollbackStarted(p, started);
    return { ok: false, reason: `主端口 :${p.port} 没有就绪（已收回本轮拉起的进程，检查日志）` };
  }
  return { ok: true };
}

/** 停止 spawn 型供应商：先收记录过的 PID，再按端口兜底。 */
async function downSpawn(p, { quiet = false } = {}) {
  const rt = readRuntime();
  const entries = rt.processes[p.id] || [];

  const portStates = await Promise.all(p.processes.map((s) => probePort(s.port, 1000)));
  const anyPortUp = portStates.some((x) => x.up);
  const anyPidAlive = entries.some((e) => pidAlive(e.pid));
  if (!anyPortUp && !anyPidAlive) {
    clearProviderRuntime(p.id);
    if (!quiet) say(dim(`· ${p.title} 已停止`));
    return { ok: true };
  }

  for (const spec of [...p.processes].reverse()) {
    const recorded = entries.filter((e) => e.name === spec.name);
    for (const e of recorded) {
      if (!pidAlive(e.pid)) continue;
      const command = e.command || (typeof spec.command === 'function' ? spec.command() : spec.command);
      if (pidMatches(e.pid, command)) {
        await killTree(e.pid, { force: false });
      } else {
        warn(`PID ${e.pid} 已被复用，跳过（${p.title}/${spec.name}）`);
      }
    }
    await killPort(spec.port);
  }
  await killPort(p.port);
  clearProviderRuntime(p.id);

  const remaining = [];
  for (const spec of p.processes) {
    if ((await probePort(spec.port, 1000)).up) remaining.push(spec.port);
  }
  if (remaining.length) {
    return { ok: false, remaining };
  }
  if (!quiet) ok(`${p.title} 已停止（:${p.port}）`);
  return { ok: true };
}

// ---------------------------------------------------------------- 动作

async function doUp(list, { quiet = false } = {}) {
  let failed = 0;
  for (const p of list) {
    if (p.control === 'spawn') {
      const r = await upSpawn(p, { quiet });
      if (r.ok) {
        if (!quiet) ok(`${p.title} 已启动（:${p.port}）`);
      } else {
        bad(`${p.title} 启动失败：${r.reason}`);
        showLogTail(p, 8);
        failed += 1;
      }
      continue;
    }

    const probe = await probePort(p.port);
    if (probe.up) {
      if (!quiet) ok(`${p.title} 已在运行（:${p.port}）`);
      continue;
    }
    if (!p.start) {
      bad(`${p.title} 没有配置启动命令`);
      failed += 1;
      continue;
    }

    const r = runTool(p.start[0], p.start.slice(1));
    if (!r.ok) {
      bad(`${p.title} 启动失败：${(r.out || r.reason || '').split('\n').slice(-1)[0]}`);
      failed += 1;
      continue;
    }

    // WorkBuddy 的 uv 冷启动实测 20~40 秒，统一给 60 秒
    const after = await waitPort(p.port, 60000);
    if (after.up) {
      if (!quiet) ok(`${p.title} 已启动（:${p.port}）`);
    } else {
      bad(`${p.title} 启动命令成功但 60 秒内端口没起来（:${p.port}）`);
      showLogTail(p, 8);
      failed += 1;
    }
  }
  return failed;
}

async function doDown(list, { quiet = false } = {}) {
  let failed = 0;
  for (const p of list) {
    if (p.control === 'spawn') {
      const r = await downSpawn(p, { quiet });
      if (!r.ok) {
        bad(`${p.title} 停不下来（:${r.remaining.join('、:')}）`);
        say(`  ${dim(`手动：netstat -ano | findstr :${p.port}  然后 taskkill /PID <pid> /T /F`)}`);
        failed += 1;
      }
      continue;
    }

    const before = await probePort(p.port);
    if (!before.up) {
      if (!quiet) say(dim(`· ${p.title} 已停止`));
      continue;
    }
    if (!p.stop) {
      warn(`${p.title} 没有配置停止命令，按端口清理`);
    } else {
      const r = runTool(p.stop[0], p.stop.slice(1));
      if (!r.ok) {
        warn(`${p.title} 停止命令失败：${(r.out || r.reason || '').split('\n').slice(-1)[0]}`);
      }
    }

    let down = await waitPortDown(p.port, 8000);
    if (!down) {
      warn(`${p.title} 的停止命令没有释放 :${p.port}，按端口清理残留进程`);
      down = await killPort(p.port);
    }
    if (down) {
      if (!quiet) ok(`${p.title} 已停止（:${p.port}）`);
    } else {
      bad(`${p.title} 停不下来（:${p.port}），可能有 keep-alive 循环或其他进程占用`);
      say(`  ${dim(`手动：netstat -ano | findstr :${p.port}  然后 taskkill /PID <pid> /T /F`)}`);
      failed += 1;
    }
  }
  return failed;
}

async function doRestart(list, { quiet = false } = {}) {
  let failed = 0;
  for (const p of list) {
    if (p.control === 'spawn') {
      const d = await downSpawn(p, { quiet: true });
      if (!d.ok && !quiet) warn(`${p.title} 停止阶段有残留，继续尝试启动`);
      const u = await upSpawn(p, { quiet });
      if (u.ok) {
        if (!quiet) ok(`${p.title} 已重启（:${p.port}）`);
      } else {
        bad(`${p.title} 重启失败：${u.reason}`);
        showLogTail(p, 8);
        failed += 1;
      }
      continue;
    }

    let started = false;
    if (p.restart) {
      const r = runTool(p.restart[0], p.restart.slice(1));
      if (r.ok && (await waitPort(p.port, 60000)).up) started = true;
    }
    if (!started) {
      // restart 命令不可用或没有真的把端口拉起来：退回 stop + start
      await doDown([p], { quiet: true });
      const f = await doUp([p], { quiet });
      if (f) {
        failed += 1;
        continue;
      }
      started = true;
    }
    if (started && !quiet) ok(`${p.title} 已重启（:${p.port}）`);
  }
  return failed;
}

/** 打印某家日志的最后几行，启动失败时用。 */
function showLogTail(p, lines = 8) {
  for (const file of p.logs) {
    if (!fs.existsSync(file)) continue;
    const text = tailFile(file, lines).trim();
    if (!text) continue;
    say(`  ${dim(path.basename(file))}`);
    say(text.split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

/** 只读文件尾部，不把 20MB 的日志整份读进内存。 */
function tailFile(file, lines, maxBytes = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.size) return '';
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- opencode 配置

function ocConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg ? path.join(xdg, 'opencode') : path.join(HOME, '.config', 'opencode');
  return path.join(dir, 'opencode.json');
}

/** 宽松解析 JSONC：去掉注释与尾逗号，用来只读判断 provider 在不在。 */
function parseJsonc(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

function fallbackLocateProvider(id) {
  const dir = path.dirname(ocConfigPath());
  const files = [ocConfigPath(), path.join(dir, 'opencode.jsonc')];
  const found = [];
  for (const f of files) {
    try {
      const cfg = parseJsonc(fs.readFileSync(f, 'utf8'));
      if (cfg && cfg.provider && cfg.provider[id]) found.push(f);
    } catch {}
  }
  return found;
}

/** 某个 provider 出现在哪些 opencode 配置文件里（.json 与 .jsonc 都看）。 */
function locateProviderFiles(id) {
  const mod = requireShared('opencode-config.js');
  if (mod && typeof mod.locateProvider === 'function') {
    try {
      return mod.locateProvider(id).files || [];
    } catch {}
  }
  return fallbackLocateProvider(id);
}

function ocHasProvider(id) {
  return locateProviderFiles(id).length > 0;
}

/**
 * 从 opencode.json 删掉某个 provider。返回 { removed, onlyInJsonc }。
 *
 * 只删 .json。用户在 .jsonc 里手写的（通常带注释）不动——共享模块会把它
 * 报在 onlyInJsonc 里，由这里提示用户。
 */
function removeProviderDirect(id) {
  const mod = requireShared('opencode-config.js');
  if (mod && typeof mod.removeProviders === 'function') {
    try {
      const r = mod.removeProviders([id]);
      return { removed: r.removed.length > 0, onlyInJsonc: (r.onlyInJsonc || []).includes(id) };
    } catch {}
  }

  // 共享模块不可用时的兜底：只改 router 自己那份 opencode.json，写前备份。
  try {
    const file = ocConfigPath();
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg.provider || !cfg.provider[id]) {
      return { removed: false, onlyInJsonc: fallbackLocateProvider(id).some((f) => f.endsWith('.jsonc')) };
    }
    fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    delete cfg.provider[id];
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return { removed: true, onlyInJsonc: false };
  } catch {
    return { removed: false, onlyInJsonc: false };
  }
}

/** 加载 E:\qodbuddy2pi 的共享模块（CommonJS）。 */
function requireShared(name) {
  for (const file of [
    path.join(QODBUDDY_REPO, 'assets', name),
    path.join(HERE, '..', 'qodbuddy2pi', 'assets', name),
  ]) {
    try {
      if (fs.statSync(file).isFile()) return require(file);
    } catch {}
  }
  return null;
}

/**
 * 给没有 ocAdd 运维命令的供应商写 opencode provider：
 * 从它的 /v1/models 拉目录，key 从 pi 的 models.json 取。
 */
async function addProviderFromModels(p) {
  const existing = locateProviderFiles(p.ocProvider);
  if (existing.length) {
    const where = existing.map((f) => path.basename(f)).join('、');
    ok(`${p.title} 的 provider 已在 ${where} 里，保持不动`);
    return { ok: true, wrote: false };
  }

  const listed = await fetchModelsRetry(p.port, keyFor(p.id));
  if (!listed || listed.length === 0) {
    return { ok: false, reason: `拿不到模型列表（:${p.port}）` };
  }
  const models = p.ocSkip ? listed.filter((m) => !p.ocSkip(m.id || m.slug)) : listed;
  const mod = requireShared('opencode-config.js');
  if (!mod) return { ok: false, reason: '找不到 opencode-config.js' };

  const result = mod.mergeProviders([
    {
      id: p.ocProvider,
      name: p.ocName || p.title,
      baseURL: `http://127.0.0.1:${p.port}/v1`,
      apiKey: p.ocApiKey || keyFor(p.id) || 'local-proxy',
      models: mod.toOpencodeModels(models),
    },
  ]);
  ok(`${p.title} 已写入 opencode（${models.length} 个模型）`);
  return { ok: true, wrote: true, backup: result.backup };
}

/**
 * 让 opencode 的 provider 列表与选择一致。
 *
 * 这一步容易被忽略：进程停了但 opencode.json 里还留着 provider，模型选择器里就会
 * 出现一堆点了报错的条目；反过来进程在跑但没写 provider，客户端又看不到。
 */
async function doSyncOpenCode(enabled, { startIds = null } = {}) {
  let changed = 0;
  for (const p of PROVIDERS) {
    const want = enabled.includes(p.id);
    const present = ocHasProvider(p.ocProvider);
    if (want === present) continue;

    if (want) {
      // 只对「本轮刚启动过」的供应商等端口。其它只是开关开着但没启动的，
      // 不该在这里白等 30 秒（典型：`up qoder-cn` 不该等 CodeArts/WorkBuddy）。
      if (startIds && !startIds.includes(p.id)) continue;
      // 服务必须先活着，否则写进去也是一个死端口
      const probe = await waitPort(p.port, startIds ? 30000 : 5000);
      if (!probe.up) {
        warn(`${p.title} 未运行，跳过写入 opencode`);
        continue;
      }
      if (p.ocAdd) {
        const r = runTool(p.ocAdd[0], p.ocAdd.slice(1));
        if (r.ok) {
          ok(`${p.title} 已写入 opencode`);
          changed += 1;
        } else {
          bad(`${p.title} 写入 opencode 失败：${(r.out || r.reason || '').split('\n').slice(-1)[0]}`);
        }
      } else {
        const r = await addProviderFromModels(p);
        if (!r.ok) bad(`${p.title} 写入 opencode 失败：${r.reason}`);
        else if (r.wrote) changed += 1;
      }
    } else {
      // 移除优先用共享模块（只删 opencode.json 里的键，不碰别家）
      const rem = removeProviderDirect(p.ocProvider);
      if (rem.removed) {
        ok(`${p.title} 已从 opencode 移除`);
        changed += 1;
      } else if (rem.onlyInJsonc) {
        // 它在用户自己的 .jsonc 里——那不是我们能安全改的文件（会丢注释）
        warn(`${p.title} 的 provider 在你自己的 opencode.jsonc 里，router 不改它`);
        say(`  ${dim(`要关掉它，请手动注释掉那段 provider.${p.ocProvider}`)}`);
      } else if (p.ocRemove) {
        const r = runTool(p.ocRemove[0], p.ocRemove.slice(1));
        if (r.ok) {
          ok(`${p.title} 已从 opencode 移除`);
          changed += 1;
        } else {
          warn(`${p.title} 从 opencode 移除失败：${(r.out || r.reason || '').split('\n').slice(-1)[0]}`);
        }
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------- 展示

async function cmdList({ json = false } = {}) {
  pruneRuntime();
  const enabled = currentEnabled();
  const runtime = readRuntime();

  const rows = await Promise.all(
    PROVIDERS.map(async (p) => {
      const probe = await probePort(p.port);
      const models = probe.up ? await modelCount(p) : null;
      const pids = probe.up ? portPids(p.port) : [];
      const recorded = (runtime.processes[p.id] || []).filter((e) => pidAlive(e.pid));
      const ocFiles = locateProviderFiles(p.ocProvider);
      return {
        id: p.id,
        title: p.title,
        port: p.port,
        on: enabled.includes(p.id),
        up: probe.up,
        models,
        pid: pids[0] || (recorded[0] && recorded[0].pid) || null,
        pids,
        control: p.control,
        oc: ocFiles.length > 0,
        // 在用户自己的 .jsonc 里 → 我们不能删，也不该报「不一致」
        ocUserOwned: ocFiles.some((f) => f.endsWith('opencode.jsonc')),
        auth: authStatus(p),
      };
    }),
  );

  if (json) {
    console.log(JSON.stringify({ enabled, providers: rows }, null, 2));
    return 0;
  }

  say(`${C.bold}转接选择${C.reset}  ${dim(STATE_FILE)}`);
  say('─'.repeat(92));
  say(
    `  ${padEnd('供应商', 20)} ${padEnd('开关', 6)} ${padEnd('进程', 18)} ${padEnd('管理', 10)} ${padEnd('opencode', 10)} 端口`,
  );
  for (const r of rows) {
    const on = r.on ? `${C.ok}开${C.reset}` : `${C.dim}关${C.reset}`;
    const pid = r.pid ? ` ${dim(r.pid)}` : '';
    const up = r.up ? `${C.ok}运行中${C.reset}${pid}` : `${C.dim}已停${C.reset}`;
    const control = r.control === 'tool' ? '计划任务' : 'router';
    const oc = r.ocUserOwned
      ? `${C.dim}用户自管${C.reset}`
      : r.oc
        ? `${C.ok}已写入${C.reset}`
        : `${C.dim}未写入${C.reset}`;
    const models = r.models === null ? '' : dim(` ${r.models} 模型`);
    say(
      `  ${padEnd(r.title, 20)} ${padEnd(on, 6)} ${padEnd(up, 18)} ${padEnd(control, 10)} ${padEnd(oc, 10)} :${r.port}${models}`,
    );
  }
  say('─'.repeat(92));

  const onCount = rows.filter((r) => r.on).length;
  const upCount = rows.filter((r) => r.up).length;
  say(`  ${onCount}/${rows.length} 开启　·　${upCount} 个进程在跑`);

  const drift = rows.filter((r) => r.on !== r.up);
  if (drift.length) {
    say('');
    warn(`开关与进程不一致：${drift.map((r) => r.title).join('、')}`);
    for (const r of drift) {
      say(`  ${dim(r.on ? `启动：node router.mjs up ${r.id}` : `停止：node router.mjs down ${r.id}`)}`);
    }
  }

  // 用户自己在 .jsonc 里配的不算漂移——我们无权改，也不该一直提示
  const ocDrift = rows.filter((r) => r.on !== r.oc && !r.ocUserOwned);
  if (ocDrift.length) {
    warn(`开关与 opencode 配置不一致：${ocDrift.map((r) => r.title).join('、')}`);
    say(`  ${dim('执行 node router.mjs sync 同步')}`);
  }

  const unauth = rows.filter((r) => !r.auth.ok);
  if (unauth.length) {
    warn(`未登录：${unauth.map((r) => `${r.title}（${r.auth.label}）`).join('、')}`);
    say(`  ${dim(`登录：node router.mjs login ${unauth.map((r) => r.id).join(' ')}`)}`);
  }
  return 0;
}

async function cmdLogin(rawArgs) {
  const force = rawArgs.includes('--force');
  const args = rawArgs.filter((a) => !a.startsWith('--'));
  const enabled = currentEnabled();
  const resolved = args.length ? resolveIds(args) : { ids: enabled };
  if (resolved.error) {
    bad(resolved.error);
    say(`  可选：${PROVIDERS.map((p) => p.id).join('、')}`);
    return 1;
  }
  if (!resolved.ids.length) {
    warn('当前没有开启的供应商；请指定 id，例如 node router.mjs login qoder');
    return 1;
  }

  const list = PROVIDERS.filter((p) => resolved.ids.includes(p.id));
  const failed = [];
  for (const p of list) {
    say(`${C.bold}${p.title}${C.reset}`);
    const r = await loginProvider(p, { force });
    if (!r.ok) failed.push(p.id);
  }

  say('');
  if (failed.length) {
    bad(`以下供应商仍未登录：${failed.join('、')}`);
    return 1;
  }
  ok('登录检查完成');
  return 0;
}

function cmdLogs(args) {
  let lines = 40;
  const ids = [];
  for (const a of args) {
    if (/^\d+$/.test(a)) lines = Number(a);
    else ids.push(a);
  }

  if (ids.length === 0) {
    say(`${C.bold}日志位置${C.reset}`);
    for (const p of PROVIDERS) {
      say(`  ${p.id.padEnd(18)} ${p.logs.join('、')}`);
    }
    say(`\n${dim('用法：node router.mjs logs <id> [行数]')}`);
    return 0;
  }

  const r = resolveId(ids[0]);
  if (r.error) {
    bad(r.error);
    say(`  可选：${PROVIDERS.map((p) => p.id).join('、')}`);
    return 1;
  }
  const p = r.p;
  for (const file of p.logs) {
    say(`\n${C.bold}${p.title}${C.reset} ${dim(file)}`);
    if (!fs.existsSync(file)) {
      say(dim('  （还没有日志）'));
      continue;
    }
    const text = tailFile(file, lines);
    if (!text.trim()) say(dim('  （空）'));
    else say(text);
  }
  return 0;
}

// ---------------------------------------------------------------- 登录自启

function autostartTask(p) {
  return (p.service && p.service.task) || `router-${p.id}`;
}

function autostartWrapper(p) {
  return path.join(RUN_DIR, `autostart-${p.id}.cmd`);
}

function runSchtasks(args) {
  return spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true });
}

/** Windows 计划任务是否存在；非 Windows 返回 null。 */
function taskExists(task) {
  if (!WIN) return null;
  const r = runSchtasks(['/Query', '/TN', task]);
  return r.status === 0;
}

async function cmdService(args) {
  const action = (args[0] || 'status').toLowerCase();
  const rest = args.slice(1);
  const resolved = rest.length ? resolveIds(rest) : { ids: PROVIDERS.map((p) => p.id) };
  if (resolved.error) {
    bad(resolved.error);
    return 1;
  }
  const targets = PROVIDERS.filter((p) => resolved.ids.includes(p.id));

  if (action === 'status') {
    say(`${C.bold}登录自启${C.reset}`);
    say('─'.repeat(88));
    say(`  ${padEnd('供应商', 20)} ${padEnd('方式', 12)} ${padEnd('任务名', 28)} 状态`);
    for (const p of targets) {
      const task = autostartTask(p);
      const exists = taskExists(task);
      const kind = p.control === 'tool' ? '原运维命令' : 'router';
      const state =
        exists === null ? dim('非 Windows') : exists ? `${C.ok}已注册${C.reset}` : `${C.dim}未注册${C.reset}`;
      say(`  ${padEnd(p.title, 20)} ${padEnd(kind, 12)} ${padEnd(task, 28)} ${state}`);
    }
    say('─'.repeat(88));
    say(dim('  service install [id...] 注册；service uninstall [id...] 停止并移除'));
    return 0;
  }

  if (action === 'install') {
    let failed = 0;
    for (const p of targets) {
      if (p.control === 'tool') {
        if (!p.service || !p.service.install) {
          warn(`${p.title} 没有配置自启命令`);
          continue;
        }
        const r = runTool(p.service.install[0], p.service.install.slice(1));
        if (!r.ok) {
          bad(`${p.title} 注册自启失败：${(r.out || r.reason || '').split('\n').slice(-1)[0]}`);
          failed += 1;
          continue;
        }
        const up = await waitPort(p.port, 60000);
        if (up.up) ok(`${p.title} 自启已注册并启动（:${p.port}）`);
        else warn(`${p.title} 自启已注册，但端口还没起来`);
        continue;
      }

      if (!WIN) {
        warn('router 自动启动目前只支持 Windows 计划任务，其它平台请用系统服务管理器');
        continue;
      }
      const task = autostartTask(p);
      const wrapper = autostartWrapper(p);
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(
        wrapper,
        [
          '@echo off',
          'rem 由 router.mjs service install 生成，请勿手工编辑。',
          `"${process.execPath}" "${path.join(HERE, 'router.mjs')}" _autostart ${p.id}`,
          '',
        ].join('\r\n'),
      );
      const tr = wrapper.includes(' ') ? `"${wrapper}"` : wrapper;
      const c = runSchtasks(['/Create', '/TN', task, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
      if (c.status !== 0) {
        bad(`${p.title} 注册计划任务失败：${(c.stderr || c.stdout || '').trim().split('\n').slice(-1)[0]}`);
        failed += 1;
        continue;
      }
      runSchtasks(['/Run', '/TN', task]);
      const up = await waitPort(p.port, 60000);
      if (up.up) ok(`${p.title} 自启已注册并启动（:${p.port}）`);
      else warn(`${p.title} 自启已注册，但端口还没起来（看 logs ${p.id}）`);
    }
    return failed ? 1 : 0;
  }

  if (action === 'uninstall') {
    let failed = 0;
    for (const p of targets) {
      const task = autostartTask(p);
      if (p.control === 'tool') {
        if (!p.service || !p.service.uninstall) {
          warn(`${p.title} 没有配置移除自启命令`);
          continue;
        }
        await doDown([p], { quiet: true });
        const r = runTool(p.service.uninstall[0], p.service.uninstall.slice(1));
        if (r.ok) ok(`${p.title} 自启已移除`);
        else {
          bad(`${p.title} 移除自启失败：${(r.out || r.reason || '').split('\n').slice(-1)[0]}`);
          failed += 1;
        }
        continue;
      }

      if (WIN) {
        runSchtasks(['/End', '/TN', task]);
        await doDown([p], { quiet: true });
        runSchtasks(['/Delete', '/TN', task, '/F']);
        try {
          fs.unlinkSync(autostartWrapper(p));
        } catch {}
        ok(`${p.title} 自启已移除`);
      } else {
        warn('router 自动启动目前只支持 Windows 计划任务');
      }
    }
    return failed ? 1 : 0;
  }

  usage();
  bad(`未知 service 子命令：${action}`);
  return 1;
}

// ---------------------------------------------------------------- 自检

async function cmdDoctor() {
  let issues = 0;
  say(`${C.bold}router 自检${C.reset}`);
  say('─'.repeat(92));
  say(`  ${C.ok} node ${process.version}  ${dim(process.execPath)}`);

  if (fs.existsSync(STATE_FILE)) {
    try {
      JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      bad(`状态文件不是合法 JSON：${STATE_FILE}`);
      issues += 1;
    }
  }

  for (const p of PROVIDERS) {
    const checks = [];
    if (p.control === 'tool') {
      const script = findToolScript(p.start ? p.start[0] : '');
      if (!script) {
        checks.push(`${C.bad} 找不到运维命令 ${p.start ? p.start[0] : '?'}`);
        issues += 1;
      } else {
        checks.push(`${C.ok} ${path.basename(script)}`);
      }
      const exists = taskExists(autostartTask(p));
      if (exists === false) checks.push(`${C.warn} 未注册自启`);
    } else {
      for (const spec of p.processes) {
        const r = inspectSpec(spec, { create: false });
        if (r.error) {
          checks.push(`${C.bad} ${spec.name}：${r.error}`);
          issues += 1;
        } else {
          checks.push(`${C.ok} ${spec.name}`);
        }
      }
    }
    const probe = await probePort(p.port);
    checks.push(probe.up ? `${C.ok} :${p.port} 在线` : `${C.dim} :${p.port} 未开`);
    say(`  ${padEnd(p.title, 20)} ${checks.join('  ')}`);
  }

  const mod = requireShared('opencode-config.js');
  if (mod) say(`  ${C.ok} opencode-config.js`);
  else {
    warn('找不到 opencode-config.js：写/删 provider 会退化为有限功能');
    issues += 1;
  }
  const oc = ocConfigPath();
  if (fs.existsSync(oc)) say(`  ${C.ok} ${oc}`);
  else warn(`opencode 配置还不存在：${oc}`);

  say('─'.repeat(92));
  if (issues === 0) say(`${C.ok} 自检通过`);
  else say(`${C.warn} ${issues} 项需要处理`);
  return issues ? 1 : 0;
}

// ---------------------------------------------------------------- 帮助

function usage() {
  say(`router — 统一启动、停止、重启本机反代

用法：
  node router.mjs list [--json]          看各家状态（开关 / 进程 / 管理方式 / opencode / 端口）
  node router.mjs up [id...] [--login]   按当前开关启动；缺凭证时打开浏览器登录
  node router.mjs start [id...]          up 的别名
  node router.mjs login [id...] [--force]   浏览器登录；默认只处理当前开启的
  node router.mjs down [id...] [--keep-oc]  停止；不带 id 时停全部；--keep-oc 保留 provider
  node router.mjs stop [id...]           down 的别名
  node router.mjs restart [id...]        重启；不带 id 时重启当前开启的
  node router.mjs logs <id> [行数]       看日志尾部（不带 id 列出所有日志位置）
  node router.mjs on <id...>             只开这几家，其余关掉（立刻生效）
  node router.mjs off <id...>            关掉这几家，其余保持
  node router.mjs all / none             全开 / 全关
  node router.mjs reload                 down + up（改完开关后重放）
  node router.mjs sync                   只同步 opencode 配置
  node router.mjs service [status]       看登录自启状态
  node router.mjs service install [id...]    注册登录自启（Windows 计划任务）
  node router.mjs service uninstall [id...]  停止并移除登录自启
  node router.mjs doctor                 自检（命令、文件、端口、opencode）

供应商 id：
${PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.title}${p.control === 'spawn' ? dim(' （router 直接托管）') : ''}`).join('\n')}

例：
  node router.mjs on qoder-cn                    只开 Qoder 国内版
  node router.mjs login qoder                    打开浏览器登录 Qoder 国际版
  node router.mjs up trae-local codearts          只启动 Trae 和 CodeArts，不改开关
  node router.mjs logs trae-local 80              看 Trae 日志尾部
  node router.mjs restart workbuddy-global        重启 WorkBuddy 国际版
  node router.mjs none                            全部关掉（省内存）
  node router.mjs service install trae-local      让 Trae 登录时自动启动

状态文件：${STATE_FILE}
运行记录：${PROCESS_FILE}`);
}

// ---------------------------------------------------------------- 入口

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'list').toLowerCase();
  const raw = argv.slice(1);
  const quiet = raw.includes('--quiet');
  const json = raw.includes('--json');
  const keepOc = raw.includes('--keep-oc');
  const args = raw.filter((a) => !a.startsWith('--'));
  // 交互式终端里，启动时发现缺凭证就打开浏览器；计划任务/管道里只提示，避免卡住。
  const autoLogin =
    !raw.includes('--no-login') && (raw.includes('--login') || (process.stdin.isTTY && process.stdout.isTTY));

  // on/off/all/none 都要先改开关，再决定要不要立刻生效
  if (cmd === 'on' || cmd === 'off') {
    if (args.length === 0) {
      usage();
      return 1;
    }
    const resolved = resolveIds(args);
    if (resolved.error) {
      bad(resolved.error);
      say(`  可选：${PROVIDERS.map((p) => p.id).join('、')}`);
      return 1;
    }
    const before = currentEnabled();
    const next =
      cmd === 'on'
        ? resolved.ids // on = 只留这些
        : before.filter((id) => !resolved.ids.includes(id)); // off = 从现有里去掉
    const saved = writeState(next);

    const added = saved.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !saved.includes(id));
    if (added.length) ok(`已开启：${added.join('、')}`);
    if (removed.length) ok(`已关闭：${removed.join('、')}`);
    if (!added.length && !removed.length) say(dim('开关没有变化'));

    // 立刻生效：新开的启进程，关掉的停进程
    const toUp = PROVIDERS.filter((p) => added.includes(p.id));
    const toDown = PROVIDERS.filter((p) => removed.includes(p.id));
    if (toDown.length) await doDown(toDown);
    if (toUp.length) await doUp(toUp);
    if (toUp.length) await ensureLogins(toUp, { auto: autoLogin });
    if (toUp.length || toDown.length) await doSyncOpenCode(saved, { startIds: added });

    say('');
    await cmdList();
    return 0;
  }

  if (cmd === 'all' || cmd === 'none') {
    const saved = writeState(cmd === 'all' ? PROVIDERS.map((p) => p.id) : []);
    ok(cmd === 'all' ? '已全部开启' : '已全部关闭');
    if (cmd === 'all') {
      await doUp(PROVIDERS);
      await ensureLogins(PROVIDERS, { auto: autoLogin });
    } else {
      await doDown(PROVIDERS);
    }
    await doSyncOpenCode(saved, { startIds: cmd === 'all' ? saved : [] });
    say('');
    await cmdList();
    return 0;
  }

  if (cmd === 'up' || cmd === 'start') {
    const resolved = args.length ? resolveIds(args) : { ids: currentEnabled() };
    if (resolved.error) {
      bad(resolved.error);
      return 1;
    }
    const list = PROVIDERS.filter((p) => resolved.ids.includes(p.id));
    const failed = await doUp(list, { quiet });
    await ensureLogins(list, { auto: autoLogin });
    // 不带 id 时严格同步开关；带 id 时只保证「不把别家删掉」
    const syncList = args.length
      ? [...new Set([...currentEnabled(), ...resolved.ids])]
      : currentEnabled();
    await doSyncOpenCode(syncList, { startIds: resolved.ids });
    say('');
    await cmdList();
    return failed ? 1 : 0;
  }

  if (cmd === 'down' || cmd === 'stop') {
    const resolved = args.length ? resolveIds(args) : { ids: PROVIDERS.map((p) => p.id) };
    if (resolved.error) {
      bad(resolved.error);
      return 1;
    }
    const list = PROVIDERS.filter((p) => resolved.ids.includes(p.id));
    const failed = await doDown(list, { quiet });
    // 停掉的这几家不应再出现在 opencode 里；其它家保持原状。
    // --keep-oc 用于「只停进程、保留 provider」（例如临时腾内存）。
    if (!keepOc) {
      const remaining = currentEnabled().filter((id) => !resolved.ids.includes(id));
      await doSyncOpenCode(remaining);
    } else {
      say(dim('已保留 opencode provider（--keep-oc）'));
    }
    say('');
    await cmdList();
    return failed ? 1 : 0;
  }

  if (cmd === 'restart') {
    const resolved = args.length ? resolveIds(args) : { ids: currentEnabled() };
    if (resolved.error) {
      bad(resolved.error);
      return 1;
    }
    const list = PROVIDERS.filter((p) => resolved.ids.includes(p.id));
    const failed = await doRestart(list, { quiet });
    await ensureLogins(list, { auto: autoLogin });
    const syncList = args.length
      ? [...new Set([...currentEnabled(), ...resolved.ids])]
      : currentEnabled();
    await doSyncOpenCode(syncList, { startIds: resolved.ids });
    say('');
    await cmdList();
    return failed ? 1 : 0;
  }

  if (cmd === 'reload') {
    const enabled = currentEnabled();
    say(`${C.bold}重放${C.reset}  按当前开关先停再启`);
    await doDown(PROVIDERS, { quiet: true });
    const list = PROVIDERS.filter((p) => enabled.includes(p.id));
    const failed = await doUp(list);
    await ensureLogins(list, { auto: autoLogin });
    await doSyncOpenCode(enabled, { startIds: enabled });
    say('');
    await cmdList();
    return failed ? 1 : 0;
  }

  if (cmd === 'sync') {
    const changed = await doSyncOpenCode(currentEnabled());
    if (!changed) say(dim('opencode 配置已与当前开关一致，无需改动'));
    return 0;
  }

  if (cmd === 'login') return cmdLogin(raw);
  if (cmd === 'logs') return cmdLogs(args);
  if (cmd === 'service') return cmdService(args);
  if (cmd === 'doctor' || cmd === 'check') return cmdDoctor();
  if (cmd === 'list' || cmd === 'status') return cmdList({ json });

  // 计划任务调用：只启动一家，不碰开关和 opencode（避免登录时改用户配置）
  if (cmd === '_autostart') {
    const resolved = resolveId(args[0] || '');
    if (resolved.error) return 1;
    const failed = await doUp([resolved.p], { quiet: true });
    return failed ? 1 : 0;
  }

  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage();
    return 0;
  }

  usage();
  bad(`未知命令：${cmd}`);
  return 1;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

