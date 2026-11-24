#!/usr/bin/env node
/**
 * router.mjs — 统一启动、停止、重启、探活本机所有反代。
 *
 * 十三家全常驻会同时挂着十几个子进程（Trae 两段式），而多数时候你只用其中一两个。这里让
 * 「开哪几个」变成一个显式选择，并且这个选择要落到三处，缺一处就会出现
 * 「以为关了其实还在跑」或「以为开了但客户端看不到」：
 *
 *   1. 后端进程（代理/反代）—— 真正干活的那一层
 *   2. pi 的模型可见性     —— provider 注册与模型目录
 *   3. opencode 的 provider —— 写进 opencode.json 的那份
 *
 * 从 2026-11 起，router 直接托管全部十三家反代，不再依赖 qoder2pi /
 * workbuddy2pi 的计划任务来拉起进程（计划任务在本机并不总是可靠）：
 *
 *   - 每家的命令行、环境变量、日志、端口都写在 PROVIDERS 里
 *   - PID 与启动信息落在 .run/processes.json
 *   - 停止时按「PID 树 + 监听端口」双重清理，避免 Windows 上常见的
 *     「停了包装进程、子进程还在监听」
 *   - 登录自启用 `service install` 生成 router-<id> 计划任务
 *
 * qoder2pi / workbuddy2pi 仍用于登录、续期，以及 WorkBuddy 写 opencode 时读取
 * pi 的模型清单；账号切换已收进 `router account`，启动和停止也不再经过它们。
 *
 * 用法：
 *   node router.mjs list                 看各家状态与开关
 *   node router.mjs up / start           按当前选择启动（也可以带 id）
 *   node router.mjs down / stop          停止（不带 id 时停全部）
 *   node router.mjs restart [id...]      重启
 *   node router.mjs logs <id> [行数]     看日志尾部
 *   node router.mjs account [id] [账号]  查看 / 切换账号
 *   node router.mjs on qoder-cn trae     只开这两家（其余关掉）
 *   node router.mjs off workbuddy        额外关掉某几家
 *   node router.mjs all / none           全开 / 全关
 *   node router.mjs reload               改完选择后重放一次（down + up）
 *   node router.mjs service ...          登录自启（Windows 计划任务）
 *   node router.mjs pi [sync|install]       pi 的模型表与积分/签到扩展
 *   node router.mjs sync-homes [--status] 双系统账号/配置同步
 *   node router.mjs doctor               自检
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// 本文件是 ESM（.mjs），而 E:\qodbuddy2pi 里的共享模块是 CommonJS，
// 所以 require 要经由 createRequire 拿回来——同一套加载器不能混用。
const require = createRequire(import.meta.url);
const qwenworkCredentials = require('./integrations/qwenwork2api/credentials.js');

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
// ZCode（Z.ai 的编程工作台）额度反代：azrinaldi/zcode-bridge（MIT，Go 标准库单二进制）
const ZCODE_DIR =
  process.env.ROUTER_ZCODE_DIR || localOr(path.join(INTEGRATIONS_DIR, 'zcode-bridge'), path.join(HOME, 'zcode-bridge'));
const ZCODE_ACCOUNTS_FILE =
  process.env.ZCODE_ACCOUNTS_FILE || path.join(ZCODE_DIR, 'data', 'accounts.json');
// Loomy（讯飞）反代：本仓库自写，零依赖 Node 脚本，读桌面端登录态并转成 OpenAI 兼容端点。
const LOOMY_DIR =
  process.env.ROUTER_LOOMY_DIR || path.join(INTEGRATIONS_DIR, 'loomy2api');
// 商汤小浣熊（Raccoon Work）反代：同样是本仓库自写，零依赖 Node。上游本来就
// 说 OpenAI，代理只补 IAM 鉴权、模型目录与积分。
const RACCOON_DIR =
  process.env.ROUTER_RACCOON_DIR || path.join(INTEGRATIONS_DIR, 'raccoon2api');
// 千问办公（QwenWork CN）反代：本仓库自写。上游原生支持 OpenAI 与 Anthropic 两种方言，
// 代理主要解决「凭据在 Electron 的 OSCrypt 容器里」这一层。
const QWENWORK_DIR =
  process.env.ROUTER_QWENWORK_DIR || path.join(INTEGRATIONS_DIR, 'qwenwork2api');
// 百度搭子（DuMate）反代：本仓库自写。桌面端的 main-server 端口每次启动随机，
// 代理自动发现端口、读桌面端落盘的模型目录，并复用其免鉴权的 qianfanproxy。
const DUMATE_DIR =
  process.env.ROUTER_DUMATE_DIR || path.join(INTEGRATIONS_DIR, 'dumate2api');
// WPS 灵犀反代：本仓库自写。自己 spawn lingxi.exe app-server（JSON-RPC stdio），
// 从 Electron cookie jar 解出 wps_sid 鉴权，提供 OpenAI 兼容对话 + 智点余额。
const LINGXI_DIR =
  process.env.ROUTER_LINGXI_DIR || path.join(INTEGRATIONS_DIR, 'lingxi2api');
// 有道龙虾（LobsterAI）反代：本仓库自写。桌面端已经在 127.0.0.1 的随机端口上跑了
// 一个 tokenProxy（负责 access token 刷新与用量上报），反代优先复用它；桌面端退到
// 后台时再用 SQLite 里的 access token 直连上游。模型目录、积分与签到由反代补齐。
const LOBSTER_DIR =
  process.env.ROUTER_LOBSTER_DIR || path.join(INTEGRATIONS_DIR, 'lobsterai2api');

// 统一网关：把上面十三家拼成一个端口、两种方言。它不是「第十四家反代」，而是前面的一层，
// 所以端口单独留一个（默认 8785，不占用任何一家的端口段）。
const GATEWAY_DIR = path.join(HERE, 'gateway');
const GATEWAY_PORT = Number(process.env.ROUTER_GATEWAY_PORT || 8785);

// 登录态的文件位置。只读/只写这些文件，不通过日志或表格输出 token。
const PI_AGENT_DIR = path.join(HOME, '.pi', 'agent');
const PI_AUTH_FILE = path.join(PI_AGENT_DIR, 'auth.json');
const PI_MODELS_FILE = path.join(PI_AGENT_DIR, 'models.json');
const PI_EXTENSIONS_DIR = path.join(PI_AGENT_DIR, 'extensions');
const PI_CREDITS_DIR = path.join(PI_EXTENSIONS_DIR, 'qodbuddy2pi');
const PI_LIMITS_DIR = path.join(PI_EXTENSIONS_DIR, 'token-limits');
const PI_MODELS_SCRIPT = path.join(HERE, 'scripts', 'pi-models.mjs');
const CODEARTS_DATA_FILE = path.join(CODEARTS_DIR, 'codearts2api-data.json');
const WORKBUDDY_LIVE_FILES = {
  workbuddy: path.join(HOME, '.codebuddy-session.json'),
  'workbuddy-global': path.join(HOME, '.codebuddy-global-session.json'),
};
// WorkBuddy 的账号池：每个 slot 一份凭证，生效文件是上面那两个（复制式切换，不是软链）
const WORKBUDDY_SLOT_DIRS = {
  workbuddy: path.join(HOME, '.workbuddy2api', 'sessions'),
  'workbuddy-global': path.join(HOME, '.workbuddy2api', 'sessions-global'),
};
const TRAE_AUTHS_DIR = path.join(TRAE_DIR, 'auths');
const TRAE_STATE_FILE = path.join(TRAE_DIR, 'data', 'state.json');

// ---------------------------------------------------------------- 输出

const C = {
  ok: '\x1b[1;32m✓\x1b[0m',
  bad: '\x1b[1;31m✗\x1b[0m',
  warn: '\x1b[1;33m!\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

// --json 时切换过程仍会调用 say/ok 等输出函数；先静音并留在缓冲里，
// 成功只吐一份 JSON，失败则把最后几行放进 messages，方便脚本定位。
let MUTE_OUTPUT = false;
const OUTPUT_BUF = [];
const say = (...a) => {
  if (MUTE_OUTPUT) OUTPUT_BUF.push(a.join(' '));
  else console.log(...a);
};
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
  // Windows 的 .exe 在 Linux/macOS 上不可执行：非 Windows 平台跳过它，
  // 否则仓库里同时放着 tw2api.exe 与 tw2api 时会选错。
  const usable = WIN ? names : names.filter((name) => !/\.exe$/i.test(name));
  for (const name of usable) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return path.join(dir, usable[0] || names[0]);
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

/**
 * pi 的 models.json 里某个 provider 的模型数组；没有就返回 null。
 *
 * 用它的场景：反代的 `/v1/models` 需要桌面端登录态，未登录时回 401。
 * 这时 opencode 里就永远写不进这家 provider，模型选择器里是空的；
 * 而 pi 的模型表是 `scripts/pi-models.mjs` 早先登录时拉下来的快照，
 * 拿它兜底比「写不进去」好——模型 id 与反代一致，登录后 sync 会自动换成实时目录。
 */
function piModelsFor(providerId) {
  try {
    const cfg = readJsonFile(path.join(HOME, '.pi', 'agent', 'models.json'));
    const p = cfg && cfg.providers && cfg.providers[providerId];
    return p && Array.isArray(p.models) && p.models.length ? p.models : null;
  } catch {
    return null;
  }
}

/** pi 的模型条目 → 反代 `/v1/models` 的形状，两种来源就能走同一段写 opencode 的代码。 */
function piModelAsListed(entry, { noTools = false } = {}) {
  if (!entry || !entry.id) return null;
  const input = Array.isArray(entry.input) ? entry.input : ['text'];
  const caps = entry.capabilities || {};
  return {
    id: entry.id,
    name: entry.name || entry.id,
    context_length: entry.contextWindow,
    max_output_tokens: entry.maxTokens,
    capabilities: {
      vision: input.includes('image') || caps.vision === true,
      reasoning: entry.reasoning === true || caps.reasoning === true,
      // pi 的 models.json schema 没有工具能力位，所以灵犀这种「不吐 tool_calls」的
      // 供应商要靠 provider 上的 ocNoTools 显式传进来，否则会被当成能驱动编码 agent。
      tool_call: !noTools && entry.toolCall !== false && entry.tool_call !== false && caps.tool_call !== false,
    },
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 统一到期时间单位：兼容 Unix 秒、毫秒与字符串数字。 */
function normalizeExpiryMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** 到期时间只用于提示，不参与「是否已登录」的判断。 */
function expiryLabel(expires) {
  const ms = normalizeExpiryMs(expires);
  if (ms === null) return '';
  // 用毫秒判断过期，别用「剩余天数」：-1.5 小时的 ceil 是 0，会显示成「剩 0 天」而不是已过期。
  if (ms <= Date.now()) return '，已过期';
  const days = Math.ceil((ms - Date.now()) / 86400000);
  return `，剩 ${days} 天`;
}

/** 给 TUI/脚本用的结构化认证状态；label 仍只用于人类可读输出。 */
function authResult(ok, label, expires) {
  if (!ok) return { ok: false, state: 'missing', expiresAt: null, label };
  const ms = normalizeExpiryMs(expires);
  if (ms === null) return { ok: true, state: 'unknown', expiresAt: null, label };
  if (ms <= Date.now()) return { ok: true, state: 'expired', expiresAt: new Date(ms).toISOString(), label };
  const days = Math.ceil((ms - Date.now()) / 86400000);
  return {
    ok: true,
    state: days < 3 ? 'expiring' : 'valid',
    expiresAt: new Date(ms).toISOString(),
    label,
  };
}

function shortUser(id) {
  return id ? `userID ${String(id).slice(0, 8)}…` : '已登录';
}

function qoderAuth(provider) {
  const entry = (readJsonFile(PI_AUTH_FILE) || {})[provider];
  if (!entry || !entry.access) return authResult(false, '未登录（auth.json 里没有 access）');
  return authResult(true, `已登录（${shortUser(entry.userID)}${expiryLabel(entry.expires)}）`, entry.expires);
}

function workbuddyAuth(id) {
  const live = readJsonFile(WORKBUDDY_LIVE_FILES[id]);
  const token = live && live.auth && live.auth.accessToken;
  if (typeof token !== 'string' || !token) return authResult(false, '未登录（无生效凭证）');
  const who = (live.account && (live.account.nickname || live.account.uid)) || '已登录';
  return authResult(true, `已登录（${who}${expiryLabel(live.auth.expiresAt)}）`, live.auth.expiresAt);
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
      return authResult(true, `已登录（${who}${expiryLabel(d.auth.expiresAt)}）`, d.auth.expiresAt);
    }
  }
  return authResult(false, '未登录（auths 里没有有效凭证）');
}

function codeartsAuth() {
  const data = readJsonFile(CODEARTS_DATA_FILE);
  const accounts = (data && Array.isArray(data.accounts) && data.accounts) || [];
  const usable = accounts.filter((a) => a && a.enabled !== false && a.session);
  if (!usable.length) return authResult(false, '未登录（账号池为空）');
  const names = usable.map((a) => a.name || '账号').slice(0, 2).join('、');
  return {
    ok: true,
    state: 'valid',
    expiresAt: null,
    label: `已登录（${names}${usable.length > 2 ? ' 等' : ''}）`,
  };
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
    case 'zcode':
      return zcodeAuth();
    case 'loomy':
      return loomyAuth();
    case 'raccoon':
      return raccoonAuth();
    case 'qwenwork':
      return qwenworkAuth();
    case 'dumate':
      return dumateAuth();
    case 'lingxi':
      return lingxiAuth();
    case 'lobster':
      return lobsterAuth();
    case 'gateway':
      // 网关没有上游凭证：它靠下面几家反代的凭证工作，自己永远是「就绪」。
      return authResult(true, `聚合 ${PROVIDERS.length - 1} 家反代`);
    default:
      return authResult(true, '未知');
  }
}

// ---------------------------------------------------------------- 账号切换
//
// 各家反代里有几家的账号可以切换，且生效方式各不相同：
//
//   WorkBuddy 国内/国际  ~/.workbuddy2api/sessions{,-global}/<slot>.json 是账号池，
//                        ~/.codebuddy{,-global}-session.json 是生效凭证。切换 = 把目标
//                        slot 复制到生效文件；反代只在启动时读它，所以运行中要重启。
//   CodeArts             codearts2api-data.json 的 accounts[]，网关按 enabled 轮询。
//                        「切到某个账号」= 只留它一个 enabled；网关在跑时走
//                        /admin/api/accounts 的 toggle，避免直接改文件被持久化覆盖。
//   Trae                 auths/trae-<uid>.json 是凭证池，data/state.json 的
//                        accounts[uid].disabled 决定是否参与调度。切换同样只留一个，
//                        tw2api 只在启动时读 state，因此要重启。
//   Qoder                ~/.pi/agent/auth.json 每个区域只有一条凭证，没有多账号池，
//                        这里只展示当前账号；换号请重新登录。
//
// 所有切换都先打印「将要发生什么」，支持 --dry-run；--all 把账号池恢复为全部启用。

/** 原子写 JSON：先写临时文件再改名，避免反代正好读到半截文件。 */
function writeJsonAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  if (mode) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {}
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text, mode ? { mode } : undefined);
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** 账号显示名；WorkBuddy 国际版会把 nickname 落成加密对象，只接受字符串。 */
function accountName(account = {}) {
  const nick = account.nickname;
  if (typeof nick === 'string' && nick.trim()) return nick;
  return account.uin || account.uid || '<未知>';
}

function shortUid(uid) {
  const s = String(uid || '');
  return s.length > 14 ? `${s.slice(0, 14)}…` : s || '?';
}

function localDay(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 按 access_token 到期时间给一句短说明，不给 token 本身。 */
function accessNote(expiresAt) {
  return expiryLabel(expiresAt).replace(/^，/, '');
}

function readWorkbuddySlots(p) {
  const dir = WORKBUDDY_SLOT_DIRS[p.id];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort();
  } catch {}
  return files
    .map((f) => {
      const file = path.join(dir, f);
      const data = readJsonFile(file);
      if (!data) return null;
      const account = data.account || {};
      return {
        key: f.replace(/\.json$/i, ''),
        name: accountName(account),
        uid: account.uid || null,
        file,
        expiresAt: data.auth && data.auth.expiresAt,
      };
    })
    .filter(Boolean);
}

function workbuddyAccounts(p) {
  const live = readJsonFile(WORKBUDDY_LIVE_FILES[p.id]);
  const liveUid = live && live.account && live.account.uid;
  const rows = readWorkbuddySlots(p).map((s) => ({
    key: s.key,
    name: s.name,
    uid: s.uid,
    enabled: true,
    active: !!(liveUid && s.uid && String(liveUid) === String(s.uid)),
    detail: [`uid ${shortUid(s.uid)}`, accessNote(s.expiresAt)].filter(Boolean).join(' · '),
    expiresAt: s.expiresAt,
    _file: s.file,
  }));
  // 生效文件里是一个没有 slot 的账号（例如手工换过凭证）：照样列出来，
  // 否则会显示「没有可用账号」而其实正在登录。
  if (liveUid && !rows.some((a) => a.active)) {
    rows.unshift({
      key: '(live)',
      name: accountName(live.account || {}),
      uid: liveUid,
      enabled: true,
      active: true,
      detail: `uid ${shortUid(liveUid)} · 生效中，未入账号池`,
      expiresAt: live && live.auth && live.auth.expiresAt,
      _file: null,
    });
  }
  return rows;
}

function codeartsAccounts() {
  const data = readJsonFile(CODEARTS_DATA_FILE);
  const accounts = (data && Array.isArray(data.accounts) && data.accounts) || [];
  const rows = accounts.map((a) => ({
    key: a.id,
    name: a.name || a.id,
    uid: a.id,
    enabled: a.enabled !== false,
    active: false,
    status: a.status || null,
    failures: Number(a.failures) || 0,
    lastErr: a.last_err || null,
    expiresAt: a.session && a.session.expires_at,
    detail: [
      a.enabled === false ? '已停用' : '',
      a.status && a.status !== 'ok' ? `状态 ${a.status}` : '',
      Number(a.failures) > 0 ? `失败 ${a.failures}` : '',
      a.last_used ? `最近 ${localDay(a.last_used)}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  const enabled = rows.filter((a) => a.enabled);
  if (enabled.length === 1) enabled[0].active = true;
  return rows;
}

function traeAccounts() {
  let files = [];
  try {
    files = fs.readdirSync(TRAE_AUTHS_DIR).filter((f) => /^trae-.*\.json$/i.test(f)).sort();
  } catch {}
  const state = readJsonFile(TRAE_STATE_FILE) || {};
  const byUid = state.accounts || {};
  const rows = files
    .map((f) => {
      const data = readJsonFile(path.join(TRAE_AUTHS_DIR, f));
      if (!data) return null;
      const account = data.account || {};
      const uid = String(account.uid || f.replace(/^trae-|\.json$/gi, ''));
      const st = byUid[uid] || {};
      const cooling = st.until && Date.parse(st.until) > Date.now();
      return {
        key: uid,
        name: accountName(account),
        uid,
        enabled: st.disabled !== true,
        active: false,
        credits: st.credits == null ? null : Number(st.credits),
        cooling: !!cooling,
        reason: st.reason || null,
        expiresAt: data.auth && data.auth.expiresAt,
        file: path.join(TRAE_AUTHS_DIR, f),
        detail: [
          st.credits != null ? `${st.credits} 积分` : '',
          st.disabled === true ? '已停用' : '',
          cooling ? `冷却中（${st.reason || '错误过多'}）` : '',
          accessNote(data.auth && data.auth.expiresAt),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    })
    .filter(Boolean);
  const enabled = rows.filter((a) => a.enabled);
  if (enabled.length === 1) enabled[0].active = true;
  return rows;
}

function qoderAccounts(p) {
  const entry = (readJsonFile(PI_AUTH_FILE) || {})[p.ocProvider];
  if (!entry || !entry.access) return [];
  return [
    {
      key: p.ocProvider,
      name: entry.name || entry.email || shortUser(entry.userID),
      uid: entry.userID || null,
      enabled: true,
      active: true,
      expiresAt: entry.expires,
      detail: [entry.email || '', expiryLabel(entry.expires).replace(/^，/, '')].filter(Boolean).join(' · '),
    },
  ];
}

/**
 * ZCode 的账号池：zcode-bridge 的 data/accounts.json。
 * 每条是 `zcode-bridge login`（OAuth 设备码）拿到的一份套餐授权；default 是轮询头。
 */
function zcodeStore() {
  return readJsonFile(ZCODE_ACCOUNTS_FILE) || { version: 1, accounts: [] };
}

function zcodeAccounts() {
  const data = zcodeStore();
  const list = Array.isArray(data.accounts) ? data.accounts : [];
  const def = data.default;
  const rows = list.map((a) => ({
    key: a.id,
    name: a.label || a.email || a.id,
    uid: a.userId || a.id,
    enabled: true,
    active: a.id === def,
    expiresAt: a.expiresAt,
    needsReauth: !!a.needsReauth,
    hasRefresh: !!a.refreshToken,
    detail: [
      a.email || '',
      a.refreshToken ? '可自动续期' : '无 refresh',
      expiryLabel(a.expiresAt).replace(/^，/, ''),
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  // 没有 default 时，第一条就是实际轮询头
  if (!rows.some((r) => r.active) && rows.length) rows[0].active = true;
  // 一个账号都没有时，bridge 会回落到 plan-jwt.json，再回落到 ZCode 桌面端凭据。
  // 把它也列出来，否则界面显示“没有账号”，实际却在用兜底凭据。
  if (!rows.length) {
    const pinned = zcodeSingleToken();
    if (pinned) {
      rows.push({
        key: '(pinned)',
        name: '固定凭据 plan-jwt.json',
        uid: null,
        enabled: true,
        active: true,
        detail: '在 integrations/zcode-bridge/plan-jwt.json 里固定，不跟随桌面端换号',
      });
    } else if (zcodeDesktopJwt()) {
      rows.push({
        key: '(desktop)',
        name: 'ZCode 桌面端',
        uid: null,
        enabled: true,
        active: true,
        detail: '从 ~/.zcode 读取，跟随桌面端登录状态',
      });
    }
  }
  return rows;
}

/** 单 token 兜底：accounts.json 为空时，bridge 会读 plan-jwt.json。 */
function zcodeSingleToken() {
  const f = path.join(ZCODE_DIR, 'plan-jwt.json');
  if (!fs.existsSync(f)) return null;
  return readJsonFile(f) || { present: true };
}

function zcodeAuth() {
  const rows = zcodeAccounts();
  const usable = rows.filter((a) => !a.needsReauth && a.key !== '(desktop)' && a.key !== '(pinned)');
  if (usable.length) {
    const who = usable.map((a) => a.name).slice(0, 2).join('、');
    return authResult(true, `已登录（${who}${usable.length > 2 ? ' 等' : ''}）`);
  }
  if (zcodeDesktopJwt()) return authResult(true, '已登录（ZCode 桌面端凭据）');
  if (zcodeSingleToken()) return authResult(true, '已登录（plan-jwt.json）');
  return authResult(false, '未登录（accounts.json 为空）');
}

// ---------------------------------------------------------------- Loomy（讯飞）
//
// Loomy 桌面端把登录态放在 C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\userData\
// auth-session.json，字段是 { session, userid, phone, updatedAt }。它没有多账号池，
// 也没有可脚本化的登录接口：换号只能在桌面端退出再登录。反代读同一份文件，所以
// 桌面端登录一次，router / pi / opencode 立刻都能用。

function loomyConfigRoot() {
  const override = String(process.env.LOOMY_CONFIG_ROOT || '').trim();
  if (override) return override;
  if (WIN) {
    const hash = createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12);
    return path.join('C:', 'Users', 'Public', 'Loomy', hash);
  }
  return path.join(HOME, '.config', 'loomy');
}

function loomyAuthFile() {
  const explicit = String(process.env.LOOMY_AUTH_FILE || '').trim();
  if (explicit) return explicit;
  const root = loomyConfigRoot();
  for (const file of [
    path.join(root, 'userData', 'auth-session.json'),
    path.join(HOME, '.config', 'loomy', 'auth-session.json'),
  ]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return path.join(root, 'userData', 'auth-session.json');
}

function readLoomySession() {
  const data = readJsonFile(loomyAuthFile());
  const token = data && String(data.session || '').trim();
  if (!token) return null;
  return {
    token,
    userid: String(data.userid || '').trim(),
    phone: String(data.phone || '').trim(),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

function maskPhone(phone) {
  const s = String(phone || '').trim();
  if (s.length < 7) return s ? `${s.slice(0, 2)}***` : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function loomyAuth() {
  const session = readLoomySession();
  if (!session) return authResult(false, '未登录（打开 Loomy 桌面端登录后自动生效）');
  const who = maskPhone(session.phone) || shortUser(session.userid);
  // session token 没有到期时间；本地能确认的只有“文件里有非空 token”。
  // state=valid 让 TUI 显示“正常”，真正的失效会在请求时由上游 401 暴露。
  return { ok: true, state: 'valid', expiresAt: null, label: `已登录（${who}）` };
}

function loomyAccounts() {
  const session = readLoomySession();
  if (!session) return [];
  const loggedAt = session.updatedAt
    ? new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })
    : '';
  return [
    {
      key: session.userid || 'loomy',
      name: maskPhone(session.phone) || shortUser(session.userid),
      uid: session.userid || null,
      enabled: true,
      active: true,
      detail: [
        session.phone ? `手机号 ${maskPhone(session.phone)}` : '',
        loggedAt ? `登录于 ${loggedAt}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

// ---------------------------------------------------------------- 百度搭子（DuMate）
//
// 桌面端把登录态写在 Electron userData 的 auth.json：
//   { activeProfileId, accountProfiles: [{ displayName, bceUserId, loginType }] }
// 只有一份账号；换号只能在桌面端退出后重新登录。main-server 的端口与 in-app key
// 都在每次启动时变化，反代自己发现，router 只读登录态用于展示。

function dumateAppData() {
  const explicit = String(process.env.DUMATE_APP_DATA || '').trim();
  if (explicit) return explicit;
  // 与 integrations/dumate2api/dumate-proxy.js 的 appDataRoot() 保持一致：
  // 非 Windows 上桌面端把 userData 放在 ~/.config/qianfan-desktop-app，
  // 写成 APPDATA 会把「已登录」误报成「未登录」。
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(base, 'qianfan-desktop-app');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'qianfan-desktop-app');
}

function readDumateProfile() {
  const data = readJsonFile(path.join(dumateAppData(), 'auth.json'));
  const profiles = (data && Array.isArray(data.accountProfiles) && data.accountProfiles) || [];
  if (!profiles.length) return null;
  const profile =
    profiles.find((p) => p && p.profileId === data.activeProfileId) || profiles[0] || {};
  return {
    name: String(profile.displayName || '').trim(),
    accountId: String(profile.bceUserId || profile.bceAccountId || '').trim(),
    loginType: String(profile.loginType || data.activeProviderType || '').trim(),
    lastLogin: Number(profile.lastSuccessfulLoginAt) || 0,
  };
}

function dumateAuth() {
  const profile = readDumateProfile();
  if (!profile) return authResult(false, '未登录（打开百度搭子桌面端登录后自动生效）');
  const who = profile.name || shortUser(profile.accountId);
  return { ok: true, state: 'valid', expiresAt: null, label: `已登录（${who}）` };
}

function dumateAccounts() {
  const profile = readDumateProfile();
  if (!profile) return [];
  const loggedAt = profile.lastLogin
    ? new Date(profile.lastLogin).toLocaleString('zh-CN', { hour12: false })
    : '';
  return [
    {
      key: profile.accountId || 'dumate',
      name: profile.name || shortUser(profile.accountId),
      uid: profile.accountId || null,
      enabled: true,
      active: true,
      detail: [
        profile.loginType ? `登录方式 ${profile.loginType}` : '',
        loggedAt ? `登录于 ${loggedAt}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

// ---------------------------------------------------------------- WPS 灵犀
//
// 登录态在 Electron 的 cookie jar（Partitions/lingxi-passport-v2-*/Network/Cookies），
// 由反代用 DPAPI + AES-GCM 解出 wps_sid。router 这边**不去解密**：那要起 PowerShell
// 调 DPAPI，放在 list/doctor 这种高频只读路径上太贵。这里只读反代的 /health，
// 它已经缓存了 SID；反代没起时退回「桌面端装没装」这个本地可判的事实。

function lingxiAppData() {
  const explicit = String(process.env.LINGXI_APP_DATA || '').trim();
  if (explicit) return explicit;
  // 与 lingxi-proxy.js 的 appDataRoot() 对齐：Windows 用 %APPDATA%，其它平台用
  // ~/.config。写死不存在的路径会让「装了没登录」被报成「未安装」。
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(base, 'WPS 灵犀');
  }
  const native = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'WPS 灵犀');
  return firstWineOr(native, 'LINGXI_APP_DATA', ['WPS 灵犀']);
}

/**
 * 原生目录优先，其次找 Wine prefix 里的同名 AppData 目录。
 *
 * 灵犀 / 龙虾官方只有 Windows 包，Linux 上靠 Wine 跑；那时登录态写在
 * `<prefix>/drive_c/users/<user>/AppData/Roaming/<产品>`。只看原生路径会把
 * 「Wine 里已登录」误报成「未安装」。
 */
function firstWineOr(nativeDir, explicitEnv, productNames) {
  try {
    const { candidateDirs, firstExistingDir } = require('./integrations/wine-paths.js');
    const hit = firstExistingDir(
      candidateDirs({ explicitEnv, nativeDir, productNames }),
    );
    return hit ? hit.dir : nativeDir;
  } catch {
    return nativeDir;
  }
}

/** 桌面端是否在本机（配置目录存在即算装了；不代表已登录）。 */
function lingxiInstalled() {
  try {
    return fs.statSync(lingxiAppData()).isDirectory();
  } catch {
    return false;
  }
}

/** 读反代 /health 的非敏感视图；反代没起就返回 null。 */
function lingxiHealth() {
  const file = path.join(RUN_DIR, 'lingxi-health.json');
  return readJsonFile(file);
}

function lingxiAuth() {
  if (!lingxiInstalled()) {
    return authResult(false, '未安装 WPS 灵犀桌面端');
  }
  // 登录态只有反代能确认（SID 在加密 cookie 库里）。反代没起时如实说「未知」，
  // 不要凭「装了桌面端」就报已登录——那会让人以为能用。
  return {
    ok: true,
    state: 'unknown',
    expiresAt: null,
    label: '已安装（登录态由反代读 cookie 库确认，见 up lingxi 后的 account）',
  };
}

function lingxiAccounts() {
  if (!lingxiInstalled()) return [];
  // 账号昵称/ID 由反代从上游 /account/profile 取；这里不重复实现那条链路。
  return [
    {
      key: 'lingxi',
      name: 'WPS 灵犀账号',
      uid: null,
      enabled: true,
      active: true,
      detail: '登录态在桌面端 cookie 库；昵称与智点余额见 curl -s http://127.0.0.1:8796/v1/quota',
    },
  ];
}

// ---------------------------------------------------------------- 有道龙虾（LobsterAI）
//
// 桌面端把登录态写在自己的 SQLite（`%APPDATA%\LobsterAI\lobsterai.sqlite`）的
// `kv.auth_tokens` / `kv.auth_user`；对话由桌面端的 tokenProxy 负责，积分走上游
// `/api/subscription`。router 这边只读这两条 kv 做登录态展示，不发请求、不写数据库。
// 读 SQLite 用 Node 22.5+ 的 `node:sqlite`；没有它时如实报「读不到」。

function lobsterAppData() {
  const explicit = String(process.env.LOBSTER_APP_DATA || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'LobsterAI');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'LobsterAI');
  }
  const native = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'LobsterAI');
  return firstWineOr(native, 'LOBSTER_APP_DATA', ['LobsterAI']);
}

function lobsterDbFile() {
  return path.join(lobsterAppData(), 'lobsterai.sqlite');
}

function lobsterInstalled() {
  try {
    return fs.statSync(lobsterAppData()).isDirectory();
  } catch {
    return false;
  }
}

let lobsterSqliteModule;
let lobsterSqliteLoaded = false;

/** 懒加载 node:sqlite：老 Node 上只是读不到，不影响 router 其它命令。 */
function lobsterSqlite() {
  if (lobsterSqliteLoaded) return lobsterSqliteModule;
  lobsterSqliteLoaded = true;
  try {
    lobsterSqliteModule = require('node:sqlite');
  } catch {
    lobsterSqliteModule = null;
  }
  return lobsterSqliteModule;
}

function readLobsterKv(key) {
  const mod = lobsterSqlite();
  if (!mod || !mod.DatabaseSync) return null;
  let db = null;
  try {
    db = new mod.DatabaseSync(lobsterDbFile(), { readOnly: true });
    const row = db.prepare('select value from kv where key = ?').get(key);
    return row && typeof row.value === 'string' ? row.value : null;
  } catch {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

function readLobsterKvJson(key) {
  const text = readLobsterKv(key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readLobsterSession() {
  const tokens = readLobsterKvJson('auth_tokens');
  const token = tokens && String(tokens.accessToken || '').trim();
  if (!token) return null;
  const user = readLobsterKvJson('auth_user') || {};
  const payload = jwtPayload(token);
  const loopback = readJsonFile(path.join(lobsterAppData(), 'openclaw', 'loopback-state.json')) || {};
  return {
    token,
    refreshToken: tokens && String(tokens.refreshToken || ''),
    userId: String(user.userId || (payload && payload.sub) || ''),
    yid: String(user.yid || ''),
    nickname: String(user.nickname || ''),
    accountMode: String(user.accountMode || (payload && payload.accountMode) || 'personal'),
    appVersion: loopback && loopback.appVersion ? String(loopback.appVersion) : '',
    expiresAt: payload && Number(payload.exp) ? Number(payload.exp) * 1000 : null,
  };
}

function lobsterAuth() {
  if (!lobsterInstalled()) return authResult(false, '未安装有道龙虾（LobsterAI）桌面端');
  const session = readLobsterSession();
  if (!session) {
    return authResult(false, `未登录（打开 LobsterAI 桌面端登录；凭据在 ${lobsterDbFile()}）`);
  }
  const who = session.nickname || session.yid || shortUser(session.userId);
  return authResult(true, `已登录（${who}）`, session.expiresAt);
}

function lobsterAccounts() {
  if (!lobsterInstalled()) return [];
  const session = readLobsterSession();
  if (!session) return [];
  return [
    {
      key: session.userId || 'lobster',
      name: session.nickname || session.yid || 'LobsterAI 账号',
      uid: session.userId || null,
      enabled: true,
      active: true,
      expiresAt: session.expiresAt,
      detail: [
        session.accountMode === 'enterprise' ? '企业版' : '个人版',
        session.yid || '',
        session.appVersion ? `桌面端 v${session.appVersion}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

function accountsFor(p) {
  const rows = rawAccountsFor(p);
  for (const a of rows) a.health = accountHealth(p, a);
  return rows;
}

// ---------------------------------------------------------------- 小浣熊（商汤）
//
// 桌面端把 IAM access token 明文写在 `~/.office-raccoon/agent/config/auth.json`：
//   { "access_token": "<JWT>", "office_identity": "personal" }
// 旧版（OfficeV3）的 agent home 是 `~/.box-agent`，老机器上凭证在那里。
// 它没有多账号池，也没有可脚本化的登录接口：换号只能在桌面端退出再登录。

function raccoonAuthCandidates() {
  const explicit = String(process.env.RACCOON_AUTH_FILE || '').trim();
  if (explicit) return [explicit];
  // 与 integrations/raccoon2api/raccoon-proxy.js 的 authCandidates() 保持一致：
  // 非 Windows 上桌面端的 agent home 在 Electron userData 下（~/.config/office-raccoon），
  // 只认 ~/.office-raccoon 会把「已装但未登录」和「已登录」都报成未登录。
  const out = [];
  if (process.platform !== 'win32') {
    const configRoot = process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    out.push(path.join(configRoot, 'office-raccoon', 'agent', 'config', 'auth.json'));
    out.push(path.join(configRoot, 'box-agent', 'config', 'auth.json'));
  }
  out.push(
    path.join(HOME, '.office-raccoon', 'agent', 'config', 'auth.json'),
    path.join(HOME, '.box-agent', 'config', 'auth.json'),
  );
  return out;
}

function raccoonAuthFile() {
  for (const file of raccoonAuthCandidates()) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return raccoonAuthCandidates()[0];
}

/** JWT 的 payload 段；解不开就当没有。只用于显示到期时间，不验签。 */
function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function readRaccoonSession() {
  const data = readJsonFile(raccoonAuthFile());
  const token = data && String(data.access_token || data.token || data.auth_token || '').trim();
  if (!token) return null;
  const payload = jwtPayload(token);
  return {
    token,
    identity: String(data.office_identity || '').trim() || 'personal',
    orgName: String(data.office_org_name || '').trim(),
    subject: (payload && payload.sub) || '',
    expiresAt: payload && Number(payload.exp) ? Number(payload.exp) * 1000 : null,
    updatedAt: fs.existsSync(raccoonAuthFile()) ? fs.statSync(raccoonAuthFile()).mtimeMs : 0,
  };
}

function raccoonIdentityLabel(identity) {
  const v = String(identity || '').trim();
  if (!v || v === 'personal') return '个人版';
  return v;
}

function raccoonAuth() {
  const session = readRaccoonSession();
  if (!session) return authResult(false, '未登录（打开商汤小浣熊桌面端登录后自动生效）');
  const who = [
    raccoonIdentityLabel(session.identity),
    session.orgName ? `组织 ${session.orgName}` : '',
    shortUser(session.subject),
  ]
    .filter(Boolean)
    .join(' · ');
  // IAM token 只有 30 天，且桌面端会用 refresh 自动续期；到期时间用来提示。
  return authResult(true, `已登录（${who}）`, session.expiresAt);
}

function raccoonAccounts() {
  const session = readRaccoonSession();
  if (!session) return [];
  const loggedAt = session.updatedAt
    ? new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })
    : '';
  return [
    {
      key: session.subject || 'raccoon',
      name: raccoonIdentityLabel(session.identity),
      uid: session.subject || null,
      enabled: true,
      active: true,
      expiresAt: session.expiresAt,
      detail: [
        session.orgName ? `组织 ${session.orgName}` : '',
        loggedAt ? `登录于 ${loggedAt}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

// ---------------------------------------------------------------- 千问办公（QwenWork CN）
//
// 与别家最大的不同：**桌面端不把 token 明文落盘**。
//
//   auth-v2.dat          宿主登录态，加密绑定本机身份（不解它）
//   engine-maas-key.dat  MaaS 推理 key，Chromium OSCrypt(`v10`) 加密，
//                        主密钥在 `Local State` 的 os_crypt.encrypted_key（DPAPI 保护）
//
// 所以 router 侧只做「能读到什么就报什么」：
//   - `.status.json` 是明文，有昵称/套餐/登录状态
//   - `engine-maas-key.dat` 存在且够新 → 视为已登录（真正的可用性由反代探活确认）
// 不尝试解密 auth-v2.dat，也不替用户伪造设备身份。

function qwenworkDataDir() {
  const explicit = String(process.env.QWENWORK_DATA_DIR || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'QwenWorkCN');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'QwenWorkCN');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'QwenWorkCN');
}

function qwenworkAgentHome() {
  const explicit = String(process.env.QWENWORK_HOME || '').trim();
  if (explicit) return explicit;
  return path.join(HOME, '.qwenworkcn');
}

function qwenworkStatus() {
  return readJsonFile(path.join(qwenworkAgentHome(), '.status.json'));
}

function qwenworkKeyFile() {
  return path.join(qwenworkAgentHome(), 'engine-maas-key.dat');
}

/** 用 DPAPI 解 OSCrypt 主密钥，再解 engine-maas-key.dat。失败返回 null（只用于判断登录态）。 */
function qwenworkCredential() {
  // 代理签发的缓存。Linux/macOS 走 `auth-v2.dat` → `/api/desktop-sessions`，
  // Windows 也会把桌面端写出的 key 归一化到这里，所以先看它。
  try {
    const cache = qwenworkCredentials.readCachedKey();
    if (cache) {
      const now = Date.now();
      return {
        sessionId: cache.sessionId,
        accessKey: cache.accessKey,
        expiresAtMs: cache.expiresAtMs,
        ttlMs: cache.ttlMs,
        baseUrl: cache.baseUrl,
        source: cache.source,
        count: 1,
        alive: !cache.expiresAtMs || cache.expiresAtMs > now ? 1 : 0,
      };
    }
  } catch {}

  // 还没签发 key，但桌面端已登录：先按登录态显示，反代启动后会签。
  try {
    const auth = qwenworkCredentials.readHostAuth();
    if (!auth.error) {
      return {
        sessionId: '',
        expiresAtMs: auth.expiresAtMs,
        ttlMs: 0,
        baseUrl: '',
        source: auth.source,
        pending: true,
        count: 0,
        alive: 0,
      };
    }
  } catch {}

  if (process.platform !== 'win32') return null;

  // Windows 旧路径：engine-maas-key.dat（桌面端自己签的短 key）
  const file = qwenworkKeyFile();
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const state = readJsonFile(path.join(qwenworkDataDir(), 'Local State'));
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (typeof b64 !== 'string' || !b64) return null;
  let blob = Buffer.from(b64, 'base64');
  if (blob.subarray(0, 5).toString('latin1') === 'DPAPI') blob = blob.subarray(5);
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${blob.toString('base64')}')`,
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const key = Buffer.from(String(r.stdout || '').trim(), 'base64');
  if (key.length !== 32) return null;
  if (buf.subarray(0, 3).toString('latin1') !== 'v10') return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const text = Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]).toString('utf8');
    const doc = JSON.parse(text);
    const creds = doc && doc.credentials && typeof doc.credentials === 'object' ? doc.credentials : {};
    const now = Date.now();
    const rows = Object.entries(creds).map(([id, c]) => ({
      sessionId: id,
      expiresAtMs: Number(c && c.expiresAtMs) || 0,
      ttlMs: Number(c && c.ttlMs) || 0,
      baseUrl: c && typeof c.baseUrl === 'string' ? c.baseUrl : '',
    }));
    const alive = rows.filter((c) => !c.expiresAtMs || c.expiresAtMs > now);
    const pick = (alive.length ? alive : rows).sort((a, b) => (b.expiresAtMs || 0) - (a.expiresAtMs || 0))[0];
    return pick ? { ...pick, count: rows.length, alive: alive.length } : null;
  } catch {
    return null;
  }
}

function qwenworkAuth() {
  const status = qwenworkStatus();
  const cred = qwenworkCredential();
  const who = [status && status.name, status && status.plan].filter(Boolean).join(' · ');

  if (cred && cred.pending) {
    return {
      ok: true,
      state: 'unknown',
      expiresAt: cred.expiresAtMs || null,
      label: `已登录（${who || '千问办公'}，推理凭据由反代自动签发${expiryLabel(cred.expiresAtMs)}）`,
    };
  }
  if (cred) {
    return authResult(true, `已登录（${who || '千问办公'}${expiryLabel(cred.expiresAtMs)}）`, cred.expiresAtMs);
  }
  if (status && status.logged_in === true) {
    // 桌面端说登录了，但取不到 key：多半是桌面端还没发过请求（key 未签发）
    return {
      ok: true,
      state: 'unknown',
      expiresAt: null,
      label: `已登录（${who || '千问办公'}，推理凭据由反代启动后自动签发）`,
    };
  }
  return authResult(false, '未登录（打开千问办公桌面端登录后自动生效）');
}

function qwenworkAccounts() {
  const status = qwenworkStatus();
  const cred = qwenworkCredential();
  if (!status && !cred) return [];
  const loggedAt = status && status.snapshot_at
    ? new Date(status.snapshot_at).toLocaleString('zh-CN', { hour12: false })
    : '';
  return [
    {
      key: (status && (status.username || status.email)) || 'qwenwork',
      name: (status && (status.name || status.username)) || '千问办公',
      uid: (status && status.email) || null,
      enabled: true,
      active: true,
      expiresAt: cred ? cred.expiresAtMs : null,
      detail: [
        status && status.plan ? `套餐 ${status.plan}` : '',
        cred
          ? cred.pending
            ? '宿主登录态有效，推理凭据由反代自动签发'
            : `推理凭据 ${cred.alive}/${cred.count} 条有效`
          : '尚未签发推理凭据',
        loggedAt ? `登录于 ${loggedAt}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];
}

function rawAccountsFor(p) {
  if (p.kind === 'workbuddy') return workbuddyAccounts(p);
  if (p.kind === 'codearts') return codeartsAccounts();
  if (p.kind === 'trae') return traeAccounts();
  if (p.kind === 'qoder') return qoderAccounts(p);
  if (p.kind === 'zcode') return zcodeAccounts();
  if (p.kind === 'loomy') return loomyAccounts();
  if (p.kind === 'raccoon') return raccoonAccounts();
  if (p.kind === 'qwenwork') return qwenworkAccounts();
  if (p.kind === 'dumate') return dumateAccounts();
  if (p.kind === 'lingxi') return lingxiAccounts();
  if (p.kind === 'lobster') return lobsterAccounts();
  return [];
}

/** 对外（含 --json）只暴露这些字段，内部文件路径与 token 不出现。 */
function publicAccount(a) {
  return {
    key: a.key,
    name: a.name,
    uid: a.uid,
    enabled: a.enabled,
    active: a.active,
    detail: a.detail,
    health: a.health,
  };
}

/**
 * 账号健康：只凭本地落盘状态判断，不发请求、不消耗额度。
 *
 * 分成四级，宁愿少报也不要误报——误报会让人去重新登录一个其实好好的账号：
 *   error  上游明确说这份凭据失效（CodeArts status=error / Trae 冷却 / 已过期）
 *   warn   还能用但值得看一眼（快到期、启用中却积分为 0、连续失败过）
 *   ok     正常
 *   unknown 本地没有足够信息（例如 WorkBuddy 只有 access token 到期时间）
 */
function accountHealth(p, a) {
  const notes = [];
  const level = (l) => ({ level: l, notes });

  if (p.kind === 'qoder') {
    const days = expiryDays(a.expiresAt);
    if (days !== null && days < 0) {
      // PAT 型凭证过期不影响：代理会拿 PAT 重新换 job token（见 P20/P21 相关性说明）
      notes.push('access token 已过期，PAT 会自动换新');
      return level('warn');
    }
    if (days !== null && days < 3) {
      notes.push(`凭证剩 ${days} 天`);
      return level('warn');
    }
    return level(days === null ? 'unknown' : 'ok');
  }

  if (p.kind === 'workbuddy') {
    const days = expiryDays(a.expiresAt);
    if (days === null) return level('unknown');
    if (days < 0) {
      notes.push('凭证已过期');
      return level('error');
    }
    if (days < 3) {
      notes.push(`凭证剩 ${days} 天`);
      return level('warn');
    }
    return level('ok');
  }

  if (p.kind === 'trae') {
    if (a.cooling) {
      notes.push(`上游冷却中：${a.reason || '连续失败'}`);
      return level('error');
    }
    if (a.credits !== null && a.credits <= 0) {
      notes.push('积分为 0，选中会报额度不足');
      return level(a.enabled ? 'warn' : 'error');
    }
    const days = expiryDays(a.expiresAt);
    if (days !== null && days < 0) {
      notes.push('access token 已过期');
      return level('error');
    }
    if (days !== null && days < 3) {
      notes.push(`凭证剩 ${days} 天`);
      return level('warn');
    }
    return level('ok');
  }

  if (p.kind === 'codearts') {
    // 网关自己会续期，status 是它最近一次真实调用的结论，比到期时间可信
    if (a.status && a.status !== 'ok') {
      notes.push(a.lastErr ? summarizeErr(a.lastErr) : `状态 ${a.status}`);
      return level('error');
    }
    if (a.failures >= 3) {
      notes.push(`连续失败 ${a.failures} 次`);
      return level('warn');
    }
    const days = expiryDays(a.expiresAt);
    if (days !== null && days < 0) {
      notes.push('凭据已过期');
      return level('error');
    }
    if (days !== null && days < 1) {
      notes.push('凭据即将过期');
      return level('warn');
    }
    return level(a.failures > 0 ? 'warn' : 'ok');
  }

  if (p.kind === 'zcode') {
    if (a.needsReauth) {
      notes.push('需要重新登录授权');
      return level('error');
    }
    const days = expiryDays(a.expiresAt);
    if (days !== null && days < 0) {
      // 有 refresh token 就自动续期；没有就只能重登
      if (a.hasRefresh) {
        notes.push('JWT 已过期，会用 refresh 自动换新');
        return level('warn');
      }
      notes.push('JWT 已过期且没有 refresh');
      return level('error');
    }
    if (days !== null && days < 3) {
      notes.push(`JWT 剩 ${days} 天`);
      return level(a.hasRefresh ? 'ok' : 'warn');
    }
    return level(days === null ? 'unknown' : 'ok');
  }

  if (p.kind === 'loomy') {
    // session token 没有到期时间；本地只能确认文件里有一份非空 token。
    if (!readLoomySession()) {
      notes.push('未登录 Loomy 桌面端');
      return level('error');
    }
    return level('ok');
  }

  if (p.kind === 'raccoon') {
    const session = readRaccoonSession();
    if (!session) {
      notes.push('未登录小浣熊桌面端');
      return level('error');
    }
    const days = expiryDays(session.expiresAt);
    if (days === null) return level('unknown');
    if (days < 0) {
      notes.push('IAM token 已过期，打开桌面端会自动续期');
      return level('error');
    }
    if (days < 3) {
      notes.push(`IAM token 剩 ${days} 天`);
      return level('warn');
    }
    return level('ok');
  }

  if (p.kind === 'lingxi') {
    // SID 在加密 cookie 库里，只有反代能确认；本地只能判桌面端装没装。
    if (!lingxiInstalled()) {
      notes.push('未安装 WPS 灵犀桌面端');
      return level('error');
    }
    return level('unknown');
  }

  if (p.kind === 'lobster') {
    if (!lobsterInstalled()) {
      notes.push('未安装有道龙虾（LobsterAI）桌面端');
      return level('error');
    }
    const session = readLobsterSession();
    if (!session) {
      notes.push('未登录 LobsterAI 桌面端');
      return level('error');
    }
    const days = expiryDays(session.expiresAt);
    if (days === null) return level('unknown');
    if (days < 0) {
      notes.push('access token 已过期（打开桌面端会自动 refresh）');
      return level(session.refreshToken ? 'warn' : 'error');
    }
    if (days < 3) {
      notes.push(`access token 剩 ${days} 天`);
      return level('warn');
    }
    return level('ok');
  }

  if (p.kind === 'dumate') {
    // 登录态在桌面端 userData 里；main-server 是否在跑由端口探活单独判断。
    if (!a || !a.uid) {
      notes.push('未登录百度搭子桌面端');
      return level('error');
    }
    return level('ok');
  }

  if (p.kind === 'qwenwork') {
    const cred = qwenworkCredential();
    if (!cred) {
      const status = qwenworkStatus();
      notes.push(
        status && status.logged_in === true
          ? '桌面端已登录，但还没签发推理凭据（去桌面端发一句）'
          : '未登录千问办公桌面端',
      );
      return level(status && status.logged_in === true ? 'warn' : 'error');
    }
    const days = expiryDays(cred.expiresAtMs);
    if (days === null) return level('unknown');
    // 同为毫秒判断：剩余不足一天的 ceil 是 0，不能拿它区分「已过期」。
    if (cred.expiresAtMs && cred.expiresAtMs <= Date.now()) {
      notes.push('推理凭据已过期（exchange 需要有效凭据，无法自续）');
      return level('error');
    }
    if (days < 1) {
      notes.push('推理凭据即将到期（反代会自动续期）');
      return level('warn');
    }
    return level('ok');
  }

  return level('unknown');
}

/** 上游错误原文很长，取头一句够定位就行。 */
function summarizeErr(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const cut = s.split(/[。；;]/)[0];
  return (cut || s).slice(0, 50);
}

function expiryDays(expires) {
  const ms = normalizeExpiryMs(expires);
  if (ms === null) return null;
  return Math.ceil((ms - Date.now()) / 86400000);
}

/** 需要人工处理的账号：按「先修哪个」排序，error 在前。 */
function accountIssues(p, accounts) {
  return accounts
    .filter((a) => a.health && (a.health.level === 'error' || a.health.level === 'warn'))
    .sort((x, y) => (x.health.level === 'error' ? -1 : 1) - (y.health.level === 'error' ? -1 : 1));
}

/** 一行可直接复制的修复命令；不同供应商的修法不一样。 */
function accountFixHint(p, a) {
  if (p.kind === 'qoder') return `node router.mjs login ${p.id} --force`;
  if (p.kind === 'workbuddy') return `node router.mjs login ${p.id} --force`;
  if (p.kind === 'trae') {
    if (a.cooling) return `等冷却结束，或 node router.mjs account ${p.id} ${a.key}`;
    return `node router.mjs account add ${p.id}`;
  }
  if (p.kind === 'codearts') return `node router.mjs login ${p.id} --force`;
  if (p.kind === 'zcode') return `node router.mjs login ${p.id}`;
  if (p.kind === 'loomy') return `打开 Loomy 桌面端登录；或 node router.mjs login ${p.id}`;
  if (p.kind === 'raccoon') return `打开商汤小浣熊桌面端登录；或 node router.mjs login ${p.id}`;
  if (p.kind === 'qwenwork') return `打开千问办公桌面端登录并随便发一句（签发推理凭据）；或 node router.mjs login ${p.id}`;
  if (p.kind === 'dumate') return `打开百度搭子桌面端登录；或 node router.mjs login ${p.id}`;
  if (p.kind === 'lingxi') return `打开 WPS 灵犀桌面端登录（SID 写入 cookie 库后反代自动读到）`;
  if (p.kind === 'lobster') return `打开 LobsterAI 桌面端登录；或 node router.mjs login ${p.id}`;
  return `node router.mjs login ${p.id}`;
}

function healthMark(health) {
  if (!health) return ' ';
  if (health.level === 'error') return C.bad;
  if (health.level === 'warn') return C.warn;
  if (health.level === 'unknown') return `${C.dim}?${C.reset}`;
  return ' ';
}

function printAccounts(p, accounts) {
  const single = ['qoder', 'loomy', 'raccoon', 'qwenwork', 'dumate', 'lingxi', 'lobster'].includes(p.kind);
  say(
    `${C.bold}${p.title}${C.reset}  ${dim(`:${p.port} · ${accounts.length} 个账号${single ? '（单账号）' : ''}`)}`,
  );
  if (!accounts.length) {
    warn('没有可用账号');
    say(dim(`  登录：node router.mjs login ${p.id}`));
    return;
  }
  for (const [i, a] of accounts.entries()) {
    const mark = a.active
      ? '\x1b[1;32m*\x1b[0m'
      : a.enabled && (p.kind === 'codearts' || p.kind === 'trae')
        ? '\x1b[1;33m+\x1b[0m'
        : a.enabled
          ? ' '
          : `${C.dim}-${C.reset}`;
    const hp = healthMark(a.health);
    say(
      `  ${padEnd(mark, 2)} ${padEnd(hp, 2)} ${padEnd(String(i + 1), 3)} ${padEnd(a.key, 18)} ${padEnd(a.name, 20)} ${dim(a.detail || '')}`.trimEnd(),
    );
  }
  const issues = accountIssues(p, accounts);
  if (issues.length) {
    say('');
    for (const a of issues) {
      const label = a.health.level === 'error' ? `${C.bad} 需要重新登录` : `${C.warn} 注意`;
      say(`  ${label}  ${a.name}（${a.key}）：${a.health.notes.join('；')}`);
      say(`       ${dim(accountFixHint(p, a))}`);
    }
  }
  if (single) {
    say(dim(`  单账号，换号请重新登录：node router.mjs login ${p.id}`));
  } else {
    say(dim(`  切换：node router.mjs account ${p.id} <编号 | key>`));
    if (p.kind === 'codearts' || p.kind === 'trae') {
      say(dim(`  恢复全部启用：node router.mjs account ${p.id} --all`));
    }
  }
}

function accountJson(p, accounts) {
  return {
    id: p.id,
    title: p.title,
    kind: p.kind,
    switchable: ['workbuddy', 'codearts', 'trae', 'zcode'].includes(p.kind),
    accounts: accounts.map(publicAccount),
  };
}

function listAllAccounts({ json = false } = {}) {
  const groups = PROVIDERS.map((p) => ({ p, accounts: accountsFor(p) }));
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          providers: groups.map((g) => accountJson(g.p, g.accounts)),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  say(`${C.bold}账号${C.reset}  ${dim('* 当前生效　+ 参与轮询　- 已停用　空=可切换　✗需重登　!注意')}`);
  say('─'.repeat(92));
  for (const [i, g] of groups.entries()) {
    if (i > 0) say('');
    printAccounts(g.p, g.accounts);
  }
  say('─'.repeat(92));
  const totalIssues = groups.reduce((n, g) => n + accountIssues(g.p, g.accounts).length, 0);
  if (totalIssues) {
    warn(`${totalIssues} 个账号需要处理`);
    say(dim('  只看问题：node router.mjs account check'));
  } else {
    ok('所有账号正常');
  }
  say(
    dim(
      '  只看一家：node router.mjs account <id>　切换：account <id> <编号|key>　加：account add <id>　删：account remove <id> <编号|key>',
    ),
  );
  return 0;
}

/** 编号 / slot key / uid / 名称精确匹配；其次唯一前缀；名称重复时要求用 id。 */
function matchAccount(accounts, arg) {
  const s = String(arg || '').trim();
  if (!s) return { error: '缺少账号（可以用编号、key 或名称）' };
  const low = s.toLowerCase();
  const eq = (v) => v != null && String(v).toLowerCase() === low;
  let hits = accounts.filter((a) => eq(a.key) || eq(a.uid));
  if (!hits.length) hits = accounts.filter((a) => eq(a.name));
  if (!hits.length && /^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= accounts.length) hits = [accounts[n - 1]];
  }
  if (!hits.length) {
    const pref = accounts.filter((a) =>
      [a.key, a.uid, a.name].some((v) => v != null && String(v).toLowerCase().startsWith(low)),
    );
    if (pref.length === 1) hits = pref;
  }
  if (!hits.length) {
    return { error: `找不到账号：${s}（可用：${accounts.map((a) => a.key).join('、') || '无'}）` };
  }
  if (hits.length > 1) {
    return {
      error: `${s} 匹配到多个账号，请用编号或完整 key：${hits.map((a) => a.key).join('、')}`,
    };
  }
  return { account: hits[0] };
}

/** 运行中的反代才需要重启；没运行就等下次 up 时自然加载。 */
async function restartAfterAccountChange(p) {
  if (!(await probePort(p.port, 1200)).up) {
    say(dim('  反代未运行，下次启动时生效'));
    return true;
  }
  const failed = await doRestart([p], { quiet: true });
  if (failed) {
    bad(`  ${p.title} 重启失败，看日志：node router.mjs logs ${p.id} 80`);
    return false;
  }
  ok(`  ${p.title} 已重启（:${p.port}）`);
  return true;
}

async function switchWorkbuddyAccount(p, target, { dryRun = false } = {}) {
  if (target.active) {
    ok(`当前已经是账号 ${target.key}（${target.name}）`);
    return 0;
  }
  if (dryRun) {
    say(`\x1b[1;33m[dry-run]\x1b[0m 将把 ${p.title} 生效凭证切到 ${target.key}（${target.name}）`);
    return 0;
  }

  if (!target._file) {
    bad(`账号 ${target.key} 只有生效文件、没有 slot，无法作为切换目标`);
    return 1;
  }

  const liveFile = WORKBUDDY_LIVE_FILES[p.id];
  const live = readJsonFile(liveFile);
  // 先把生效文件里可能刚刷新过的 token 存回它自己的 slot，再覆盖，
  // 否则切换会丢掉当前账号这次运行期间续出来的新凭证。
  if (live && live.account && live.account.uid) {
    const owner = readWorkbuddySlots(p).find((s) => String(s.uid) === String(live.account.uid));
    if (owner) {
      writeJsonAtomic(owner.file, live, { mode: 0o600 });
      say(dim(`  已把当前账号 ${owner.key} 的最新凭证存回 slot`));
    } else {
      warn(`当前生效账号没有对应 slot（uid ${shortUid(live.account.uid)}），切换后不会留在账号池`);
    }
  }

  const slot = readJsonFile(target._file);
  if (!slot) {
    bad(`读取 slot 失败：${target._file}`);
    return 1;
  }
  writeJsonAtomic(liveFile, slot, { mode: 0o600 });
  // 告诉共享库这是用户主动切号，避免紧接着的自动同步按 mtime 把它当成旧状态。
  await markActiveWorkbuddy(p.id, target.uid);
  ok(`已切换 ${p.title} 到账号 ${target.key}（${target.name}）`);
  const restarted = await restartAfterAccountChange(p);
  if (!restarted) return 1;
  say('');
  printAccounts(p, accountsFor(p));
  return 0;
}

function codeartsAdminHeaders() {
  const data = readJsonFile(CODEARTS_DATA_FILE) || {};
  const password = (data.settings && data.settings.admin_password) || '';
  const headers = { 'Content-Type': 'application/json' };
  if (password) headers['X-Admin-Password'] = password;
  return headers;
}

async function switchCodeartsPool(p, target, { dryRun = false, all = false } = {}) {
  const up = (await probePort(p.port, 1200)).up;
  const headers = codeartsAdminHeaders();
  let rows;
  if (up) {
    try {
      const state = await fetchJson(`http://127.0.0.1:${p.port}/admin/api/state`, { headers, timeout: 8000 });
      rows = (state && Array.isArray(state.accounts) && state.accounts) || null;
    } catch (e) {
      // 网关在跑时直接改文件会被它的持久化覆盖，所以宁可报错也不猜
      bad(`读取 CodeArts 账号池失败：${e.message}`);
      return 1;
    }
    if (!rows) {
      bad('CodeArts /admin/api/state 没有返回 accounts');
      return 1;
    }
  } else {
    rows = accountsFor(p).map((a) => ({ id: a.key, name: a.name, enabled: a.enabled }));
  }

  if (!all && !rows.some((a) => a.id === target.key)) {
    bad(`账号 ${target.key} 不在 CodeArts 当前调度池里`);
    return 1;
  }
  const desired = all ? rows.map((a) => a.id) : [target.key];
  const changes = rows.filter((a) => (a.enabled !== false) !== desired.includes(a.id));
  if (!changes.length) {
    ok(`CodeArts 账号池已经是目标状态${all ? '（全部启用）' : `（只启用 ${target.name}）`}`);
    return 0;
  }

  if (dryRun) {
    say(
      `\x1b[1;33m[dry-run]\x1b[0m CodeArts 账号池将变为${all ? '全部启用' : `只启用 ${target.name}（${target.key}）`}：`,
    );
    for (const a of changes) {
      say(
        `  ${a.enabled !== false ? '停用' : '启用'}  ${a.name || a.id}  ${dim(a.id)}`,
      );
    }
    return 0;
  }

  if (up) {
    for (const a of changes) {
      await fetchJson(`http://127.0.0.1:${p.port}/admin/api/accounts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'toggle', id: a.id }),
        timeout: 8000,
      });
    }
  } else {
    const data = readJsonFile(CODEARTS_DATA_FILE);
    if (!data || !Array.isArray(data.accounts)) {
      bad(`读取账号池失败：${CODEARTS_DATA_FILE}`);
      return 1;
    }
    for (const a of data.accounts) a.enabled = desired.includes(a.id);
    writeJsonAtomic(CODEARTS_DATA_FILE, data);
  }

  ok(`CodeArts 账号池已更新${all ? '（全部启用）' : `（只启用 ${target.name}）`}`);
  await sleep(150);
  say('');
  printAccounts(p, accountsFor(p));
  return 0;
}

async function switchTraeAccount(p, target, { dryRun = false, all = false } = {}) {
  const accounts = accountsFor(p);
  const desired = all ? accounts.map((a) => a.uid) : [target.uid];
  const changes = accounts.filter((a) => a.enabled !== desired.includes(a.uid));
  if (!changes.length) {
    ok(`Trae 账号池已经是目标状态${all ? '（全部启用）' : `（只启用 ${target.name}）`}`);
    return 0;
  }

  if (dryRun) {
    say(
      `\x1b[1;33m[dry-run]\x1b[0m Trae 账号池将变为${all ? '全部启用' : `只启用 ${target.name}（${target.uid}）`}：`,
    );
    for (const a of changes) say(`  ${a.enabled ? '停用' : '启用'}  ${a.name}  ${dim(a.uid)}`);
    return 0;
  }

  const state = readJsonFile(TRAE_STATE_FILE) || {};
  const byUid = state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  for (const a of accounts) {
    if (!byUid[a.uid]) byUid[a.uid] = { credits: 0, disabled: false, until: '0001-01-01T00:00:00Z' };
    byUid[a.uid].disabled = !desired.includes(a.uid);
  }
  state.accounts = byUid;
  writeJsonAtomic(TRAE_STATE_FILE, state);

  ok(`Trae 账号池已更新${all ? '（全部启用）' : `（只启用 ${target.name}）`}`);
  const restarted = await restartAfterAccountChange(p);
  if (!restarted) return 1;
  say('');
  printAccounts(p, accountsFor(p));
  return 0;
}

async function switchAccount(p, accounts, arg, { dryRun = false } = {}) {
  const matched = matchAccount(accounts, arg);
  if (matched.error) {
    bad(matched.error);
    return 1;
  }
  const target = matched.account;

  if (p.kind === 'qoder') {
    warn(`${p.title} 每个区域只有一条凭证，没有多账号可切换`);
    say(dim(`  换号：node router.mjs login ${p.id} [--force]`));
    return 1;
  }
  if (p.kind === 'loomy') {
    warn(`${p.title} 只有一个登录态，没有多账号可切换`);
    say(dim('  换号：在 Loomy 桌面端退出后重新登录，反代会自动读到新 session'));
    return 1;
  }
  if (p.kind === 'raccoon') {
    warn(`${p.title} 只有一个登录态，没有多账号可切换`);
    say(dim('  换号：在商汤小浣熊桌面端退出后重新登录，反代会自动读到新 token'));
    return 1;
  }
  if (p.kind === 'qwenwork') {
    warn(`${p.title} 只有一个登录态，没有多账号可切换`);
    say(dim('  换号：在千问办公桌面端退出后重新登录，反代会自动读到新凭据'));
    return 1;
  }
  if (p.kind === 'dumate') {
    warn(`${p.title} 只有一个登录态，没有多账号可切换`);
    say(dim('  换号：在百度搭子桌面端退出后重新登录，反代会自动读到新登录态'));
    return 1;
  }
  if (p.kind === 'lingxi') {
    warn(`${p.title} 只有一个登录态，没有多账号可切换`);
    say(dim('  换号：在 WPS 灵犀桌面端退出后重新登录，反代会自动从 cookie 库读到新 SID'));
    return 1;
  }
  if (p.kind === 'lobster') {
    warn(`${p.title} 只有一个登录态，没有多账号可切换`);
    say(dim('  换号：在 LobsterAI 桌面端退出后重新登录，反代会自动读到新的 auth_tokens'));
    return 1;
  }

  if (p.kind === 'workbuddy') return switchWorkbuddyAccount(p, target, { dryRun });
  if (p.kind === 'codearts') return switchCodeartsPool(p, target, { dryRun });
  if (p.kind === 'trae') return switchTraeAccount(p, target, { dryRun });
  if (p.kind === 'zcode') return switchZcodeAccount(p, target, { dryRun });
  return 1;
}

async function switchAllAccounts(p, { dryRun = false } = {}) {
  if (p.kind === 'workbuddy') {
    warn('WorkBuddy 的生效文件同一时刻只能指向一个 slot，--all 不适用');
    say(dim(`  选择账号：node router.mjs account ${p.id} <编号 | key>`));
    return 1;
  }
  if (p.kind === 'zcode') {
    ok('ZCode 的账号池本来就全部参与轮询，无需恢复');
    say(dim(`  想调整轮询头：node router.mjs account ${p.id} <编号 | key>`));
    return 0;
  }
  if (['qoder', 'loomy', 'raccoon', 'qwenwork', 'dumate', 'lingxi', 'lobster'].includes(p.kind)) {
    warn(`${p.title} 没有多账号池，--all 不适用`);
    return 1;
  }
  const accounts = accountsFor(p);
  if (!accounts.length) {
    warn(`${p.title} 没有可用账号`);
    return 1;
  }
  if (p.kind === 'codearts') return switchCodeartsPool(p, null, { dryRun, all: true });
  if (p.kind === 'trae') return switchTraeAccount(p, null, { dryRun, all: true });
  return 1;
}

// ---------------------------------------------------------------- 账号删除
//
// 四家的「删除」原语完全不同，而且都不可逆，所以统一成两步：
//   1. 先归档（WorkBuddy 复制文件到 retired-<时间>/，Trae 先取出再交给上游删）
//   2. 再从调度池移除
// 归档目录里留一份原始凭证，账号现在还在的话，`account restore` 能捡回来。

function retiredDir(p) {
  return path.join(p.kind === 'workbuddy' ? WORKBUDDY_SLOT_DIRS[p.id] : path.dirname(CODEARTS_DATA_FILE), `retired-${stampNow()}`);
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 把要删的东西挪进归档目录，返回归档路径；失败返回 null。 */
function archiveFile(file, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(file));
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

async function removeWorkbuddyAccount(p, target, { dryRun = false } = {}) {
  if (target.active) {
    return { error: `不能删除当前生效的账号（${target.name}），先切到别的账号再删` };
  }
  if (!target._file) {
    return { error: '这个账号没有对应的 slot 文件，无法删除（它只是生效文件里的残留）' };
  }
  if (dryRun) {
    say(`\x1b[1;33m[dry-run]\x1b[0m 将删除 ${p.title} 的账号 ${target.key}（${target.name}），凭证归档到 retired-*`);
    return { ok: true };
  }
  const dir = retiredDir(p);
  const archived = archiveFile(target._file, dir);
  if (!archived) return { error: `归档失败，未删除：${target._file}` };
  try {
    fs.unlinkSync(target._file);
  } catch (e) {
    return { error: `删除 slot 失败：${e.message}` };
  }
  // 注销墓碑：sync-homes 是按 uid 求并集的，不登记的话下一轮同步会把账号捞回来
  await markWorkbuddyDeleted(p.id, target.uid);
  return { ok: true, archived };
}

/** 把「用户主动删了这个账号」写进共享库墓碑，避免双系统同步把它复活。 */
async function markWorkbuddyDeleted(region, uid) {
  try {
    const { markAccountDeleted } = await import(new URL('./scripts/sync-homes.mjs', import.meta.url).href);
    markAccountDeleted(region, uid);
  } catch {}
}

async function removeTraeAccount(p, target, { dryRun = false } = {}) {
  const up = (await probePort(p.port, 1200)).up;
  if (dryRun) {
    say(`\x1b[1;33m[dry-run]\x1b[0m 将删除 Trae 的账号 ${target.key}（${target.name}）`,);
    return { ok: true };
  }

  // 先归档：trae 的凭证就在 auths/trae-<uid>.json
  const dir = path.join(TRAE_DIR, 'auths', `retired-${stampNow()}`);
  const archived = target.file ? archiveFile(target.file, dir) : null;

  if (up) {
    // 网关在跑时走它的管理接口，否则 state.json 会被它自己覆盖回去
    const key = keyFor('trae-local');
    const res = await fetchJson(`http://127.0.0.1:${p.port}/admin/api/accounts/${encodeURIComponent(target.uid)}`, {
      method: 'DELETE',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      timeout: 8000,
    }).catch((e) => ({ error: e }));
    if (res && res.error) return { error: `上游删除失败：${res.error.message}` };
  } else {
    const state = readJsonFile(TRAE_STATE_FILE) || {};
    if (state.accounts && state.accounts[target.uid]) delete state.accounts[target.uid];
    writeJsonAtomic(TRAE_STATE_FILE, state);
    if (target.file) {
      try {
        fs.unlinkSync(target.file);
      } catch {}
    }
  }
  return { ok: true, archived };
}

async function removeCodeartsAccount(p, target, { dryRun = false } = {}) {
  const up = (await probePort(p.port, 1200)).up;
  if (dryRun) {
    say(`\x1b[1;33m[dry-run]\x1b[0m 将删除 CodeArts 的账号 ${target.key}（${target.name}）`);
    return { ok: true };
  }
  const headers = codeartsAdminHeaders();
  if (up) {
    const res = await fetchJson(`http://127.0.0.1:${p.port}/admin/api/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'remove', id: target.key }),
      timeout: 8000,
    }).catch((e) => ({ error: e }));
    if (res && res.error) return { error: `删除失败：${res.error.message}` };
  } else {
    const data = readJsonFile(CODEARTS_DATA_FILE);
    if (!data || !Array.isArray(data.accounts)) return { error: `读取账号池失败：${CODEARTS_DATA_FILE}` };
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== target.key);
    if (data.accounts.length === before) return { error: `账号 ${target.key} 不在池里` };
    writeJsonAtomic(CODEARTS_DATA_FILE, data);
  }
  return { ok: true };
}

/** 从账号池里删掉一个账号；Qoder 没有池，只能重新登录换号。 */
async function removeAccountFromPool(p, accounts, arg, { dryRun = false, force = false } = {}) {
  if (p.kind === 'qoder') {
    return {
      error: `${p.title} 每个区域只有一条凭证，没有账号池可删`,
      hint: `换号：node router.mjs login ${p.id} --force`,
    };
  }
  if (p.kind === 'loomy') {
    return {
      error: `${p.title} 的登录态由 Loomy 桌面端维护，没有可删的账号池`,
      hint: '换号请在桌面端退出后重新登录',
    };
  }
  if (p.kind === 'raccoon') {
    return {
      error: `${p.title} 的登录态由商汤小浣熊桌面端维护，没有可删的账号池`,
      hint: '换号请在桌面端退出后重新登录',
    };
  }
  if (p.kind === 'qwenwork') {
    return {
      error: `${p.title} 的登录态由千问办公桌面端维护，没有可删的账号池`,
      hint: '换号请在千问办公桌面端退出后重新登录',
    };
  }
  if (p.kind === 'dumate') {
    return {
      error: `${p.title} 的登录态由百度搭子桌面端维护，没有可删的账号池`,
      hint: '换号请在百度搭子桌面端退出后重新登录',
    };
  }
  if (p.kind === 'lingxi') {
    return {
      error: `${p.title} 的登录态由 WPS 灵犀桌面端维护，没有可删的账号池`,
      hint: '换号请在 WPS 灵犀桌面端退出后重新登录',
    };
  }
  if (p.kind === 'lobster') {
    return {
      error: `${p.title} 的登录态由 LobsterAI 桌面端维护，没有可删的账号池`,
      hint: '换号请在 LobsterAI 桌面端退出后重新登录',
    };
  }
  const matched = matchAccount(accounts, arg);
  if (matched.error) return { error: matched.error };
  const target = matched.account;

  const health = target.health || {};
  if (health.level === 'error' && !force) {
    // 最常想删的就是这种「坏账号」，但它们往往只是需要重新登录，删掉反而丢凭证
    return {
      error: `账号 ${target.key} 有故障，通常重新登录就能修好，不是非删不可`,
      hint: `重新登录：${accountFixHint(p, target)}    确实要删加 --force`,
    };
  }

  say(`${C.bold}删除账号${C.reset} ${p.title} · ${target.name}（${target.key}）`);
  if (dryRun) say(dim('  --dry-run：只预览，不动文件'));

  let result;
  if (p.kind === 'workbuddy') result = await removeWorkbuddyAccount(p, target, { dryRun });
  else if (p.kind === 'trae') result = await removeTraeAccount(p, target, { dryRun });
  else if (p.kind === 'codearts') result = await removeCodeartsAccount(p, target, { dryRun });
  else if (p.kind === 'zcode') result = await removeZcodeAccount(p, target, { dryRun });
  else result = { error: `不知道怎么删除 ${p.title} 的账号` };

  if (result.error) return result;
  if (dryRun) return { ok: true };

  // WorkBuddy 删 slot 不需要重启（反代只读生效文件）；其余换了调度池要重载
  if (p.kind === 'trae' || p.kind === 'codearts') {
    const restarted = await restartAfterAccountChange(p);
    if (!restarted) return { ok: true, warn: '账号已删除，但反代重启失败' };
  }

  ok(`已删除账号 ${target.key}（${target.name}）`);
  if (result.archived) say(dim(`  凭证已归档：${result.archived}`));
  say('');
  printAccounts(p, accountsFor(p));
  return { ok: true };
}

/** 从归档目录把账号捡回池子（WorkBuddy / Trae 是文件，CodeArts 需要重新登录）。 */
async function restoreAccounts(p, { dryRun = false, list = false } = {}) {
  if (p.kind === 'codearts' || p.kind === 'qoder' || p.kind === 'zcode' || p.kind === 'loomy' || p.kind === 'raccoon') {
    return { error: `${p.title} 的凭证删掉后只能重新登录，无法从归档恢复` };
  }
  const dir = p.kind === 'workbuddy' ? WORKBUDDY_SLOT_DIRS[p.id] : path.join(TRAE_DIR, 'auths');
  let archives = [];
  try {
    archives = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^retired-/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {}
  const files = [];
  for (const a of archives) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, a)).filter((f) => /\.json$/.test(f));
    } catch {}
    for (const f of names) files.push({ archive: a, file: path.join(dir, a, f), name: f });
  }
  if (!files.length) return { error: `没有归档可恢复（${dir} 下没有 retired-* 目录）` };
  if (list) return { ok: true, files };
  if (dryRun) {
    for (const f of files) say(`\x1b[1;33m[dry-run]\x1b[0m 将恢复 ${f.name}（来自 ${f.archive}）`);
    return { ok: true, files };
  }
  let restored = 0;
  for (const f of files) {
    const dest = path.join(dir, f.name);
    if (fs.existsSync(dest)) continue; // 池里已有同名，不覆盖
    try {
      fs.copyFileSync(f.file, dest);
      restored += 1;
      const data = readJsonFile(dest);
      const uid = data && data.account && data.account.uid;
      if (uid) await clearDeleted(String(uid));
    } catch {}
  }
  return { ok: true, restored, files };
}

/** 恢复账号时解除墓碑，否则下一轮同步又会把它删掉。 */
async function clearDeleted(uid) {
  try {
    const { clearAccountDeleted } = await import(new URL('./scripts/sync-homes.mjs', import.meta.url).href);
    for (const region of ['workbuddy', 'workbuddy-global']) clearAccountDeleted(region, uid);
  } catch {}
}

/** 在浏览器里登录一个新账号并写进账号池；已有账号不会被覆盖。 */
async function addAccountToPool(p, { dryRun = false, label = '' } = {}) {
  if (p.kind === 'loomy') {
    warn(`${p.title} 只有一个登录态，请在 Loomy 桌面端退出后登录另一个账号`);
    say(dim('  反代会直接读到新的 auth-session.json，不需要重新配置 provider'));
    return 1;
  }
  if (p.kind === 'raccoon') {
    warn(`${p.title} 只有一个登录态，请在商汤小浣熊桌面端退出后登录另一个账号`);
    say(dim('  反代会直接读到新的 auth.json，不需要重新配置 provider'));
    return 1;
  }
  if (p.kind === 'qwenwork') {
    warn(`${p.title} 只有一个登录态，请在千问办公桌面端退出后登录另一个账号`);
    say(dim('  反代会直接读到新的 MaaS 凭据，不需要重新配置 provider'));
    return 1;
  }
  if (p.kind === 'dumate') {
    warn(`${p.title} 只有一个登录态，请在百度搭子桌面端退出后登录另一个账号`);
    say(dim('  反代会直接读到新的 auth.json，不需要重新配置 provider'));
    return 1;
  }
  if (p.kind === 'lingxi') {
    warn(`${p.title} 只有一个登录态，请在 WPS 灵犀桌面端退出后登录另一个账号`);
    say(dim('  反代会直接读到新的 cookie 库，不需要重新配置 provider'));
    return 1;
  }
  if (p.kind === 'lobster') {
    warn(`${p.title} 只有一个登录态，请在 LobsterAI 桌面端退出后登录另一个账号`);
    say(dim('  反代会直接读到新的 auth_tokens，不需要重新配置 provider'));
    return 1;
  }
  const before = accountsFor(p);
  if (dryRun) {
    say(`${C.bold}${p.title}${C.reset} 将通过浏览器登录添加账号`);
    say(dim('  已有账号不会被覆盖；浏览器里请登录另一个账号'));
    say(dim(`  当前账号池：${before.map((a) => a.key).join('、') || '空'}`));
    return 0;
  }

  const wasUp = (await probePort(p.port, 1000)).up;
  say(`${C.bold}添加账号${C.reset} ${p.title}`);
  say(dim('  浏览器打开后请登录另一个账号；同一个账号会更新原 slot，不会重复添加。'));

  let success = false;
  if (p.kind === 'workbuddy') success = await loginWorkbuddy(p);
  else if (p.kind === 'codearts') success = await loginCodearts(p);
  else if (p.kind === 'trae') success = await loginTrae(p);
  else if (p.kind === 'zcode') success = await loginZcode(p, { label });
  if (!success) return 1;

  if (p.kind === 'codearts') await sleep(200);
  const after = accountsFor(p);
  const added = after.filter((a) => !before.some((b) => b.key === a.key));

  // 登录流程可能为了拿凭证临时拉起网关；恢复到命令执行前的运行状态。
  if (!wasUp && (await probePort(p.port, 1000)).up) {
    await doDown([p], { quiet: true });
    say(dim('  登录前反代未运行，已恢复为停止状态'));
  }

  if (p.kind === 'trae' && wasUp) {
    await restartAfterAccountChange(p);
  } else if (p.kind === 'workbuddy') {
    // 只有当前生效账号也被登录流程换掉时才需要重启；单纯往池里加 slot 不影响运行中的反代。
    const beforeActive = (before.find((a) => a.active) || {}).key;
    const afterActive = (after.find((a) => a.active) || {}).key;
    if (wasUp && beforeActive !== afterActive) await restartAfterAccountChange(p);
  }

  if (added.length) {
    ok(`已添加 ${added.length} 个账号：${added.map((a) => `${a.key}（${a.name}）`).join('、')}`);
    say(dim(`  切换到新账号：node router.mjs account ${p.id} ${added[0].key}`));
  } else {
    warn('登录完成，但账号池里没有新账号（通常说明登录的是已有账号，slot 已被更新）');
  }

  // CodeArts / Trae 的「池」就是 enabled 集合。原本刻意收敛成单账号时，
  // 新账号默认会参与轮询；提醒一句，避免用户以为还是原来那个账号在跑。
  if (
    (p.kind === 'codearts' || p.kind === 'trae') &&
    before.filter((a) => a.enabled).length === 1 &&
    after.filter((a) => a.enabled).length > 1
  ) {
    const keep = before.find((a) => a.enabled);
    warn(`账号池已从单账号恢复为多账号轮询${keep ? `；只想保留 ${keep.name} 请执行 account ${p.id} ${keep.key}` : ''}`);
  }
  say('');
  printAccounts(p, after);
  return 0;
}

async function cmdAccount(raw, { json = false } = {}) {
  const all = raw.includes('--all');
  const dryRun = raw.includes('--dry-run');
  const force = raw.includes('--force');
  // --label <名字>：ZCode 的登录给账号起个别名，避免只认 JWT 里的 id
  const labelIdx = raw.indexOf('--label');
  const label = labelIdx >= 0 && labelIdx + 1 < raw.length ? raw[labelIdx + 1] : '';
  const pos = raw.filter((a, i) => !a.startsWith('--') && !(labelIdx >= 0 && i === labelIdx + 1));
  // 支持三种写法：account add <id> / account remove <id> [账号] / account <id> --add
  const sub = pos[0] ? pos[0].toLowerCase() : '';
  const addCmd = sub === 'add';
  const removeCmd = sub === 'remove' || sub === 'rm' || sub === 'del';
  const restoreCmd = sub === 'restore';
  const checkCmd = sub === 'check' || sub === 'doctor';
  const mergeCmd = sub === 'merge' || sub === 'dedupe';
  const wantsAdd = raw.includes('--add') || addCmd;
  const wantsRemove = raw.includes('--remove') || raw.includes('--rm') || removeCmd;
  const rest = addCmd || removeCmd || restoreCmd || checkCmd || mergeCmd ? pos.slice(1) : pos;

  const fail = (message, hint) => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else {
      bad(message);
      if (hint) say(dim(`  ${hint}`));
    }
    return 1;
  };

  if (wantsAdd) {
    if (all) return fail('--add 不能和 --all 一起使用');
    if (!rest.length) {
      return fail(
        '添加账号需要指定供应商',
        `用法：node router.mjs account add <id>    例如：node router.mjs account add workbuddy`,
      );
    }
    if (rest.length > 1) return fail(`参数太多：${rest.slice(1).join(' ')}`);
    if (json) return fail('添加账号是交互式流程，不支持 --json');
    const resolvedAdd = resolveId(rest[0]);
    if (resolvedAdd.error) {
      return fail(resolvedAdd.error, `可选：${PROVIDERS.map((p) => p.id).join('、')}`);
    }
    const pAdd = resolvedAdd.p;
    if (pAdd.kind === 'qoder') {
      return fail(
        `${pAdd.title} 每个区域只有一条凭证，没有账号池可添加`,
        `换号：node router.mjs login ${pAdd.id} --force`,
      );
    }
    return addAccountToPool(pAdd, { dryRun, label });
  }

  if (wantsRemove) {
    if (all) return fail('删除账号不能同时用 --all');
    if (!rest.length) {
      return fail(
        '删除账号需要指定供应商和账号',
        `用法：node router.mjs account remove <id> <编号 | key> [--force] [--dry-run]`,
      );
    }
    const resolvedRm = resolveId(rest[0]);
    if (resolvedRm.error) return fail(resolvedRm.error, `可选：${PROVIDERS.map((q) => q.id).join('、')}`);
    const pRm = resolvedRm.p;
    const pool = accountsFor(pRm);
    if (!pool.length) return fail(`${pRm.title} 没有可用账号`, `登录：node router.mjs login ${pRm.id}`);
    if (rest.length < 2) {
      // 不给账号时列出来，避免误删
      printAccounts(pRm, pool);
      return fail('请指定要删除的账号（编号或 key）', `例如：node router.mjs account remove ${pRm.id} 2`);
    }
    if (rest.length > 2) return fail(`参数太多：${rest.slice(2).join(' ')}`);
    const result = await removeAccountFromPool(pRm, pool, rest[1], { dryRun, force });
    if (result.error) return fail(result.error, result.hint);
    if (result.warn) warn(result.warn);
    return 0;
  }

  if (restoreCmd) {
    if (!rest.length) {
      return fail('恢复账号需要指定供应商', `用法：node router.mjs account restore <id> [--dry-run]`);
    }
    const resolvedRs = resolveId(rest[0]);
    if (resolvedRs.error) return fail(resolvedRs.error, `可选：${PROVIDERS.map((q) => q.id).join('、')}`);
    const pRs = resolvedRs.p;
    const result = await restoreAccounts(pRs, { dryRun, list: true });
    if (result.error) return fail(result.error);
    const dir = pRs.kind === 'workbuddy' ? WORKBUDDY_SLOT_DIRS[pRs.id] : path.join(TRAE_DIR, 'auths');
    say(`${C.bold}可恢复的归档${C.reset} ${pRs.title}  ${dim(dir)}`);
    for (const f of result.files) {
      const exists = fs.existsSync(path.join(dir, f.name));
      say(`  ${exists ? dim('(池里已有)') : C.ok} ${padEnd(f.archive, 24)} ${f.name}`);
    }
    if (dryRun) {
      const r = await restoreAccounts(pRs, { dryRun: true });
      return r.error ? fail(r.error) : 0;
    }
    const r = await restoreAccounts(pRs);
    if (r.error) return fail(r.error);
    ok(`已恢复 ${r.restored} 个账号档案${r.restored ? '（重名的不覆盖）' : ''}`);
    if (pRs.kind === 'trae') await restartAfterAccountChange(pRs);
    say('');
    printAccounts(pRs, accountsFor(pRs));
    return 0;
  }

  if (mergeCmd) {
    // 「合并」在没有 domain_id 的账号上无法可靠判定归属，所以这里不做自动合并，
    // 只把可能的重复列出来，由用户指定删哪条（等价于 delete 的批量预览）。
    if (!rest.length) {
      return fail('需要指定供应商', `用法：node router.mjs account merge codearts [--dry-run]`);
    }
    const resolvedMg = resolveId(rest[0]);
    if (resolvedMg.error) return fail(resolvedMg.error, `可选：${PROVIDERS.map((q) => q.id).join('、')}`);
    const pMg = resolvedMg.p;
    if (pMg.kind !== 'codearts') {
      return fail('只有 CodeArts 会出现这种重复记录（每次浏览器登录新增一条）');
    }
    const upMg = (await probePort(pMg.port, 1200)).up;
    if (!upMg) {
      return fail('需要网关在线才能比对账号归属', `先启动：node router.mjs up ${pMg.id}`);
    }
    const groups = await codeartsSameAccountGroups(pMg.port);
    if (!groups.length) {
      ok('没有发现同一账号的重复记录');
      return 0;
    }
    say(`${C.bold}同一账号的重复记录${C.reset} ${pMg.title}  ${dim(`${groups.length} 组`)}`);
    for (const g of groups) {
      const c = g.credit || {};
      say(`  ${dim(`用量指纹 token_used=${c.token_used} total=${c.total} used=${c.used}`)}`);
      for (const a of g.accounts) {
        const tag = a.status === 'ok' ? C.ok : C.bad;
        say(`    ${tag} ${padEnd(a.name, 22)} ${dim(`${a.id} · ${a.source || '?'} · ${a.status || '?'}`)}`);
      }
    }
    if (dryRun) return 0;

    // 每组只保留一条。默认保留桌面端那条（能跟随 IDE 续期）；`--keep browser`
    // 或 `--keep <id>` 可以指定保留浏览器登录的记录。
    const prefer = String(process.env.ROUTER_CODEARTS_KEEP || '').trim();
    const drop = [];
    for (const g of groups) {
      const list = g.accounts;
      let keep;
      if (prefer && list.some((a) => a.id === prefer || a.name === prefer)) {
        keep = list.find((a) => a.id === prefer || a.name === prefer);
      } else if (prefer === 'browser') {
        keep = list.find((a) => a.source === 'browser' && a.status === 'ok') || list[0];
      } else {
        keep = list.find((a) => a.user_data) || list.find((a) => a.status === 'ok') || list[0];
      }
      say(`  ${C.ok} 保留  ${padEnd(keep.name, 22)} ${dim(`${keep.id} · ${keep.source || '?'}`)}`);
      drop.push(...list.filter((a) => a.id !== keep.id));
    }
    if (!drop.length) {
      ok('没有需要移除的记录');
      return 0;
    }
    say('');
    for (const a of drop) say(`  ${C.dim}-${C.reset} 移除  ${padEnd(a.name, 22)} ${dim(a.id)}`);
    for (const a of drop) {
      await fetchJson(`http://127.0.0.1:${pMg.port}/admin/api/accounts`, {
        method: 'POST',
        headers: codeartsAdminHeaders(),
        body: JSON.stringify({ action: 'remove', id: a.id }),
        timeout: 8000,
      }).catch(() => {});
    }
    ok(`已移除 ${drop.length} 条重复记录`);
    say('');
    printAccounts(pMg, accountsFor(pMg));
    return 0;
  }

  if (checkCmd) {
    // 体检模式：只报有问题的账号，正常时不啰嗦
    const list = rest.length
      ? rest.map((x) => resolveId(x)).filter((r) => !r.error).map((r) => r.p)
      : PROVIDERS;
    if (!list.length) return fail('没有可检查的供应商', `可选：${PROVIDERS.map((q) => q.id).join('、')}`);

    const payload = [];
    let issues = 0;
    for (const pc of list) {
      const pool = accountsFor(pc);
      const bad = accountIssues(pc, pool);
      issues += bad.length;
      payload.push({ ...accountJson(pc, pool), issues: bad.map(publicAccount) });
      if (!json) {
        if (!pool.length) {
          say(`${C.warn} ${padEnd(pc.title, 20)} 没有账号`);
          issues += 1;
        } else if (!bad.length) {
          const total = pool.length;
          say(`${C.ok} ${padEnd(pc.title, 20)} ${dim(`${total} 个账号都正常`)}`);
        } else {
          say(`${C.warn} ${padEnd(pc.title, 20)} ${bad.length} 个账号需要处理`);
          for (const a of bad) {
            const tag = a.health.level === 'error' ? C.bad : C.warn;
            say(`  ${tag} ${padEnd(a.name, 20)} ${dim(a.key)}  ${a.health.notes.join('；')}`);
            say(`     ${dim(accountFixHint(pc, a))}`);
          }
        }
        // CodeArts 每次浏览器登录都会新增一条，可能和已有账号是同一个人。
        // 用套餐用量指纹去比对（不按名字猜），发现重复才提示。
        if (pc.kind === 'codearts' && (await probePort(pc.port, 800)).up) {
          const dupGroups = await codeartsSameAccountGroups(pc.port);
          if (dupGroups.length) {
            const extra = dupGroups.reduce((n, g) => n + g.accounts.length - 1, 0);
            say(`  ${C.warn} ${extra} 条重复记录（与已有账号是同一人，网关不认）`);
            for (const g of dupGroups) {
              const names = g.accounts.map((a) => a.name).join(' / ');
              say(`     ${dim(names)}`);
            }
            say(`     ${dim(`确认后合并：node router.mjs account merge ${pc.id}`)}`);
            issues += 1;
          }
        }
      }
    }
    if (json) {
      console.log(
        JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), providers: payload }, null, 2),
      );
      return issues ? 1 : 0;
    }
    say('─'.repeat(92));
    if (issues === 0) say(`${C.ok} 所有账号都正常`);
    else say(`${C.warn} ${issues} 个账号需要处理`);
    return issues ? 1 : 0;
  }

  if (!rest.length) {
    if (all) return fail('--all 需要指定供应商，例如：node router.mjs account codearts --all');
    return listAllAccounts({ json });
  }

  const resolved = resolveId(rest[0]);
  if (resolved.error) {
    return fail(resolved.error, `可选：${PROVIDERS.map((p) => p.id).join('、')}`);
  }
  const p = resolved.p;
  const accounts = accountsFor(p);

  if (rest.length === 1 && !all) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            provider: accountJson(p, accounts),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    printAccounts(p, accounts);
    return 0;
  }
  if (all && rest.length > 1) return fail('--all 不能同时指定账号');
  if (rest.length > 2) {
    return fail(
      `参数太多：${rest.slice(2).join(' ')}`,
      `用法：node router.mjs account ${p.id} [编号 | key | 名称] [--all] [--dry-run]`,
    );
  }
  if (!accounts.length) {
    return fail(`${p.title} 没有可用账号`, `登录：node router.mjs login ${p.id}`);
  }

  OUTPUT_BUF.length = 0;
  if (json) MUTE_OUTPUT = true;
  let code;
  try {
    code = all ? await switchAllAccounts(p, { dryRun }) : await switchAccount(p, accounts, rest[1], { dryRun });
  } finally {
    MUTE_OUTPUT = false;
  }

  if (json) {
    const messages = OUTPUT_BUF.map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''));
    console.log(
      JSON.stringify(
        {
          ok: code === 0,
          provider: p.id,
          action: all ? (dryRun ? 'dry-run-all' : 'all') : dryRun ? 'dry-run' : 'switch',
          target: all ? null : rest[1],
          accounts: accountsFor(p).map(publicAccount),
          ...(code === 0 ? {} : { messages: messages.slice(-6) }),
        },
        null,
        2,
      ),
    );
  }
  return code;
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

/** 第三方反代直连时的透明限流层；真实进程挪到内部端口，对外端口不变。 */
function limitProxySpec(provider, port, upstreamPort, log) {
  return {
    name: 'limit-proxy',
    port,
    command: () => process.execPath,
    args: () => [
      path.join(HERE, 'integrations', 'limits', 'limit-proxy.js'),
      '--provider',
      provider,
      '--listen',
      String(port),
      '--upstream',
      String(upstreamPort),
    ],
    cwd: () => HERE,
    env: () => ({}),
    log: () => log,
    errLog: () => log,
    waitMs: 15000,
  };
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
// 加新一家：在这里加一项；并在 scripts/health.mjs 的 SOURCES 里加一行。

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
    id: 'zcode',
    title: 'ZCode (Z.ai)',
    port: 20131,
    kind: 'zcode',
    control: 'spawn',
    // zcode-bridge（MIT，Go 标准库单二进制）：把 ZCode 的编程套餐额度
    // 变成 /v1/chat/completions + /v1/messages 两种方言。
    // 它自己在账号池里轮询，router 只负责拉起、看账号和写 opencode provider。
    processes: [
      {
        name: 'zcode-bridge',
        port: 20132,
        command: () => resolveExecutable(ZCODE_DIR, ['zcode-bridge.exe', 'zcode-bridge']),
        args: () => [],
        cwd: () => ZCODE_DIR,
        // 账号文件固定在仓库内，避免 cwd 不同导致读到另一份
        env: () => ({ ZCODE_ACCOUNTS_FILE, PORT: '20132', ZCODE_LANE_WIDTH: '1' }),
        log: () => path.join(ZCODE_DIR, 'run.log'),
        errLog: () => path.join(ZCODE_DIR, 'run.log'),
        waitMs: 20000,
      },
      limitProxySpec('zcode', 20131, 20132, path.join(RUN_DIR, 'zcode-limit.log')),
    ],
    logs: [path.join(ZCODE_DIR, 'run.log')],
    ocProvider: 'zcode',
    ocName: 'ZCode（Z.ai）',
  },
  {
    id: 'loomy',
    title: 'Loomy（讯飞）',
    port: 8791,
    kind: 'loomy',
    control: 'spawn',
    // 本仓库自写的零依赖 Node 反代：读 Loomy 桌面端的 auth-session.json，
    // 把 imodel 网关转成 OpenAI 兼容端点；模型清单只取对话模型（type=chat）。
    processes: [
      {
        name: 'loomy-proxy',
        port: 8791,
        command: () => process.execPath,
        args: () => {
          const script = path.join(LOOMY_DIR, 'loomy-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 loomy-proxy.js：${script}`);
          return [script, '--port', '8791'];
        },
        cwd: () => LOOMY_DIR,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'loomy.log'),
        errLog: () => path.join(RUN_DIR, 'loomy.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 15000,
      },
    ],
    logs: [path.join(RUN_DIR, 'loomy.log')],
    ocProvider: 'loomy',
    ocName: 'Loomy（讯飞 iModel）',
    ocApiKey: 'loomy-local',
    // 上游把生图模型也列在 /models 里；它们不能走 chat/completions。
    modelsPath: '/models?type=chat',
  },
  {
    id: 'raccoon',
    title: '商汤小浣熊',
    port: 8793,
    kind: 'raccoon',
    control: 'spawn',
    // 本仓库自写的零依赖 Node 反代：读桌面端 agent/config/auth.json 的 IAM token，
    // 上游（xiaohuanxiong.com/api/web/llm/v2）本来就吐 OpenAI 格式，代理只补鉴权、
    // 模型目录（model_catalog）与积分（points/v1/balance）。
    processes: [
      {
        name: 'raccoon-proxy',
        port: 8793,
        command: () => process.execPath,
        args: () => {
          const script = path.join(RACCOON_DIR, 'raccoon-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 raccoon-proxy.js：${script}`);
          return [script, '--port', '8793'];
        },
        cwd: () => RACCOON_DIR,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'raccoon.log'),
        errLog: () => path.join(RUN_DIR, 'raccoon.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 15000,
      },
    ],
    logs: [path.join(RUN_DIR, 'raccoon.log')],
    ocProvider: 'raccoon',
    ocName: '商汤小浣熊（Raccoon Work）',
    ocApiKey: 'raccoon-local',
  },
  {
    id: 'qwenwork',
    title: '千问办公',
    port: 8794,
    kind: 'qwenwork',
    control: 'spawn',
    // 本仓库自写的零依赖 Node 反代：从桌面端的 OSCrypt 容器里读 MaaS key，
    // 再用 /v1/access-tokens/exchange 自持续期。上游原生支持两种方言，
    // 所以 OpenAI 与 Anthropic 两条路径都直接透传，不做协议转换。
    processes: [
      {
        name: 'qwenwork-proxy',
        port: 8794,
        command: () => process.execPath,
        args: () => {
          const script = path.join(QWENWORK_DIR, 'qwenwork-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 qwenwork-proxy.js：${script}`);
          return [script, '--port', '8794'];
        },
        cwd: () => QWENWORK_DIR,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'qwenwork.log'),
        errLog: () => path.join(RUN_DIR, 'qwenwork.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 20000,
      },
    ],
    logs: [path.join(RUN_DIR, 'qwenwork.log')],
    ocProvider: 'qwenwork',
    ocName: '千问办公（QwenWork）',
    ocApiKey: 'qwenwork-local',
  },
  {
    id: 'dumate',
    title: '百度搭子',
    port: 8795,
    kind: 'dumate',
    control: 'spawn',
    // 本仓库自写的零依赖 Node 反代：桌面端 main-server 的端口每次启动随机，
    // 代理从 electron.log / 进程命令行发现端口，读落盘的 opencode.json 模型表，
    // 再透传它免鉴权的 /api/qianfanproxy/v1。
    processes: [
      {
        name: 'dumate-proxy',
        port: 8795,
        command: () => process.execPath,
        args: () => {
          const script = path.join(DUMATE_DIR, 'dumate-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 dumate-proxy.js：${script}`);
          return [script, '--port', '8795'];
        },
        cwd: () => DUMATE_DIR,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'dumate.log'),
        errLog: () => path.join(RUN_DIR, 'dumate.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 15000,
      },
    ],
    logs: [path.join(RUN_DIR, 'dumate.log')],
    ocProvider: 'dumate',
    ocName: '百度搭子（DuMate）',
    ocApiKey: 'dumate-local',
  },
  {
    id: 'lingxi',
    title: 'WPS 灵犀',
    port: 8796,
    kind: 'lingxi',
    control: 'spawn',
    // 本仓库自写的零依赖 Node 反代：自己 spawn 一个 lingxi.exe app-server，
    // 用桌面端 cookie 库里的 wps_sid 鉴权，把 OpenAI 的 /v1/models 与
    // /v1/chat/completions 翻译成它的原生 JSON-RPC（initialize → session/start →
    // run/start → 收集 component.content 事件）。同时保留只读积分端点。
    // 注意：灵犀是完整 agent，不吐 OpenAI tool_calls，模型标 tool_call=false，
    // 适合对话，不适合当 opencode/pi 的编码 agent 驱动（见 README）。
    processes: [
      {
        name: 'lingxi-proxy',
        port: 8796,
        command: () => process.execPath,
        args: () => {
          const script = path.join(LINGXI_DIR, 'lingxi-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 lingxi-proxy.js：${script}`);
          return [script, '--port', '8796'];
        },
        cwd: () => LINGXI_DIR,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'lingxi.log'),
        errLog: () => path.join(RUN_DIR, 'lingxi.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 25000,
      },
    ],
    logs: [path.join(RUN_DIR, 'lingxi.log')],
    ocProvider: 'lingxi',
    ocName: 'WPS 灵犀（Lingxi）',
    ocApiKey: 'lingxi-local',
    // 灵犀不吐 OpenAI tool_calls。实时目录里有 capabilities.tool_call=false，
    // 但退到 pi 快照时那份 schema 没有工具位，所以这里显式声明。
    ocNoTools: true,
  },
  {
    id: 'lobster',
    title: '有道龙虾（LobsterAI）',
    port: 8797,
    kind: 'lobster',
    control: 'spawn',
    // 本仓库自写的零依赖 Node 反代：登录态在 LobsterAI 桌面端的 SQLite（kv.auth_tokens），
    // 对话优先转发给桌面端自己的 tokenProxy（刷新与用量都归它），桌面端退出后直连上游。
    // 模型目录、积分包、签到状态与逐模型倍率由反代补齐。
    processes: [
      {
        name: 'lobster-proxy',
        port: 8797,
        command: () => process.execPath,
        args: () => {
          const script = path.join(LOBSTER_DIR, 'lobster-proxy.js');
          if (!fs.existsSync(script)) throw new Error(`找不到 lobster-proxy.js：${script}`);
          return [script, '--port', '8797'];
        },
        cwd: () => LOBSTER_DIR,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'lobster.log'),
        errLog: () => path.join(RUN_DIR, 'lobster.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 15000,
      },
    ],
    logs: [path.join(RUN_DIR, 'lobster.log')],
    ocProvider: 'lobster',
    ocName: '有道龙虾（LobsterAI）',
    ocApiKey: 'lobster-local',
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
        port: 18787,
        command: () => findUv(),
        args: () => workbuddyArgs('domestic', 18787),
        cwd: () => path.join(HOME, '.workbuddy2api'),
        env: () => ({ PYTHONUTF8: '1' }),
        log: () => path.join(HOME, '.workbuddy2api', 'proxy-stdout.log'),
        errLog: () => path.join(HOME, '.workbuddy2api', 'proxy-stdout.log'),
        ensureDirs: [path.join(HOME, '.workbuddy2api')],
        waitMs: 60000,
      },
      limitProxySpec('workbuddy', 8787, 18787, path.join(RUN_DIR, 'workbuddy-limit.log')),
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
        port: 18788,
        command: () => findUv(),
        args: () => workbuddyArgs('global', 18788),
        cwd: () => path.join(HOME, '.workbuddy2api', 'global'),
        env: () => ({ PYTHONUTF8: '1' }),
        log: () => path.join(HOME, '.workbuddy2api', 'global', 'proxy-stdout.log'),
        errLog: () => path.join(HOME, '.workbuddy2api', 'global', 'proxy-stdout.log'),
        ensureDirs: [path.join(HOME, '.workbuddy2api', 'global')],
        waitMs: 60000,
      },
      limitProxySpec('workbuddy-global', 8788, 18788, path.join(RUN_DIR, 'workbuddy-global-limit.log')),
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
  {
    // 统一网关：把上面十三家合成一个端口 + 两种方言。
    // 它不是反代（没有上游），所以 processes 里只有一个 node 进程，且**不写 opencode**
    // ——是否把客户端切到网关上由用户决定（`router gateway install` 会写一份 provider）。
    id: 'gateway',
    title: '统一网关',
    port: GATEWAY_PORT,
    kind: 'gateway',
    control: 'spawn',
    processes: [
      {
        name: 'router-gateway',
        port: GATEWAY_PORT,
        command: () => process.execPath,
        args: () => [path.join(GATEWAY_DIR, 'server.mjs')],
        cwd: () => HERE,
        env: () => ({}),
        log: () => path.join(RUN_DIR, 'gateway.log'),
        errLog: () => path.join(RUN_DIR, 'gateway.log'),
        ensureDirs: [RUN_DIR],
        waitMs: 15000,
      },
    ],
    logs: [path.join(RUN_DIR, 'gateway.log')],
    // 网关的模型目录是十三家的并集，由它自己按需拉取，所以不参与 router 的写 provider 流程
    ocProvider: 'router-gateway',
    ocName: 'router 统一网关',
    ocApiKey: 'router-local',
    gateway: true,
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
  if (pids.size) return [...pids];
  // 最小化 Linux 环境不一定装 lsof，用 iproute2 的 ss 兜底。
  const s = spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf8' });
  for (const m of (s.stdout || '').matchAll(/pid=(\d+)/g)) {
    const pid = Number(m[1]);
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

async function fetchModels(port, apiKey, timeout = 6000, modelsPath = '/models') {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`http://127.0.0.1:${port}/v1${modelsPath}`, {
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

/** opencode.json 里某个 provider 的模型数；没配置时返回 null。 */
function ocModelCount(providerId) {
  const mod = requireShared('opencode-config.js');
  if (mod && typeof mod.providerModelCount === 'function') {
    try {
      return mod.providerModelCount(providerId);
    } catch {}
  }
  return null;
}

async function modelCount(provider) {
  // 只接积分的来源没有模型清单，别每次 list 都去打那个必然 501 的端点。
  if (provider.creditsOnly) return null;
  // WorkBuddy 反代的 /v1/models 是包作者猜的静态表（见 docs/02-pitfalls.md P3），
  // 和客户端实际能选的模型对不上。客户端从 pi 扩展拿真实目录，所以这里优先报
  // opencode 里已经写好的数量，回退时才看反代表。
  if (provider.kind === 'workbuddy') {
    const configured = ocModelCount(provider.ocProvider);
    if (configured !== null) return configured;
  }
  const models = await fetchModels(provider.port, keyFor(provider.id), 6000, provider.modelsPath || '/models');
  if (!models) return null;
  // 和写 opencode 时用同一份过滤，否则表格里的数字比客户端实际能选的多数十个
  const usable = provider.ocSkip ? models.filter((m) => !provider.ocSkip(m.id || m.slug)) : models;
  return usable.length;
}

async function fetchModelsRetry(port, apiKey, attempts = 3, modelsPath = '/models') {
  for (let i = 0; i < attempts; i++) {
    const models = await fetchModels(port, apiKey, 6000, modelsPath);
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

/** 清掉 CodeArts 某账号的历史失败计数（只清状态，不碰凭证）。 */
async function clearCodeartsErrors(p, accountId) {
  if (!accountId) return;
  try {
    await fetchJson(`http://127.0.0.1:${p.port}/admin/api/accounts`, {
      method: 'POST',
      headers: codeartsAdminHeaders(),
      body: JSON.stringify({ action: 'clear-errors', id: accountId }),
      timeout: 5000,
    });
  } catch {}
}

/**
 * CodeArts 的浏览器登录**不会更新旧账号**，而是每次都追加一条。
 *
 * 网关按 `user_data` 或 `access_key` 判断「同一个账号」（store.UpsertAccount），
 * 但浏览器登录这条路径两者都给不出：`user_data` 为空，`access_key` 每次登录
 * 都是新签发的 STS。`CallerIdentity` 本可以补上 domain_id，但它在这条链路上
 * 取不到（返回空），于是每次 `login --force` 都会在池子里多一条同账号记录。
 *
 * 结果就是「重登一次，账号池多一条」，轮询时一半请求打在旧凭据上照样失败。
 * 网关源码是第三方的，不在这里改；router 侧做两件事：
 *   1. 登录前后对比，发现「新增而不是更新」就明确告知；
 *   2. 提供 merge 把同一 domain 的重复账号收敛成一条（保留可用的那条）。
 */
function codeartsDuplicateGroups() {
  const data = readJsonFile(CODEARTS_DATA_FILE);
  const accounts = (data && Array.isArray(data.accounts) && data.accounts) || [];
  const byDomain = new Map();
  for (const a of accounts) {
    const domain = a.session && a.session.domain_id;
    // 只按 domain_id 归组：这是网关注入的稳定账号标识，桌面端导入的账号都有。
    // 浏览器登录路径拿不到它（见上面注释），那些账号无法可靠判定归属，
    // 宁可不动也不要按名字猜——名字是 AccessKey 前缀，每次登录都不同。
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(a);
  }
  return [...byDomain.values()].filter((g) => g.length > 1);
}

/** 账号池里有多少条「无法判定归属」的浏览器登录记录（每次重登 +1）。 */
function codeartsOrphanLogins() {
  const data = readJsonFile(CODEARTS_DATA_FILE);
  const accounts = (data && Array.isArray(data.accounts) && data.accounts) || [];
  return accounts.filter((a) => !(a.session && a.session.domain_id));
}

/**
 * 按**套餐用量指纹**找出同一账号的重复记录。
 *
 * `domain_id` 在浏览器登录路径拿不到，`resource_id` 也不稳定（要上游返回套餐详情
 * 才有，多数时候是 null）。但 `/admin/api/credits` 的**累计用量**是稳定的：
 * 同一个华为云账号查询到 `token_used` / `total` / `used` 完全相同，不同账号不会撞。
 * 实测：`hw000000000000000` 与 `CodeArts HSTADEMO1` 都是
 * `token_used=947496598, total=7600, used=6610.75`；另一账号是
 * `221038131 / 6600 / 2322.98`，一眼可分。
 *
 * 这只用来**发现重复**，删除仍要用户确认——用量相同的两个套餐理论上也可能
 * 是「同一账号下的两个套餐」，那种情况该保留还是删由人判断。
 */
async function codeartsSameAccountGroups(port) {
  const accounts = ((readJsonFile(CODEARTS_DATA_FILE) || {}).accounts || []).filter(Boolean);
  const byFingerprint = new Map();
  for (const a of accounts) {
    let fp = null;
    let detail = null;
    try {
      const j = await fetchJson(
        `http://127.0.0.1:${port}/admin/api/credits?id=${encodeURIComponent(a.id)}&fresh=1`,
        { timeout: 8000 },
      );
      const c = j && Array.isArray(j.accounts) ? j.accounts[0] && j.accounts[0].credit : null;
      if (c && c.token_used != null) {
        fp = [c.total, c.used, c.token_used, c.reset_date].join('|');
        detail = c;
      }
    } catch {}
    if (!fp) continue;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, { accounts: [], credit: detail });
    byFingerprint.get(fp).accounts.push(a);
  }
  return [...byFingerprint.values()].filter((g) => g.accounts.length > 1);
}

async function loginCodearts(p) {
  const up = await probePort(p.port, 1000);
  const beforeIds = new Set(accountsFor(p).map((a) => a.key));
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
      // 重新登录后把该账号的失败计数清零：否则它会一直停在 status=error，
      // 每次 list/account 都提示「需要重新登录」，而其实刚登录过。
      await clearCodeartsErrors(p, poll.account_id || poll.id);
      // 这条登录路径每次都会新增账号而不是更新旧的（见 codeartsDuplicateGroups 注释）
      const after = accountsFor(p).map((a) => a.key);
      const added = after.filter((k) => !beforeIds.has(k));
      if (added.length && beforeIds.size) {
        warn(`这次登录在账号池里新增了 ${added.length} 条记录，而不是更新旧账号`);
        say(dim('  CodeArts 的浏览器登录每次都会拿到新 STS，网关认不出是同一个账号'));
        say(dim(`  合并重复：node router.mjs account merge ${p.id}`));
      }
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

// ---------------------------------------------------------------- ZCode
//
// zcode-bridge 自己就是一个完整的账号环：`login` 走 OAuth 设备码，账号写在
// data/accounts.json（0600），轮询、续期、失败冷却都在它内部完成。
// 所以 router 这边只需要：拉起进程、调它的 CLI 做增删/设默认、读账号文件展示。

function zcodeExe() {
  return resolveExecutable(ZCODE_DIR, ['zcode-bridge.exe', 'zcode-bridge']);
}

/** 同步跑一次 zcode-bridge 的账号子命令，返回 {ok, out}。 */
function runZcodeCli(args) {
  const exe = zcodeExe();
  if (!fs.existsSync(exe)) return { ok: false, out: `找不到 zcode-bridge：${exe}` };
  const r = spawnSync(exe, args, {
    cwd: ZCODE_DIR,
    env: { ...process.env, ZCODE_ACCOUNTS_FILE },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/**
 * 登录：走设备码，bridge 打印授权链接后轮询。
 * 链接一出现就自动打开浏览器；用户确认后 CLI 自己写账号文件。
 */
async function loginZcode(p, { label = '' } = {}) {
  const exe = zcodeExe();
  if (!fs.existsSync(exe)) {
    bad(`找不到 zcode-bridge：${exe}`);
    say(dim('  构建：cd integrations/zcode-bridge && go build -o zcode-bridge.exe ./cmd/zcode-bridge'));
    return false;
  }
  say(`  ${dim('ZCode 会给一个授权链接；在已登录 Z.ai 的浏览器里确认即可。')}`);

  const args = ['login'];
  if (label) args.push('--label', label);

  const before = new Set(zcodeAccounts().map((a) => a.key));
  const child = spawn(exe, args, {
    cwd: ZCODE_DIR,
    env: { ...process.env, ZCODE_ACCOUNTS_FILE },
    windowsHide: false,
  });

  let opened = false;
  const handle = (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    if (!opened) {
      const m = text.match(/https:\/\/[^\s)]+/);
      if (m) {
        opened = openBrowser(m[0]);
        if (!opened) say(dim(`  · 浏览器没有自动打开，请手动复制上面的链接`));
      }
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);

  const code = await new Promise((res) => {
    child.on('exit', (c) => res(c));
    child.on('error', () => res(-1));
  });
  if (code !== 0) {
    bad(`ZCode 登录未完成（退出码 ${code}）`);
    return false;
  }

  const st = zcodeAuth();
  if (!st.ok) {
    bad('登录流程结束，但账号池里仍没有可用授权');
    return false;
  }
  ok(`ZCode ${st.label}`);
  const added = zcodeAccounts().filter((a) => !before.has(a.key));
  if (added.length) {
    ok(`已添加 ${added.length} 个账号：${added.map((a) => `${a.key}（${a.name}）`).join('、')}`);
  }
  return true;
}

/** 切换轮询头：bridge 的 default 账号排在最前。 */
async function switchZcodeAccount(p, target, { dryRun = false } = {}) {
  if (target.active) {
    ok(`当前已经是账号 ${target.key}（${target.name}）`);
    return 0;
  }
  if (dryRun) {
    say(`\x1b[1;33m[dry-run]\x1b[0m 将把 ${p.title} 的轮询头切到 ${target.key}（${target.name}）`);
    return 0;
  }
  const r = runZcodeCli(['login', '--set-default', String(target.key)]);
  if (!r.ok) {
    bad(`设置默认账号失败：${r.out}`);
    return 1;
  }
  ok(`已切换 ${p.title} 到账号 ${target.key}（${target.name}）`);
  say('');
  printAccounts(p, accountsFor(p));
  return 0;
}

async function removeZcodeAccount(p, target, { dryRun = false } = {}) {
  if (target.key === '(desktop)') {
    return { error: '桌面端凭据不归 router 管，请在 ZCode 桌面端退出登录' };
  }
  if (target.key === '(pinned)') {
    return {
      error: '固定凭据来自 plan-jwt.json',
      hint: `要删除请手动删 ${path.join(ZCODE_DIR, 'plan-jwt.json')}，或改回用桌面端凭据`,
    };
  }
  if (dryRun) {
    say(`\x1b[1;33m[dry-run]\x1b[0m 将删除 ZCode 的账号 ${target.key}（${target.name}）`);
    return { ok: true };
  }
  const data = zcodeStore();
  const rec = (data.accounts || []).find((a) => a.id === target.key);
  const dir = path.join(ZCODE_DIR, 'retired-' + stampNow());
  const archived = rec
    ? (() => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const dest = path.join(dir, `${target.key}.json`);
          fs.writeFileSync(dest, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
          return dest;
        } catch {
          return null;
        }
      })()
    : null;
  const r = runZcodeCli(['login', '--remove', String(target.key)]);
  if (!r.ok) return { error: `删除失败：${r.out}` };
  return { ok: true, archived };
}

// ---------------------------------------------------------------- ZCode 领取
//
// 国内版 ZCode 会在周末/夜间放出限时 Token 套餐（ZCODE WEEKEND BUILD 之类），
// 需要在桌面端手动点“领取”。协议来自 MIT 项目 L0NE-6/ZCode-Daily：
//   GET  /api/v1/zcode-plan/billing/preview?app_version=&platform=
//   POST /api/v1/zcode-plan/billing/claim  {"plan_id": "..."}
// 两者都要 Bearer JWT + X-Device-Mid。这里用 Node 直接实现，不引入 Python 依赖。

const ZCODE_ORIGIN = 'https://zcode.z.ai';
const ZCODE_APP_VERSION = '3.18.0';
const ZCODE_DEVICE_FILE = path.join(ZCODE_DIR, 'data', 'device-mid.txt');

/** 领取用的设备指纹：首次生成后固定，换设备重新生成即可。 */
function zcodeDeviceMid() {
  try {
    const saved = fs.readFileSync(ZCODE_DEVICE_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(ZCODE_DEVICE_FILE), { recursive: true });
    fs.writeFileSync(ZCODE_DEVICE_FILE, `${id}\n`, { mode: 0o600 });
  } catch {}
  return id;
}

/**
 * 读 ZCode 桌面端凭据里的 plan JWT。
 * 与 zcode-bridge 同样的 KDF：Electron 用 process.platform（Windows 上是 win32）
 * 和不带域名的用户名，Go/Node 的默认实现都拿不到，这里显式对齐。
 */
function zcodeDesktopJwt() {
  const stateDir =
    process.env.ZCODE_STATE_DIR || path.join(HOME, '.zcode', 'v2');
  const file = path.join(stateDir, 'credentials.json');
  const rec = readJsonFile(file);
  const value = rec && rec.zcodejwttoken;
  if (typeof value !== 'string' || !value) return null;
  if (!value.startsWith('enc:v1:')) return value || null;

  let username = '';
  try {
    username = os.userInfo().username;
  } catch {}
  if (!username) username = process.env.USERNAME || '';
  username = username.split(/[\\/]/).pop();

  const platform = process.platform; // win32 / darwin / linux
  const key = createHash('sha256')
    .update(`zcode-credential-fallback:${platform}:${HOME}:${username}`)
    .digest();
  const [iv, tag, data] = value.slice('enc:v1:'.length).split('.');
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 领取用哪个 token：账号池 → plan-jwt.json → 桌面端凭据（与 bridge 的解析顺序一致）。 */
function zcodeClaimToken() {
  const data = zcodeStore();
  const list = (data.accounts || []).filter((a) => a && a.jwt && !a.needsReauth);
  const pick = list.find((a) => a.id === data.default) || list[0];
  if (pick) return { jwt: pick.jwt, who: pick.label || pick.email || pick.id };
  const pinned = zcodeSingleToken();
  if (pinned && typeof pinned.jwt === 'string' && pinned.jwt) {
    return { jwt: pinned.jwt, who: 'plan-jwt.json' };
  }
  const desk = zcodeDesktopJwt();
  if (desk) return { jwt: desk, who: 'ZCode 桌面端' };
  return null;
}

async function zcodeApi(pathname, { jwt, device, method = 'GET', body } = {}) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${jwt}`,
    'x-device-mid': device,
    'x-client-language': 'zh-CN',
    'x-zcode-app-version': ZCODE_APP_VERSION,
    'x-platform': process.platform === 'win32' ? 'win32' : process.platform,
  };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${ZCODE_ORIGIN}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function fmtUnix(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '?';
  return new Date(n * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/**
 * 领取当前可领的限时套餐。
 * 已领过的活动上游会回 1003（按成功处理）；没必要重复领取。
 */
async function claimZcode({ dryRun = false, only = null } = {}) {
  const cred = zcodeClaimToken();
  if (!cred) {
    return { error: '没有可用的 ZCode 凭据', hint: 'node router.mjs login zcode（或确认 ZCode 桌面端已登录）' };
  }
  const device = zcodeDeviceMid();
  if (!dryRun) say(dim(`  使用凭据：${cred.who}`));

  const prev = await zcodeApi(
    `/api/v1/zcode-plan/billing/preview?app_version=${ZCODE_APP_VERSION}&platform=${process.platform === 'win32' ? 'win32' : process.platform}`,
    { jwt: cred.jwt, device },
  );
  if (prev.status === 401) {
    return { error: '登录状态失效（401）', hint: 'node router.mjs login zcode' };
  }
  if (prev.status === 404) return { ok: true, skipped: '领取接口未上线（404）' };
  const plans = (prev.json && prev.json.data && Array.isArray(prev.json.data.plans) ? prev.json.data.plans : []).filter(
    (p) => p && p.plan_id,
  );

  if (!plans.length) {
    // 再看一眼当前已有套餐，确认是“已领取”还是“本期没有活动”
    const cur = await zcodeApi('/api/v1/zcode-plan/billing/current', { jwt: cred.jwt, device }).catch(() => null);
    const active =
      cur && cur.json && cur.json.data && Array.isArray(cur.json.data.plans) ? cur.json.data.plans : [];
    if (active.length) {
      const names = active.map((p) => `${p.name || p.plan_id}（至 ${fmtUnix(p.ends_at)}）`).join('、');
      return { ok: true, active, message: `当前没有可领的新套餐；已生效：${names}` };
    }
    return { ok: true, message: '当前没有可领的套餐（本期活动未开放或已领完）' };
  }

  const wanted = only || '';
  const target = wanted ? plans.find((p) => p.plan_id === wanted) : plans.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  if (!target) return { error: `预览里没有 plan_id = ${wanted}` };

  const title = `${target.name || target.plan_id}（priority ${target.priority ?? '?'}，${fmtUnix(target.starts_at)} → ${fmtUnix(target.ends_at)}）`;
  if (dryRun) return { ok: true, dryRun: true, message: `可领取：${title}`, plans };

  const claimed = await zcodeApi('/api/v1/zcode-plan/billing/claim', {
    jwt: cred.jwt,
    device,
    method: 'POST',
    body: { plan_id: target.plan_id },
  });
  const code = claimed.json && claimed.json.code;
  if (claimed.status === 200 && (code === 0 || code === undefined)) {
    return { ok: true, claimed: true, message: `已领取：${title}` };
  }
  if (code === 1003) return { ok: true, claimed: false, message: '本期已领取过（1003）' };
  if (code === 1005) {
    return { ok: false, message: `本期名额已用完（1005，结束于 ${fmtUnix(claimed.json.ends_at)}）` };
  }
  return {
    ok: false,
    message: `领取失败：HTTP ${claimed.status} ${(claimed.json && (claimed.json.msg || claimed.json.message)) || claimed.text.slice(0, 120)}`,
  };
}

/** Loomy 没有命令行登录接口：只能拉起桌面端，等它把 session 写进 auth-session.json。 */
function loomyExe() {
  const candidates = [
    process.env.LOOMY_EXE,
    'D:\\Loomy\\Loomy.exe',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Loomy', 'Loomy.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Loomy', 'Loomy.exe'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

async function loginLoomy(p, { force = false } = {}) {
  const before = readLoomySession();
  if (before && !force) {
    ok(`${p.title} ${loomyAuth().label}`);
    return true;
  }
  const exe = loomyExe();
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      say(dim(`  已打开 ${path.basename(exe)}，请在窗口里完成登录（最多等 2 分钟）`));
    } catch (e) {
      warn(`  打不开 Loomy：${e.message}`);
    }
  } else {
    warn('  找不到 Loomy.exe；请手动打开 Loomy 桌面端并登录');
  }
  say(dim(`  登录态文件：${loomyAuthFile()}`));
  for (let i = 0; i < 60; i += 1) {
    const now = readLoomySession();
    // --force 时只有 token 或 updatedAt 真的变了才算重新登录成功，否则会立刻把旧
    // 登录态当成新结果返回。
    const changed = now && (!before || now.token !== before.token || now.updatedAt !== before.updatedAt);
    if (changed) {
      ok(`${p.title} 已登录（${loomyAuth().label.replace(/^已登录（|）$/g, '')}）`);
      return true;
    }
    await sleep(2000);
  }
  bad(`${p.title} 仍未读到登录态（${loomyAuthFile()}）`);
  return false;
}

/** 小浣熊同样没有命令行登录接口：只能拉起桌面端，等它把 token 写进 auth.json。 */
function raccoonExe() {
  const candidates = [
    process.env.RACCOON_EXE,
    path.join('D:', 'ShangTang', '@raccoonoffice-desktop', '商汤小浣熊.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', '商汤小浣熊', '商汤小浣熊.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'raccoonoffice-desktop', '商汤小浣熊.exe'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

async function loginRaccoon(p, { force = false } = {}) {
  const before = readRaccoonSession();
  if (before && !force) {
    ok(`${p.title} ${raccoonAuth().label}`);
    return true;
  }
  const exe = raccoonExe();
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      say(dim(`  已打开 ${path.basename(exe)}，请在窗口里完成登录（最多等 2 分钟）`));
    } catch (e) {
      warn(`  打不开小浣熊：${e.message}`);
    }
  } else {
    warn('  找不到「商汤小浣熊.exe」；请手动打开桌面端并登录');
  }
  say(dim(`  登录态文件：${raccoonAuthFile()}`));
  for (let i = 0; i < 60; i += 1) {
    const now = readRaccoonSession();
    // --force 时只有 token 或文件 mtime 真的变了才算重新登录成功。
    const changed = now && (!before || now.token !== before.token || now.updatedAt !== before.updatedAt);
    if (changed) {
      ok(`${p.title} 已登录（${raccoonAuth().label.replace(/^已登录（|）$/g, '')}）`);
      return true;
    }
    await sleep(2000);
  }
  bad(`${p.title} 仍未读到登录态（${raccoonAuthFile()}）`);
  return false;
}

/** 百度搭子同样没有命令行登录接口：拉起桌面端，等它把账号写进 auth.json。 */
function dumateExe() {
  const candidates = [
    process.env.DUMATE_EXE,
    'D:\\DuMate\\DuMate.exe',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'DuMate', 'DuMate.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'DuMate', 'DuMate.exe'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

async function loginDumate(p, { force = false } = {}) {
  const before = readDumateProfile();
  if (before && !force) {
    ok(`${p.title} ${dumateAuth().label}`);
    return true;
  }
  const exe = dumateExe();
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      say(dim(`  已打开 ${path.basename(exe)}，请在窗口里完成登录（最多等 2 分钟）`));
    } catch (e) {
      warn(`  打不开百度搭子：${e.message}`);
    }
  } else {
    warn('  找不到 DuMate.exe；请手动打开百度搭子桌面端并登录');
  }
  say(dim(`  登录态文件：${path.join(dumateAppData(), 'auth.json')}`));
  for (let i = 0; i < 60; i += 1) {
    const now = readDumateProfile();
    // --force 时只有账号或最近登录时间真的变了才算重新登录成功。
    const changed = now && (!before || now.accountId !== before.accountId || now.lastLogin !== before.lastLogin);
    if (changed) {
      ok(`${p.title} 已登录（${dumateAuth().label.replace(/^已登录（|）$/g, '')}）`);
      return true;
    }
    await sleep(2000);
  }
  bad(`${p.title} 仍未读到登录态（${path.join(dumateAppData(), 'auth.json')}）`);
  return false;
}

/** 有道龙虾：没有命令行登录，拉起 LobsterAI 桌面端，等它把 auth_tokens 写进 SQLite。 */
function lobsterExe() {
  const candidates = [
    process.env.LOBSTER_EXE,
    'D:\\LobsterAI\\LobsterAI.exe',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'LobsterAI', 'LobsterAI.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'LobsterAI', 'LobsterAI.exe'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

async function loginLobster(p, { force = false } = {}) {
  const before = readLobsterSession();
  if (before && !force) {
    ok(`${p.title} ${lobsterAuth().label}`);
    return true;
  }
  const exe = lobsterExe();
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      say(dim(`  已打开 ${path.basename(exe)}，请在窗口里完成登录（最多等 2 分钟）`));
    } catch (e) {
      warn(`  打不开 LobsterAI：${e.message}`);
    }
  } else {
    warn('  找不到 LobsterAI.exe；请手动打开有道龙虾桌面端并登录');
  }
  say(dim(`  登录态：${lobsterDbFile()} 的 kv.auth_tokens`));
  for (let i = 0; i < 60; i += 1) {
    const now = readLobsterSession();
    // --force 时只有 access token 真的变了才算重新登录成功。
    const changed = now && (!before || now.token !== before.token);
    if (changed) {
      ok(`${p.title} 已登录（${lobsterAuth().label.replace(/^已登录（|）$/g, '')}）`);
      return true;
    }
    await sleep(2000);
  }
  bad(`${p.title} 仍未读到登录态（${lobsterDbFile()}）`);
  return false;
}

/**
 * 千问办公：同样没有命令行登录。它多一步——登录后必须在桌面端**发出过请求**，
 * 才会在 `engine-maas-key.dat` 里签发推理凭据；只登录不发请求时代理拿不到 key。
 */
function qwenworkExe() {
  const candidates = [
    process.env.QWENWORK_EXE,
    'D:\\QwenWork\\QwenWorkCN\\2.1.0-26111315\\QwenWorkCN.exe',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'QwenWork', 'QwenWorkCN.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'QwenWork', 'QwenWorkCN.exe'),
    '/opt/apps/QwenWorkCN/qwen-work-cn',
    '/usr/bin/qwen-work-cn',
    '/usr/local/bin/qwen-work-cn',
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

async function loginQwenwork(p, { force = false } = {}) {
  const before = qwenworkCredential();
  const expired = Boolean(before && before.expiresAtMs && before.expiresAtMs <= Date.now());
  // 过期不能当「已登录」跳过：exchange 需要用有效凭据才能换新，key 死了就换不了，
  // 只能回到桌面端重新签发。以前这里只看「文件在不在」，于是 login 一直说无需登录。
  if (before && !expired && !force && !before.pending) {
    ok(`${p.title} ${qwenworkAuth().label}`);
    return true;
  }
  if (expired) {
    warn(`  ${p.title} 的推理凭据已过期（${new Date(before.expiresAtMs).toISOString()}），过期后无法 exchange 自续`);
  }
  const exe = qwenworkExe();
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      say(dim(`  已打开 ${path.basename(exe)}，请在窗口里登录**并随便发一句话**（最多等 2 分钟）`));
    } catch (e) {
      warn(`  打不开千问办公：${e.message}`);
    }
  } else {
    warn('  找不到 QwenWorkCN.exe；请手动打开千问办公并登录');
  }
  const keyTarget = process.platform === 'win32' ? qwenworkKeyFile() : qwenworkCredentials.cacheFile();
  say(dim(`  推理凭据：${keyTarget}`));
  for (let i = 0; i < 60; i += 1) {
    // Linux/macOS：桌面端登录后 auth-v2.dat 一更新，这里就能直接签出 key。
    try {
      await qwenworkCredentials.ensureAccessKey({ force: true });
    } catch {}
    const now = qwenworkCredential();
    const changed =
      now &&
      !now.pending &&
      (!before || now.expiresAtMs !== before.expiresAtMs || now.sessionId !== before.sessionId);
    if (changed) {
      ok(`${p.title} 已登录（${qwenworkAuth().label.replace(/^已登录（|）$/g, '')}）`);
      return true;
    }
    await sleep(2000);
  }
  bad(`${p.title} 仍未读到推理凭据（${keyTarget}）`);
  say(dim('  提示：请确认桌面端已登录；反代会从 auth-v2.dat 自动签发 key'));
  return false;
}

async function loginProvider(p, { force = false } = {}) {
  const before = authStatus(p);
  // 千问办公是例外：凭据过期意味着「只能人工重新签发」，不能当已登录跳过。
  const needsHuman = p.kind === 'qwenwork' && before.state === 'expired';
  if (before.ok && !force && !needsHuman) {
    ok(`${p.title} ${before.label}`);
    return { ok: true, skipped: true, wasUp: false };
  }

  const wasUp = (await probePort(p.port, 1000)).up;
  let success = false;
  if (p.kind === 'qoder') success = await loginQoder(p);
  else if (p.kind === 'workbuddy') success = await loginWorkbuddy(p);
  else if (p.kind === 'trae') success = await loginTrae(p);
  else if (p.kind === 'codearts') success = await loginCodearts(p);
  else if (p.kind === 'zcode') success = await loginZcode(p);
  else if (p.kind === 'loomy') success = await loginLoomy(p, { force });
  else if (p.kind === 'raccoon') success = await loginRaccoon(p, { force });
  else if (p.kind === 'qwenwork') success = await loginQwenwork(p, { force });
  else if (p.kind === 'dumate') success = await loginDumate(p, { force });
  else if (p.kind === 'lobster') success = await loginLobster(p, { force });
  else if (p.kind === 'lingxi') {
    // 灵犀只能在桌面端登录（SID 写进 Electron cookie 库），没有命令行登录接口。
    if (lingxiInstalled()) {
      ok(`${p.title} ${lingxiAuth().label}`);
      say(dim('  登录：打开 WPS 灵犀桌面端；反代会自动从 cookie 库读 wps_sid'));
      say(dim('  智点余额：curl -s http://127.0.0.1:8796/v1/quota（或 opencode/pi 的 /credits）'));
      success = true;
    } else {
      bad(`未安装 WPS 灵犀桌面端`);
      success = false;
    }
  }
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
 *
 * `/v1/models` 拿不到时（典型：桌面端没登录，反代回 401）退到 pi 模型表里的
 * 快照，至少让 provider 出现在模型选择器里；登录后 `router models` 会用实时目录覆盖。
 */
/**
 * 取某家的模型清单：先试 '/v1/models'，失败再用 pi 模型表里的快照。
 *
 * 快照只在**首次写 provider**时用。刷新已存在的 provider 时用快照会把实时目录
 * 降级成旧数据（典型：桌面端 token 临时过期，`router models` 反而把模型表改小），
 * 所以调用方要用 `allowSnapshot: false` 关掉。
 */
async function providerModelList(p, { allowSnapshot = true } = {}) {
  const live = await fetchModelsRetry(p.port, keyFor(p.id), 3, p.modelsPath || '/models');
  if (live && live.length > 0) return { models: live, source: 'live' };
  if (!allowSnapshot) return { models: null, source: null };

  const snapshot = piModelsFor(p.ocProvider || p.id);
  if (!snapshot) return { models: null, source: null };
  // pi 里的条目顺序与反代一致，但形状不同；转成 /v1/models 的样子再走同一个映射
  const models = snapshot.map((m) => piModelAsListed(m, { noTools: p.ocNoTools })).filter(Boolean);
  return models.length > 0 ? { models, source: 'pi' } : { models: null, source: null };
}

async function addProviderFromModels(p) {
  // 只接积分的来源没有 /v1/models（反代会明确回 501），不该走到写 provider 这一步。
  if (p.creditsOnly) {
    return { ok: true, wrote: false };
  }
  const existing = locateProviderFiles(p.ocProvider);
  if (existing.length) {
    const where = existing.map((f) => path.basename(f)).join('、');
    ok(`${p.title} 的 provider 已在 ${where} 里，保持不动`);
    return { ok: true, wrote: false };
  }

  const { models: listed, source } = await providerModelList(p);
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
  const note = source === 'pi' ? '，用的是 pi 模型表快照（登录后会换成实时目录）' : '';
  ok(`${p.title} 已写入 opencode（${models.length} 个模型${note}）`);
  return { ok: true, wrote: true, backup: result.backup };
}

/**
 * 只刷新已存在的 provider 的模型清单（provider 本身、baseURL、apiKey 都不动）。
 *
 * `doSyncOpenCode` 只在 provider 不存在时才写入，所以上游加/删模型后它什么都不做——
 * 这就是 ZCode 的 opencode 里长期只有 1 个模型、Qoder 国内版还留着上游已停用模型的
 * 原因。这里补上另一半：拿实时目录覆盖 models，其它键保持原样。
 */
async function refreshProviderModels(p) {
  if (p.gateway) {
    // 网关的模型清单是十三家的并集，由 `router gateway install` 写；
    // 它不是反代，没有自己的 /v1/models 目录可刷新
    return { ok: true, skipped: true, reason: '网关的模型清单由 gateway install 写入' };
  }
  if (p.creditsOnly) {
    return { ok: true, skipped: true, reason: '只接积分，没有模型清单（余额由 credits 插件读）' };
  }

  const files = locateProviderFiles(p.ocProvider);
  if (!files.length) return { ok: false, reason: 'opencode 里还没这个 provider，先跑 up' };
  if (files.some((f) => f.endsWith('opencode.jsonc'))) {
    // 用户自己维护的配置（带注释），router 无权改——不算失败，只是跳过
    return { ok: true, skipped: true, reason: 'provider 在你自己的 opencode.jsonc 里，router 不改它' };
  }

  if (p.ocAdd) {
    // WorkBuddy 的模型表只能来自 pi 扩展（反代的 /v1/models 是包作者猜的静态表）
    const r = runTool(p.ocAdd[0], p.ocAdd.slice(1));
    if (!r.ok) return { ok: false, reason: (r.out || r.reason || '').split('\n').slice(-1)[0] };
    return { ok: true, wrote: true, models: ocModelCount(p.ocProvider) };
  }

  const { models: listed, source } = await providerModelList(p, { allowSnapshot: false });
  if (!listed || listed.length === 0) return { ok: false, reason: `拿不到模型列表（:${p.port}）` };
  const models = p.ocSkip ? listed.filter((m) => !p.ocSkip(m.id || m.slug)) : listed;
  const mod = requireShared('opencode-config.js');
  if (!mod) return { ok: false, reason: '找不到 opencode-config.js' };

  const before = ocModelCount(p.ocProvider);
  mod.mergeProviders([
    {
      id: p.ocProvider,
      name: p.ocName || p.title,
      baseURL: `http://127.0.0.1:${p.port}/v1`,
      apiKey: p.ocApiKey || keyFor(p.id) || 'local-proxy',
      models: mod.toOpencodeModels(models),
    },
  ]);
  return { ok: true, wrote: before !== models.length, models: models.length, before, source };
}

/** `router models [id...]`：把各家上游的最新模型目录写回 opencode。 */
async function doRefreshModels(ids) {
  const list = ids && ids.length ? PROVIDERS.filter((p) => ids.includes(p.id)) : PROVIDERS;
  const rows = [];
  for (const p of list) {
    if (!(await probePort(p.port)).up) {
      rows.push({ p, ok: false, reason: '未运行' });
      continue;
    }
    rows.push({ p, ...(await refreshProviderModels(p)) });
  }
  return rows;
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
    // 网关是叠加层：它自己的 provider 由 `router gateway install` 显式写入，
    // 不跟着开关自动增删——否则 `on gateway` 会顺手把十三家的 provider 全删掉。
    if (p.gateway) continue;
    // 只接积分的来源（creditsOnly，当前没有）没有模型目录，写进 opencode 只会
    // 得到一个选中就报错的假 provider。它的余额由 credits 插件直接读反代。
    if (p.creditsOnly) continue;
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
        // 网关是叠加层，没有独立的「开/关」：它的 on 直接反映进程状态。
        // 这样 TUI 的 drift 判定（on != up）不会把它误报成「已停用但仍在运行」。
        on: p.gateway ? probe.up : enabled.includes(p.id),
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
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          enabled,
          providers: rows,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  say(`${C.bold}转接选择${C.reset}  ${dim(STATE_FILE)}`);
  say('─'.repeat(92));
  say(
    `  ${padEnd('供应商', 20)} ${padEnd('开关', 6)} ${padEnd('进程', 18)} ${padEnd('管理', 10)} ${padEnd('opencode', 10)} 端口`,
  );
  for (const r of rows) {
    const p = PROVIDERS.find((x) => x.id === r.id);
    // 网关是叠加层，不属于「开/关」这套语义：它的开关列显示成「叠加」，
    // 否则每次 `up gateway` 之后 list 都会报一条假的 drift。
    const on = p?.gateway ? `${C.dim}叠加${C.reset}` : r.on ? `${C.ok}开${C.reset}` : `${C.dim}关${C.reset}`;
    const pid = r.pid ? ` ${dim(r.pid)}` : '';
    const up = r.up ? `${C.ok}运行中${C.reset}${pid}` : `${C.dim}已停${C.reset}`;
    const control = r.control === 'tool' ? '计划任务' : 'router';
    const oc = p?.creditsOnly
      ? `${C.dim}仅积分${C.reset}`
      : p?.gateway
        ? r.oc
          ? `${C.ok}已写入${C.reset}`
          : `${C.dim}未安装${C.reset}`
        : r.ocUserOwned
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

  const realRows = rows.filter((r) => !PROVIDERS.find((x) => x.id === r.id)?.gateway);
  const onCount = realRows.filter((r) => r.on).length;
  const upCount = rows.filter((r) => r.up).length;
  const gwUp = rows.some((r) => r.id === 'gateway' && r.up);
  say(
    `  ${onCount}/${realRows.length} 开启　·　${upCount} 个进程在跑${gwUp ? `　·　${C.ok}网关在 :${GATEWAY_PORT}${C.reset}` : ''}`,
  );

  const drift = rows.filter((r) => r.on !== r.up && !PROVIDERS.find((x) => x.id === r.id)?.gateway);
  if (drift.length) {
    say('');
    warn(`开关与进程不一致：${drift.map((r) => r.title).join('、')}`);
    for (const r of drift) {
      say(`  ${dim(r.on ? `启动：node router.mjs up ${r.id}` : `停止：node router.mjs down ${r.id}`)}`);
    }
  }

  // 用户自己在 .jsonc 里配的不算漂移——我们无权改，也不该一直提示。
  // 只接积分的来源（creditsOnly，当前没有）本来就不写 opencode provider，
  // r.oc 恒为 false，一样要排除，否则每次 list 都会报一条假的「开关与 opencode 不一致」。
  const ocDrift = rows.filter(
    (r) =>
      r.on !== r.oc &&
      !r.ocUserOwned &&
      !PROVIDERS.find((x) => x.id === r.id)?.gateway &&
      !PROVIDERS.find((x) => x.id === r.id)?.creditsOnly,
  );
  if (ocDrift.length) {
    warn(`开关与 opencode 配置不一致：${ocDrift.map((r) => r.title).join('、')}`);
    say(`  ${dim('执行 node router.mjs sync 同步')}`);
  }

  const unauth = rows.filter((r) => !r.auth.ok);
  if (unauth.length) {
    warn(`未登录：${unauth.map((r) => `${r.title}（${r.auth.label}）`).join('、')}`);
    say(`  ${dim(`登录：node router.mjs login ${unauth.map((r) => r.id).join(' ')}`)}`);
  }

  // 账号级别的故障：登录态整体正常，但池子里有个别账号需要重登/换号。
  // 这类问题不会让 list 的「进程/登录」亮红灯，却会让请求随机失败，必须单独提示。
  const accountAlerts = rows
    .map((r) => {
      const p = PROVIDERS.find((x) => x.id === r.id);
      const bad = accountIssues(p, accountsFor(p));
      return bad.length ? { r, bad } : null;
    })
    .filter(Boolean);
  if (accountAlerts.length) {
    const total = accountAlerts.reduce((n, a) => n + a.bad.length, 0);
    warn(`账号异常 ${total} 个：${accountAlerts.map((a) => `${a.r.title} ${a.bad.length}`).join('、')}`);
    for (const { r, bad } of accountAlerts) {
      for (const a of bad) {
        const tag = a.health.level === 'error' ? C.bad : C.warn;
        say(`  ${tag} ${padEnd(r.title, 18)} ${padEnd(a.name, 18)} ${dim(a.health.notes.join('；'))}`);
      }
      say(`  ${dim(`  修：${accountFixHint(PROVIDERS.find((x) => x.id === r.id), bad[0])}`)}`);
    }
    say(`  ${dim('只看账号问题：node router.mjs account check')}`);
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

// ---------------------------------------------------------------- 本机限额
//
// 为什么 router 要有这个命令：限额是「防止上游判定套流」的那条线，必须能一眼
// 看到**实际生效值**（含硬约束封顶），而不是让人去读源码里那几张表。
//
//   node router.mjs limits                 看全部
//   node router.mjs limits raccoon         看一家
//   node router.mjs limits raccoon max     改档位（写 limits.json）
//   node router.mjs limits raccoon rpm 6   改单项
//   node router.mjs limits --check         体检：有没有被硬约束压掉的配置

function loadLimiterModule() {
  return require(path.join(HERE, 'integrations', 'limits', 'limiter.js'));
}

/**
 * 把限额推给自带限流器的反代。
 *
 * 只有 CodeArts 需要：它的 Go 网关有独立的 `rate_limit_*` 设置，默认值
 * （5 QPS / 突发 10 / 并发 8）远高于上游「每账号 3 个并发会话」的硬约束。
 * 其它反代（tw2api / zcode-bridge / WorkBuddy）没有可在线修改的限流参数，
 * 只能靠 router 与网关这一层挡住。
 */
async function applyLimitsToProviders(mod, cfg) {
  const rows = mod.describeLimits(['codearts'], { cfg });
  const row = rows[0];
  if (!row) {
    bad('没有可下发的供应商');
    return 1;
  }
  const port = PROVIDERS.find((p) => p.id === 'codearts')?.port || 10087;
  const up = await probePort(port, 1200);
  if (!up.up) {
    warn(`CodeArts 没在 :${port} 上跑，跳过（先 node router.mjs up codearts）`);
    return 1;
  }
  // 把 rpm 换算成 QPS：向上取整到 1，避免 40rpm 变成 0.67 被服务端当 0 忽略
  const qps = Math.max(1, Math.round(row.rpm / 60));
  const body = {
    rate_limit_enabled: true,
    rate_limit_qps: qps,
    rate_limit_burst: Math.max(1, row.burst),
    rate_limit_concurrency: row.concurrency,
  };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      bad(`下发失败：HTTP ${res.status}（CodeArts 可能设了管理密码）`);
      return 1;
    }
    const data = await res.json().catch(() => null);
    ok(
      `已下发到 CodeArts：QPS ${data?.rate_limit_qps ?? qps}、突发 ${data?.rate_limit_burst ?? body.rate_limit_burst}、并发 ${data?.rate_limit_concurrency ?? row.concurrency}`,
    );
    say(dim('  注意：CodeArts 的限流是「每密钥」，router 侧还有一层「每进程」'));
    return 0;
  } catch (e) {
    bad(`下发失败：${e.message}`);
    return 1;
  }
}

async function cmdLimits(raw, { json = false } = {}) {
  const mod = loadLimiterModule();
  const args = raw.filter((a) => !a.startsWith('--'));
  const checkOnly = raw.includes('--check');
  const apply = raw.includes('--apply');
  const cfg = mod.loadLimits();

  // --apply：把限额推给「自己有独立限流器」的反代（目前只有 CodeArts）。
  // 为什么需要：CodeArts2API 内部默认 5 QPS / 突发 10 / 并发 8，而它上游的硬约束
  // 是「每账号 3 个并发会话」。不改它，router 侧的限额只管网关，客户端直连
  // :10087 时仍然会打满 8 路。
  if (apply) {
    return applyLimitsToProviders(mod, cfg);
  }

  if (args.length >= 2) {
    // limits <id> <tier|字段> [值]
    const [idRaw, keyRaw, valueRaw] = args;
    const resolved = resolveId(idRaw);
    if (resolved.error) {
      bad(resolved.error);
      say(`  可选：${PROVIDERS.map((p) => p.id).join('、')}`);
      return 1;
    }
    const id = resolved.p.id;
    const key = keyRaw.toLowerCase();
    const file = cfg.file;
    const doc = readJsonFile(file) || {};
    doc.providers = doc.providers && typeof doc.providers === 'object' ? doc.providers : {};
    doc.providers[id] = doc.providers[id] && typeof doc.providers[id] === 'object' ? doc.providers[id] : {};

    if (key === 'tier') {
      const tier = String(valueRaw || '').toLowerCase();
      if (!mod.PRESETS[tier]) {
        bad(`未知档位：${valueRaw}（可选：${Object.keys(mod.PRESETS).join('、')}）`);
        return 1;
      }
      doc.providers[id].tier = tier;
    } else if (['concurrency', 'rpm', 'minIntervalMs', 'burst', 'dailyCap'].includes(key)) {
      const n = Number(valueRaw);
      if (!Number.isFinite(n) || n < 0) {
        bad(`数值无效：${valueRaw}`);
        return 1;
      }
      doc.providers[id][key] = Math.trunc(n);
    } else if (key === 'reset') {
      delete doc.providers[id];
    } else {
      bad(`未知字段：${keyRaw}（tier / concurrency / rpm / minIntervalMs / burst / dailyCap / reset）`);
      return 1;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    ok(`已写入 ${path.basename(file)}：${id} ${key}${valueRaw ? ` ${valueRaw}` : ''}`);
    // 立刻显示生效值（含封顶）
    return cmdLimits([id], { json });
  }

  const ids = args.length
    ? resolveIds(args).ids
    : PROVIDERS.filter((p) => !p.gateway).map((p) => p.id);
  const rows = mod.describeLimits(ids, { cfg });

  if (json) {
    console.log(
      JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), tier: cfg.tier, file: cfg.file, providers: rows }, null, 2),
    );
    return 0;
  }

  say(`${C.bold}本机限额${C.reset}  ${dim(`${cfg.file} · 全局档 ${cfg.tier}`)}`);
  say('─'.repeat(92));
  say(
    `  ${padEnd('供应商', 16)} ${padEnd('档位', 10)} ${padEnd('并发', 6)} ${padEnd('每分钟', 8)} ${padEnd('最小间隔', 10)} ${padEnd('每日', 6)} 说明`,
  );
  for (const row of rows) {
    const p = PROVIDERS.find((x) => x.id === row.id);
    const cap = mod.HARD_CAPS[row.id];
    const capped = cap && Object.entries(cap).some(([k, v]) => row[k] === v && v < (mod.PRESETS[row.tier] || {})[k]);
    const note = capped ? `${C.warn}受硬约束封顶${C.reset}` : '';
    say(
      `  ${padEnd(p ? p.title : row.id, 16)} ${padEnd(row.tier, 10)} ${padEnd(String(row.concurrency), 6)} ${padEnd(String(row.rpm), 8)} ${padEnd(`${row.minIntervalMs}ms`, 10)} ${padEnd(row.dailyCap ? String(row.dailyCap) : '—', 6)} ${note}`,
    );
  }
  say('─'.repeat(92));
  const free = mod.loadLimits().free;
  say(
    dim(
      `  免费供应商（云端 key）：并发 ${free.concurrency}、${free.rpm}/分钟、间隔 ${free.minIntervalMs}ms${free.dailyCap ? `、每日 ${free.dailyCap}` : ''}`,
    ),
  );
  if (cfg.overrideHardCaps) {
    say(`  ${C.warn} 已放开上游硬约束（overrideHardCaps: true）——最宽配置，可能触发上游 429/风控${C.reset}`);
  }
  say('');
  say(dim('  改档位：node router.mjs limits raccoon max     改单项：node router.mjs limits raccoon rpm 6'));
  say(dim('  这些限额是「一个人正常用」的量级，不是上游硬上限；硬约束见 integrations/limits/limiter.js'));

  if (checkOnly) {
    const problems = [];
    for (const row of rows) {
      const cap = mod.HARD_CAPS[row.id];
      if (!cfg.overrideHardCaps && cap && cap.concurrency && row.concurrency > cap.concurrency) {
        problems.push(`${row.id} 并发 ${row.concurrency} 超过硬约束 ${cap.concurrency}`);
      }
      if (row.rpm > 600) problems.push(`${row.id} 每分钟 ${row.rpm} 次，接近「机器刷量」的形态`);
      if (row.tier !== 'max' && row.minIntervalMs === 0 && row.burst > 4) {
        problems.push(`${row.id} 无最小间隔且突发 ${row.burst}，容易被判并发异常`);
      }
    }
    say('');
    if (cfg.overrideHardCaps) {
      warn('overrideHardCaps 已开启：上游硬约束不再封顶（最宽配置，注意上游 429/风控）');
    }
    if (problems.length) {
      for (const msg of problems) warn(msg);
      return 1;
    }
    ok('限额配置没有明显问题');
  }
  return 0;
}

async function cmdClaim(raw, { json = false } = {}) {
  const dryRun = raw.includes('--dry-run');
  const planIdx = raw.indexOf('--plan');
  const only = planIdx >= 0 && planIdx + 1 < raw.length ? raw[planIdx + 1] : null;
  const ids = raw.filter(
    (a, i) =>
      !a.startsWith('--') &&
      !(planIdx >= 0 && i === planIdx + 1),
  );
  const resolved = ids.length ? resolveIds(ids) : { ids: ['zcode'] };
  if (resolved.error) {
    bad(resolved.error);
    say(`  可选：${PROVIDERS.map((p) => p.id).join('、')}`);
    return 1;
  }
  const targets = PROVIDERS.filter((p) => resolved.ids.includes(p.id));
  if (!targets.length) {
    bad('没有可领取的供应商');
    return 1;
  }

  let badCount = 0;
  const results = [];
  // --json 时把人类可读输出静音，只留最后那一段 JSON
  if (json) MUTE_OUTPUT = true;
  try {
    for (const p of targets) {
    if (p.kind !== 'zcode') {
      results.push({ id: p.id, skipped: '这家没有可领取的套餐' });
      if (!json) say(dim(`${p.title}：没有可领取的套餐，跳过`));
      continue;
    }
    if (!json) say(`${C.bold}${p.title}${C.reset}${dryRun ? '  (dry-run)' : ''}`);
    const r = await claimZcode({ dryRun, only }).catch((e) => ({ error: e.message }));
    results.push({ id: p.id, ...r });
    if (r.error) {
      badCount += 1;
      if (!json) {
        bad(`${p.title}：${r.error}`);
        if (r.hint) say(dim(`  ${r.hint}`));
      }
    } else if (r.claimed) {
      if (!json) ok(r.message);
    } else if (r.ok) {
      if (!json) say(`${r.message.includes('已生效') ? C.dim : C.ok} ${r.message}`);
    } else {
      if (!json) warn(r.message);
    }
    }
  } finally {
    MUTE_OUTPUT = false;
  }

  if (json) {
    console.log(JSON.stringify({ ok: badCount === 0, action: 'claim', results }, null, 2));
    return badCount ? 1 : 0;
  }
  return badCount ? 1 : 0;
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

  // service claim install|uninstall|status —— ZCode 限时套餐的定时领取
  // 必须在 resolveIds 之前处理：它的子命令不是供应商 id。
  if (action === 'claim' || action === 'checkin') {
    const sub = (rest[0] || 'status').toLowerCase();
    const task = 'router-zcode-claim';
    if (sub === 'status') {
      const exists = taskExists(task);
      say(`${C.bold}ZCode 定时领取${C.reset}`);
      say(`  任务名  ${task}`);
      say(
        `  状态    ${exists === null ? dim('非 Windows') : exists ? `${C.ok}已注册${C.reset}` : `${C.dim}未注册${C.reset}`}`,
      );
      if (exists) say(dim('  每 2 小时跑一次 claim zcode；已领过的活动会被上游回 1003，不会重复消耗'));
      say(dim('  安装：node router.mjs service claim install    移除：service claim uninstall'));
      return 0;
    }
    if (!WIN) {
      warn('定时任务目前只支持 Windows 计划任务');
      return 1;
    }
    if (sub === 'uninstall') {
      runSchtasks(['/Delete', '/TN', task, '/F']);
      ok(`已移除 ${task}`);
      return 0;
    }
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const wrapper = path.join(RUN_DIR, 'zcode-claim.cmd');
    const logFile = path.join(RUN_DIR, 'zcode-claim.log');
    fs.writeFileSync(
      wrapper,
      [
        '@echo off',
        'rem 由 router.mjs service claim install 生成。',
        `"${process.execPath}" "${path.join(HERE, 'router.mjs')}" claim zcode >> "${logFile}" 2>&1`,
        '',
      ].join('\r\n'),
    );
    const tr = wrapper.includes(' ') ? `"${wrapper}"` : wrapper;
    const c = runSchtasks(['/Create', '/TN', task, '/TR', tr, '/SC', 'HOURLY', '/MO', '2', '/RL', 'LIMITED', '/F']);
    if (c.status !== 0) {
      bad(`注册失败：${(c.stderr || c.stdout || '').trim().split('\n').slice(-1)[0]}`);
      return 1;
    }
    ok(`已注册 ${task}（每 2 小时领取一次）`);
    say(dim(`  日志：${logFile}`));
    return 0;
  }

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

// ---------------------------------------------------------------- Pi 侧配置

/** pi 侧由扩展直连的 provider：写进 models.json 反而会抢 OAuth / 静态表不真实。 */
const PI_EXTENSION_PROVIDERS = {
  'qoder-cn': 'pi-provider-qoder',
  qoder: 'pi-provider-qoder',
  workbuddy: 'workbuddy.ts',
  'workbuddy-global': 'workbuddy.ts',
};

/** models.json 里由 `scripts/pi-models.mjs` 维护的 provider。 */
const PI_MODELS_PROVIDERS = [
  'trae-local',
  'codearts',
  'zcode',
  'loomy',
  'raccoon',
  'qwenwork',
  'dumate',
  'lingxi',
  'lobster',
  'router-gateway',
];

function piModelCount(provider) {
  return provider && Array.isArray(provider.models) ? provider.models.length : 0;
}

function settingsHasPackage(name) {
  try {
    const settings = readJsonFile(path.join(PI_AGENT_DIR, 'settings.json')) || {};
    return (settings.packages || []).some((p) => String(p).includes(name));
  } catch {
    return false;
  }
}

/**
 * 部署 pi 的积分/签到扩展。
 *
 * 扩展源与 qodbuddy2pi 安装器用同一份 `assets/`：pi 只认目录里的 `index.ts` 作入口，
 * `quota.js` 必须与它同目录（扩展通过 createRequire 加载）。
 *
 * 默认不覆盖已存在的文件——用户可能正在改；`pi install --force` 才刷新。
 */
function installPiExtensions({ force = false, only = null } = {}) {
  const srcDir = path.join(QODBUDDY_REPO, 'assets');
  const jobs = [
    { key: 'credits', src: path.join(srcDir, 'credits.ts'), dest: path.join(PI_CREDITS_DIR, 'index.ts'), label: '积分/签到扩展（/credits）' },
    { key: 'quota', src: path.join(srcDir, 'quota.js'), dest: path.join(PI_CREDITS_DIR, 'quota.js'), label: '积分取数层（quota.js）' },
    { key: 'limits', src: path.join(INTEGRATIONS_DIR, 'token-limits2pi', 'index.ts'), dest: path.join(PI_LIMITS_DIR, 'index.ts'), label: '上下文/输出限额扩展（/limits）' },
    { key: 'workbuddy', src: path.join(srcDir, 'workbuddy.ts'), dest: path.join(PI_EXTENSIONS_DIR, 'workbuddy.ts'), label: 'WorkBuddy provider 扩展' },
  ].filter((job) => !only || only.includes(job.key));
  const rows = [];
  for (const job of jobs) {
    if (!fs.existsSync(job.src)) {
      rows.push({ ...job, ok: false, reason: `缺少 ${job.src}` });
      continue;
    }
    const exists = fs.existsSync(job.dest);
    if (exists && !force) {
      const same = fs.readFileSync(job.src, 'utf8') === fs.readFileSync(job.dest, 'utf8');
      rows.push({ ...job, ok: true, installed: false, reason: same ? '已是最新' : '已存在（--force 覆盖）' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      fs.copyFileSync(job.src, job.dest);
      rows.push({ ...job, ok: true, installed: true, reason: exists ? '已覆盖' : '已安装' });
    } catch (e) {
      rows.push({ ...job, ok: false, reason: e.message });
    }
  }
  return rows;
}

function runPiModels(args = [], { dryRun = false } = {}) {
  if (!fs.existsSync(PI_MODELS_SCRIPT)) {
    bad(`找不到 ${PI_MODELS_SCRIPT}`);
    return 1;
  }
  const argv = [...args];
  if (dryRun && !argv.includes('--dry-run')) argv.push('--dry-run');
  const r = spawnSync(process.execPath, [PI_MODELS_SCRIPT, ...argv], {
    cwd: HERE,
    stdio: 'inherit',
    windowsHide: true,
  });
  return typeof r.status === 'number' ? r.status : 1;
}

/**
 * 把开关已经关掉的本地 provider 从 pi 的 models.json 里移除。
 *
 * `scripts/pi-models.mjs` 只增改、不删；不补这一步，`router off zcode` 之后 pi 的
 * 选择器里仍留着 zcode，选中才报连不上。网关是叠加层，不跟开关走。
 */
async function prunePiProviders(enabled) {
  const stale = PI_MODELS_PROVIDERS.filter((id) => id !== 'router-gateway' && !enabled.includes(id));
  if (!stale.length) return [];
  try {
    const pisync = await import(new URL('./scripts/lib/pi-sync.mjs', import.meta.url).href);
    const r = pisync.removePiProviders(stale);
    if (r.removed.length) {
      say(dim(`已从 pi 移除关闭的 provider：${r.removed.join('、')}`));
      if (r.backup) say(dim(`  备份：${r.backup}`));
    }
    return r.removed;
  } catch {
    return [];
  }
}

function printPiStatus() {
  const cfg = readJsonFile(PI_MODELS_FILE) || { providers: {} };
  const providers = cfg.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
  say(`${C.bold}pi 配置${C.reset}  ${dim(PI_MODELS_FILE)}`);
  say('─'.repeat(78));
  say(`  ${padEnd('供应商', 18)} ${padEnd('来源', 12)} ${padEnd('模型', 8)} 状态`);

  const rows = [];
  for (const id of Object.keys(PI_EXTENSION_PROVIDERS)) {
    const ext = PI_EXTENSION_PROVIDERS[id];
    const okExt =
      ext === 'pi-provider-qoder'
        ? settingsHasPackage('pi-provider-qoder')
        : fs.existsSync(path.join(PI_EXTENSIONS_DIR, ext));
    rows.push({ id, source: '扩展', models: '—', note: okExt ? `${C.ok}${ext}${C.reset}` : `${C.bad}缺少 ${ext}${C.reset}` });
  }
  for (const id of PI_MODELS_PROVIDERS) {
    const p = providers[id];
    rows.push({
      id,
      source: 'models.json',
      models: p ? String(piModelCount(p)) : '0',
      note: p ? `${C.ok}已写入${C.reset}` : `${C.dim}未写入${C.reset}`,
    });
  }
  for (const row of rows) {
    say(`  ${padEnd(row.id, 18)} ${padEnd(row.source, 12)} ${padEnd(row.models, 8)} ${row.note}`);
  }

  const others = Object.keys(providers).filter(
    (id) => !PI_MODELS_PROVIDERS.includes(id) && !PI_EXTENSION_PROVIDERS[id],
  );
  say('─'.repeat(78));
  if (others.length) say(`${C.dim}  其它 provider（原样保留）：${others.join('、')}${C.reset}`);

  say('');
  say(`${C.bold}扩展${C.reset}`);
  const credits = path.join(PI_CREDITS_DIR, 'index.ts');
  const quotaFile = path.join(PI_CREDITS_DIR, 'quota.js');
  const wb = path.join(PI_EXTENSIONS_DIR, 'workbuddy.ts');
  const mark = (ok) => (ok ? C.ok : C.bad);
  say(`  ${mark(fs.existsSync(credits) && fs.existsSync(quotaFile))} 积分/签到 ${dim(PI_CREDITS_DIR)}（pi 里 /credits）`);
  const limits = path.join(PI_LIMITS_DIR, 'index.ts');
  say(`  ${mark(fs.existsSync(limits))} 上下文/输出限额 ${dim(PI_LIMITS_DIR)}（pi 里 /limits）`);
  say(`  ${mark(fs.existsSync(wb))} WorkBuddy ${dim(wb)}`);
  say(`  ${mark(settingsHasPackage('pi-provider-qoder'))} Qoder ${dim('pi-provider-qoder（settings.json packages）')}`);

  const stale = PI_MODELS_PROVIDERS.filter((id) => !providers[id]);
  if (stale.length) {
    say('');
    warn(`缺少 ${stale.length} 个 provider：${stale.join('、')}`);
    say(`  ${dim('补齐：node router.mjs pi sync')}`);
  }
  return 0;
}

/**
 * `router.pi ...`：pi 侧的配置入口。
 *
 * 模型表由 `scripts/pi-models.mjs` 写；扩展由本仓库的 qodbuddy2pi assets 部署。
 * 这两件事以前分散在文档里，靠人记；现在收进同一个命令，`router sync` 也会顺手刷新。
 */
async function cmdPi(raw) {
  const args = raw.filter((a) => !a.startsWith('--'));
  const sub = (args[0] || 'status').toLowerCase();
  const force = raw.includes('--force');
  const dryRun = raw.includes('--dry-run');
  const skipExt = raw.includes('--no-ext');
  // `--credits` 只动积分扩展，不碰用户可能自己改过的 workbuddy.ts；
  // `--limits` 只装 /limits 限额扩展。
  const only = raw.includes('--credits') ? ['credits', 'quota'] : raw.includes('--limits') ? ['limits'] : null;

  if (sub === 'status' || sub === 'list') return printPiStatus();

  if (sub === 'install' || sub === 'ext') {
    say(`${C.bold}安装 pi 扩展${C.reset}`);
    const rows = installPiExtensions({ force, only });
    for (const r of rows) {
      const line = `${r.label}：${r.reason}`;
      if (!r.ok) bad(line);
      else if (r.installed) ok(line);
      else say(dim(`· ${line}`));
    }
    if (!settingsHasPackage('pi-provider-qoder')) {
      warn('Qoder provider 扩展还没装进 settings.json');
      say(`  ${dim(`pi install ${path.join(QODBUDDY_REPO, 'assets', 'vendor', 'pi-provider-qoder')}`)}`);
    }
    return 0;
  }

  if (sub === 'sync' || sub === 'refresh') {
    const wanted = args.slice(1);
    const native = wanted.filter((id) => PI_EXTENSION_PROVIDERS[id]);
    const modelsWanted = wanted.filter((id) => !PI_EXTENSION_PROVIDERS[id]);
    if (native.length) {
      say(`${C.dim}· ${native.join('、')} 由 pi 扩展直连，不写 models.json；确保扩展已安装即可${C.reset}`);
    }
    if (dryRun) {
      say(dim('· --dry-run：不部署扩展，也不写 models.json'));
    } else if (!skipExt) {
      const rows = installPiExtensions({ force, only });
      for (const r of rows) {
        if (!r.ok) bad(`${r.label}：${r.reason}`);
        else if (r.installed) ok(`${r.label} ${r.reason}`);
      }
    }
    if (wanted.length && modelsWanted.length === 0) {
      printPiStatus();
      return 0;
    }
    const code = runPiModels(modelsWanted, { dryRun });
    if (code !== 0) warn('pi 模型表没有全部刷新（看上面的跳过原因）');
    // 全量 sync 才按开关清理；显式指定 id 时不擅自删别家。
    if (!wanted.length && !dryRun) await prunePiProviders(currentEnabled());
    if (!dryRun) printPiStatus();
    return 0;
  }

  usage();
  bad(`未知 pi 子命令：${sub}`);
  return 1;
}

// ---------------------------------------------------------------- 统一网关

/**
 * `router providers ...`：免费供应商（云端 API-Key + 本机免账号）的运维入口。
 *
 * 这些供应商没有进程可管，所以不进 PROVIDERS（那张表是「spawn 什么」）。
 * 它们由网关直接当作上游，配置落在 gateway/data/providers.json。
 */
async function cmdProviders(raw) {
  const { main } = await import(new URL('./gateway/cli.mjs', import.meta.url).href);
  return main(['providers', ...raw]);
}

/**
 * `router gateway ...`：统一网关的运维入口。
 *
 * 这里刻意不重复实现密钥/用量逻辑，全部转发到 `gateway/cli.mjs`（同一个进程内 import），
 * router 只负责它擅长的那部分：启停、探活、交叉校验端口、把 provider 写进 opencode。
 *
 * 为什么要有交叉校验：网关自己的 `gateway/providers.mjs` 里有一份端口表，
 * router 的 PROVIDERS 里也有一份。两边一旦漂移，症状是「请求打到旧端口 → 502」，
 * 极难查。`gateway doctor` 会把两份表逐条比。
 */
async function cmdGateway(raw) {
  const args = raw.filter((a) => !a.startsWith('--'));
  const sub = (args[0] || 'status').toLowerCase();
  const json = raw.includes('--json');
  const gw = PROVIDERS.find((p) => p.gateway);

  const loadCli = () => import(new URL('./gateway/cli.mjs', import.meta.url).href);
  const loadProviders = () => import(new URL('./gateway/providers.mjs', import.meta.url).href);

  if (sub === 'install') {
    // 把网关写成 opencode 的一个 provider：模型名带 `<provider>/` 前缀，
    // 于是客户端只改 baseURL 就能跨供应商选模型。
    // 包含本机 9 家**与**已配置的免费供应商（云端 + 本机免账号）。
    const { modelsOfAny, allUpstreamIds } = await loadProviders();
    const ids = await allUpstreamIds();
    const rows = await Promise.all(ids.map(async (id) => ({ id, models: await modelsOfAny(id, { force: true }) })));
    const entries = [];
    for (const row of rows) {
      for (const m of row.models) {
        entries.push({
          id: `${row.id}/${m.id}`,
          name: `${row.id}/${m.name || m.id}`,
          context: m.context,
          vision: m.vision,
          reasoning: m.reasoning,
        });
      }
    }
    if (!entries.length) {
      bad('一家供应商都没在跑，先 node router.mjs up');
      return 1;
    }
    const mod = requireShared('opencode-config.js');
    if (!mod) {
      bad('找不到 opencode-config.js');
      return 1;
    }
    const r = mod.mergeProviders([
      {
        id: gw.ocProvider,
        name: gw.ocName,
        baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
        apiKey: gw.ocApiKey,
        models: mod.toOpencodeModels(entries.map((e) => ({ id: e.id, name: e.name }))),
      },
    ]);
    ok(`已写入 opencode：${gw.ocProvider}（${entries.length} 个模型）`);
    if (r.backup) say(dim(`  备份：${r.backup}`));

    // pi 侧同一个 provider：一个 baseURL + `<供应商>/<模型>`，外加 combo 虚拟模型。
    // 与 `node scripts/pi-models.mjs gateway` 同一份实现（scripts/lib/pi-sync.mjs）。
    const pisync = await import(new URL('./scripts/lib/pi-sync.mjs', import.meta.url).href);
    const piProvider = await pisync.gatewayPiProvider({ entries, combos: await pisync.gatewayCombos() });
    const pi = pisync.mergePiProviders([piProvider]);
    if (pi.added.length) {
      ok(`已写入 pi：${gw.ocProvider}（${piProvider.models.length} 个模型）`);
      if (pi.backup) say(dim(`  备份：${pi.backup}`));
    } else {
      say(dim(`pi 里 ${gw.ocProvider} 已是最新（${piProvider.models.length} 个模型）`));
    }

    say(dim(`  baseURL http://127.0.0.1:${GATEWAY_PORT}/v1　模型形如 trae-local/<model> 或 openrouter/<model>`));
    say(dim(`  免费供应商另有独立 provider：node router.mjs providers install`));
    say(dim(`  不想留着：node router.mjs gateway uninstall`));
    return 0;
  }

  if (sub === 'uninstall') {
    const rem = removeProviderDirect(gw.ocProvider);
    if (rem.removed) ok(`已从 opencode 移除 ${gw.ocProvider}`);
    else if (rem.onlyInJsonc) warn(`${gw.ocProvider} 在你自己的 opencode.jsonc 里，router 不改它`);
    else say(dim('opencode 里本来就没有这个 provider'));
    const pisync = await import(new URL('./scripts/lib/pi-sync.mjs', import.meta.url).href);
    const pis = pisync.removePiProviders([gw.ocProvider]);
    if (pis.removed.length) {
      ok(`已从 pi 移除 ${gw.ocProvider}`);
      if (pis.backup) say(dim(`  备份：${pis.backup}`));
    } else {
      say(dim(`pi 里本来就没有 ${gw.ocProvider}`));
    }
    return 0;
  }

  if (sub === 'up' || sub === 'start') {
    const failed = await doUp([gw], { quiet: false });
    if (!failed) {
      const probe = await waitPort(GATEWAY_PORT, 15000);
      if (probe.up) ok(`网关已就绪：http://127.0.0.1:${GATEWAY_PORT}`);
    }
    return failed ? 1 : 0;
  }

  if (sub === 'down' || sub === 'stop') {
    const r = await doDown([gw], { quiet: false });
    return r ? 0 : 1;
  }

  if (sub === 'restart') {
    await doDown([gw], { quiet: true });
    const failed = await doUp([gw], { quiet: false });
    return failed ? 1 : 0;
  }

  if (sub === 'doctor') {
    // 先跑网关自己的自检，再补一条 router 侧的端口交叉校验
    const cli = await loadCli();
    const code = await cli.main(['doctor']);
    const { DESCRIPTORS } = await loadProviders();
    say('');
    say(`${C.bold}端口交叉校验${C.reset}${dim('（router PROVIDERS ↔ gateway DESCRIPTORS）')}`);
    let drift = 0;
    for (const d of DESCRIPTORS) {
      const p = PROVIDERS.find((x) => x.id === d.id);
      if (!p) {
        warn(`${d.id} 只在网关表里，router 没有这家`);
        drift += 1;
        continue;
      }
      if (p.port !== d.port) {
        bad(`${d.id} 端口不一致：router ${p.port} ↔ gateway ${d.port}`);
        drift += 1;
      }
    }
    for (const p of PROVIDERS) {
      if (p.gateway) continue;
      // 只接积分的来源（creditsOnly，当前没有）没有对话端点，网关本来就不该
      // 转发到它：这是有意例外，不是端口表漂移。打印一句说明，但不计入 drift。
      if (p.creditsOnly) {
        say(`${C.dim}· ${p.id} 只接积分，不进网关（预期）${C.reset}`);
        continue;
      }
      if (!DESCRIPTORS.some((d) => d.id === p.id)) {
        warn(`${p.id} 在 router 里有、网关表里没有（网关不会转发到它）`);
        drift += 1;
      }
    }
    if (!drift) ok(`${DESCRIPTORS.length} 家端口一致`);
    return code || drift ? 1 : 0;
  }

  if (sub === 'refresh-quota') {
    const cli = await loadCli();
    return cli.main(['refresh-quota']);
  }

  // 其余子命令原样交给 gateway/cli.mjs
  const cli = await loadCli();
  return cli.main([sub, ...raw.slice(raw.indexOf(sub) + 1)]);
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

  // 本机限额：读不到 limits.json 不算故障（有内置默认档），但要说明当前生效值，
  // 否则「以为在限流其实没生效」是最难查的一类问题。
  let limitsById = new Map();
  try {
    const mod = loadLimiterModule();
    const cfg = mod.loadLimits();
    limitsById = new Map(mod.describeLimits(PROVIDERS.map((p) => p.id), { cfg }).map((r) => [r.id, r]));
    if (fs.existsSync(cfg.file)) say(`  ${C.ok} 本机限额 ${cfg.file}（全局档 ${cfg.tier}）`);
    else say(`  ${C.warn} 没有 limits.json，用内置默认档（全局 ${cfg.tier}）`);
  } catch (e) {
    say(`  ${C.warn} 限流模块不可用：${e.message}`);
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
    if (p.kind === 'loomy') {
      checks.push(readLoomySession() ? `${C.ok} 已登录` : `${C.warn} 未登录（${loomyAuthFile()}）`);
    }
    if (p.kind === 'raccoon') {
      checks.push(readRaccoonSession() ? `${C.ok} 已登录` : `${C.warn} 未登录（${raccoonAuthFile()}）`);
    }
    if (p.kind === 'qwenwork') {
      const cred = qwenworkCredential();
      checks.push(
        cred && cred.pending
          ? `${C.ok} 已登录（推理凭据由反代自动签发）`
          : cred
            ? `${C.ok} 已登录（凭据 ${cred.alive}/${cred.count} 有效）`
            : `${C.warn} 未登录（打开千问办公桌面端登录）`,
      );
    }
    if (p.kind === 'dumate') {
      const profile = readDumateProfile();
      checks.push(
        profile
          ? `${C.ok} 已登录（${profile.name || shortUser(profile.accountId)}）`
          : `${C.warn} 未登录（打开百度搭子桌面端登录）`,
      );
    }
    if (p.kind === 'lingxi') {
      checks.push(
        lingxiInstalled()
          ? `${C.ok} 桌面端已安装（登录态由反代读 cookie 库）`
          : `${C.warn} 未安装 WPS 灵犀桌面端`,
      );
      checks.push(`${C.dim}对话可用（agent 形态，不吐 tool_calls）${C.reset}`);
    }
    if (p.kind === 'lobster') {
      const session = readLobsterSession();
      checks.push(
        lobsterInstalled()
          ? `${C.ok} 桌面端已安装`
          : `${C.warn} 未安装有道龙虾桌面端`,
      );
      checks.push(
        session
          ? `${C.ok} 已登录（${session.nickname || shortUser(session.userId)}）`
          : `${C.warn} 未登录（打开 LobsterAI 桌面端登录）`,
      );
      checks.push(`${C.dim}桌面端代理在线时复用其刷新与用量${C.reset}`);
    }
    // 本机限额：这一家的并发/速率闸门，避免「以为在限流其实没生效」
    // 网关是叠加层（不直连上游），限额对它的「免费供应商」分支才有意义
    const limRow = p.gateway ? null : limitsById.get(p.id);
    if (limRow) {
      checks.push(
        `${C.dim}限流 ${limRow.tier} ${limRow.concurrency}路/${limRow.rpm}rpm${C.reset}`,
      );
    }
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

  // pi 侧的三个落点：models.json（模型）、extensions（provider / 积分）、
  // settings.json（npm 包形式的 Qoder provider）。缺哪一块都只影响 pi，不影响反代。
  say('');
  say(`${C.bold}pi 侧${C.reset}`);
  const piCfg = readJsonFile(PI_MODELS_FILE);
  const piProviders = piCfg && piCfg.providers && typeof piCfg.providers === 'object' ? piCfg.providers : {};
  const piCount = Object.keys(piProviders).length;
  if (fs.existsSync(PI_MODELS_FILE)) say(`  ${C.ok} ${PI_MODELS_FILE}（${piCount} 个 provider）`);
  else warn(`pi 还没有模型表：${PI_MODELS_FILE}（node router.mjs pi sync）`);
  const creditsExt = fs.existsSync(path.join(PI_CREDITS_DIR, 'index.ts')) && fs.existsSync(path.join(PI_CREDITS_DIR, 'quota.js'));
  say(`  ${creditsExt ? C.ok : C.warn} 积分/签到扩展${creditsExt ? '' : '（node router.mjs pi install）'}`);
  const limitsExt = fs.existsSync(path.join(PI_LIMITS_DIR, 'index.ts'));
  say(`  ${limitsExt ? C.ok : C.warn} 上下文/输出限额扩展${limitsExt ? '' : '（node router.mjs pi install）'}`);
  const wbExt = fs.existsSync(path.join(PI_EXTENSIONS_DIR, 'workbuddy.ts'));
  say(`  ${wbExt ? C.ok : C.warn} WorkBuddy 扩展${wbExt ? '' : '（node router.mjs pi install）'}`);
  const qoderExt = settingsHasPackage('pi-provider-qoder');
  say(`  ${qoderExt ? C.ok : C.warn} Qoder provider${qoderExt ? '' : `（pi install ${path.join(QODBUDDY_REPO, 'assets', 'vendor', 'pi-provider-qoder')}）`}`);

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
  node router.mjs account [id] [账号]     查看 / 切换账号（WorkBuddy、CodeArts、Trae、ZCode）
  node router.mjs account add <id>        浏览器登录并往账号池里添加一个账号
  node router.mjs account remove <id> <账号>  从账号池删除账号（先归档，可 restore）
  node router.mjs account restore <id>    恢复被删账号（从 retired-* 归档捡回）
  node router.mjs account check [id...]   只看有问题的账号：需重登 / 快过期 / 积分为 0
  node router.mjs account merge codearts  合并同一账号的重复记录（按套餐用量指纹识别）
  node router.mjs claim [id...]           领取限时套餐（ZCode 周末/夜间 Token 包）
  node router.mjs service claim install   注册定时领取（Windows 计划任务，每 2 小时）
  node router.mjs account <id> --all      恢复该家的账号池为全部启用
  node router.mjs account <id> <账号> --dry-run   只预览切换结果，不写文件不重启
  node router.mjs up [id...] [--all] [--login]   按当前开关启动；--all 先全开再启动
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
  node router.mjs sync                   同步 opencode 与 pi 配置（--no-pi 只同步 opencode）
  node router.mjs models [id...]         按上游 /v1/models 刷新 opencode 与 pi 的模型清单
  node router.mjs pi                     看 pi 的 provider 与扩展状态
  node router.mjs pi sync [id...]        刷新 pi 模型表并安装积分/限额扩展
  node router.mjs pi install [--force]   只部署 pi 扩展（--credits 只装积分/签到，--limits 只装限额）
  node router.mjs pi status              同 pi
  node router.mjs gateway up              启动统一网关（单端口 + 双协议 + 跨供应商转移）
  node router.mjs gateway status          网关调度快照：权重、冷却、并发、粘性
  node router.mjs gateway install         把网关写成 opencode + pi 的一个 provider
  node router.mjs gateway key add --name dev --providers trae-local,zcode
  node router.mjs gateway usage [--days 7]   用量聚合（网关没跑也能读本地记录）
  node router.mjs gateway balance         各家额度汇总
  node router.mjs gateway doctor          网关自检 + 端口交叉校验
  node router.mjs gateway refresh-quota   采集额度写快照（影响调度权重）
  node router.mjs providers list          看 18 家免费供应商（3 家本机 + 15 家有免费额度）
  node router.mjs providers key <id> <key>   配置某家的 API key（加密落盘）
  node router.mjs providers test [id...]  探活：拉一次模型列表验证 key
  node router.mjs providers install       把可用的写成 opencode + pi provider
  node router.mjs limits                 看本机限额（并发/速率/每日上限）
  node router.mjs limits raccoon max     改档位（写 limits.json）
  node router.mjs limits raccoon rpm 6   改单项
  node router.mjs limits --check         体检限额配置
  node router.mjs limits --apply         把限额下发给自带限流器的反代（CodeArts）
  node router.mjs service [status]       看登录自启状态
  node router.mjs service install [id...]    注册登录自启（Windows 计划任务）
  node router.mjs service uninstall [id...]  停止并移除登录自启
  node router.mjs sync-homes [--status]  双系统账号/配置同步（每次 router 运行也会自动跑）
  node router.mjs doctor                 自检（命令、文件、端口、opencode）

供应商 id：
${PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.title}${p.control === 'spawn' ? dim(' （router 直接托管）') : ''}`).join('\n')}

例：
  node router.mjs account                        列出所有账号与当前生效
  node router.mjs account check                  只列出需要处理的账号
  node router.mjs account add workbuddy          浏览器登录，往 WorkBuddy 账号池加一个账号
  node router.mjs account remove workbuddy c     删除 WorkBuddy 的 slot c（先归档）
  node router.mjs account restore workbuddy      把刚删掉的账号捡回来
  node router.mjs account workbuddy              只看 WorkBuddy 国内版账号
  node router.mjs account workbuddy b            切到 WorkBuddy slot b
  node router.mjs account codearts GT-demo    只启用 CodeArts 的 GT-demo
  node router.mjs account trae-local --all       恢复 Trae 全部账号参与调度
  node router.mjs on qoder-cn                    只开 Qoder 国内版
  node router.mjs login qoder                    打开浏览器登录 Qoder 国际版
  node router.mjs up trae-local codearts          只启动 Trae 和 CodeArts，不改开关
  node router.mjs logs trae-local 80              看 Trae 日志尾部
  node router.mjs restart workbuddy-global        重启 WorkBuddy 国际版
  node router.mjs none                            全部关掉（省内存）
  node router.mjs service install trae-local      让 Trae 登录时自动启动
  node router.mjs gateway up                       启动统一网关（:${GATEWAY_PORT}）
  node router.mjs gateway key add --name dev --providers trae-local
  node router.mjs gateway install                  让 opencode 与 pi 用 router-gateway/<供应商>/<模型>
  node router.mjs providers list                   免费供应商：3 家本机 + 15 家有免费额度
  node router.mjs providers key openrouter sk-or-...   配 key（加密落盘，不写进 config.json）
  node router.mjs providers install                把可用的写成独立 opencode + pi provider

状态文件：${STATE_FILE}
运行记录：${PROCESS_FILE}
网关数据：${path.join(GATEWAY_DIR, 'data')}（密钥只存 SHA-256，用量按天分片）`);
}

// ---------------------------------------------------------------- 入口

/** 显式记录 WorkBuddy 当前账号，供共享库同步使用。 */
async function markActiveWorkbuddy(region, uid) {
  try {
    const { setActiveWorkbuddy } = await import(new URL('./scripts/sync-homes.mjs', import.meta.url).href);
    setActiveWorkbuddy(region, uid);
  } catch {}
}

/** 双系统共享账号/配置。失败只记一条提示，绝不影响 router 主流程。 */
let syncHomesFn = null;
let autoSyncDisabled = false;
async function autoSyncHomes() {
  if (autoSyncDisabled) return;
  try {
    if (!syncHomesFn) {
      ({ syncHomes: syncHomesFn } = await import(new URL('./scripts/sync-homes.mjs', import.meta.url).href));
    }
    await syncHomesFn({ quiet: true });
  } catch {}
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'list').toLowerCase();
  const raw = argv.slice(1);

  // --status 只看不写；其它命令在启动前先把两套系统的账号与配置对齐。
  if (cmd === 'sync-homes' && raw.includes('--status')) autoSyncDisabled = true;
  await autoSyncHomes();
  const quiet = raw.includes('--quiet');
  const json = raw.includes('--json');
  const keepOc = raw.includes('--keep-oc');
  // `up --all` 是常见写法；以前 --all 会被当成未知 flag 丢掉，开关为空时
  // 看起来像「什么都没发生」。这里让它等价于 `all`：先全开再启动。
  const allFlag = raw.includes('--all');
  const args = raw.filter((a) => !a.startsWith('--'));
  // 交互式终端里，启动时发现缺凭证就打开浏览器；计划任务/管道里只提示，避免卡住。
  const autoLogin =
    !raw.includes('--no-login') && (raw.includes('--login') || (process.stdin.isTTY && process.stdout.isTTY));

  if (cmd === 'sync-homes' || cmd === 'homes') {
    const { syncHomes, printStatus } = await import(new URL('./scripts/sync-homes.mjs', import.meta.url).href);
    if (raw.includes('--status')) {
      autoSyncDisabled = true;
      printStatus();
      return 0;
    }
    const hi = raw.indexOf('--homes');
    const homes = hi >= 0 && raw[hi + 1] ? raw[hi + 1].split(';').map((s) => s.trim()).filter(Boolean) : null;
    const result = await syncHomes({ homes, quiet: false });
    if (result.skipped) {
      say(result.reason);
      say(dim(`示例：node router.mjs sync-homes --homes "C:\\Users\\Administrator;D:\\Users\\demo"`));
    }
    return 0;
  }

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

  const upAll = (cmd === 'up' || cmd === 'start') && allFlag;
  if (cmd === 'all' || cmd === 'none' || upAll) {
    if (upAll && args.length) {
      bad('--all 不能同时指定供应商');
      say(dim(`  要么 node router.mjs up --all，要么 node router.mjs up ${args.join(' ')}`));
      return 1;
    }
    const turningOn = cmd !== 'none';
    const saved = writeState(turningOn ? PROVIDERS.map((p) => p.id) : []);
    ok(turningOn ? '已全部开启' : '已全部关闭');
    if (turningOn) {
      await doUp(PROVIDERS);
      await ensureLogins(PROVIDERS, { auto: autoLogin });
    } else {
      await doDown(PROVIDERS);
    }
    await doSyncOpenCode(saved, { startIds: turningOn ? saved : [] });
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
    // pi 侧同一份开关：opencode 与 pi 一起刷新，才不会一边有模型、一边还是旧快照。
    // `--no-pi` 保留原来的「只同步 opencode」语义。
    if (!raw.includes('--no-pi')) {
      say('');
      say(`${C.bold}pi 模型表${C.reset}  ${dim(PI_MODELS_FILE)}`);
      const code = runPiModels([]);
      if (code !== 0) warn('pi 模型表没有全部刷新（看上面的跳过原因）');
      await prunePiProviders(currentEnabled());
    }
    return 0;
  }

  if (cmd === 'models' || cmd === 'refresh-models') {
    const resolved = args.length ? resolveIds(args) : { ids: currentEnabled() };
    if (resolved.error) {
      bad(resolved.error);
      return 1;
    }
    say(`${C.bold}刷新模型${C.reset}  从各家 /v1/models 拉最新目录写回 opencode`);
    const rows = await doRefreshModels(resolved.ids);
    for (const r of rows) {
      if (!r.ok) {
        warn(`${r.p.title} 跳过：${r.reason}`);
        continue;
      }
      if (r.skipped) {
        say(`${C.dim}· ${r.p.title} ${r.reason}${C.reset}`);
        continue;
      }
      const detail = r.before === undefined || r.before === null ? '' : r.before === r.models ? `（未变，${r.models} 个）` : `（${r.before} → ${r.models} 个）`;
      ok(`${r.p.title} ${r.models} 个模型${detail}`);
    }
    const failed = rows.filter((r) => !r.ok).length;
    if (failed) say(dim(`\n${failed} 家没刷新；其余已写入，原配置已备份`));
    // pi 的模型表也一起拉，避免「opencode 刷新了、pi 还是旧目录」。
    if (!raw.includes('--no-pi')) {
      say('');
      say(`${C.bold}pi 模型表${C.reset}  ${dim(PI_MODELS_FILE)}`);
      const code = runPiModels([]);
      if (code !== 0) warn('pi 模型表没有全部刷新（看上面的跳过原因）');
    }
    return failed ? 1 : 0;
  }

  if (cmd === 'account' || cmd === 'accounts' || cmd === 'acct') return cmdAccount(raw, { json });
  if (cmd === 'pi') return cmdPi(raw);
  if (cmd === 'gateway' || cmd === 'gw') return cmdGateway(raw);
  if (cmd === 'providers' || cmd === 'provider') return cmdProviders(raw);
  if (cmd === 'claim' || cmd === 'checkin') return cmdClaim(raw, { json });
  if (cmd === 'limits' || cmd === 'limit') return cmdLimits(raw, { json });
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
  .then(async (code) => {
    // 命令可能刚改了登录态/账号/opencode 配置，退出前再对齐一次。
    await autoSyncHomes();
    process.exit(code || 0);
  })
  .catch(async (e) => {
    console.error(e);
    await autoSyncHomes();
    process.exit(1);
  });

