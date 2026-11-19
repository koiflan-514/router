#!/usr/bin/env node
/**
 * qwenwork-proxy.js — 把千问办公（QwenWork CN）的订阅额度暴露成本机 OpenAI 兼容端点。
 *
 * ## 为什么这个代理的「凭证层」与别家不同
 *
 * 千问办公桌面端（Electron）**不把 token 明文落盘**：
 *
 *   auth-v2.dat         宿主登录态，Electron safeStorage 加密
 *                         Windows  DPAPI（`Local State` → os_crypt.encrypted_key）
 *                         Linux    GNOME Keyring / KWallet 里的 safeStorage 密码
 *                         macOS    Keychain 里的 safeStorage 密码
 *   engine-maas-key.dat MaaS 推理 key，Chromium OSCrypt(`v1x`) 加密，仅 Windows 侧有
 *
 * 这些密钥都绑定**同一台机器的同一用户**，桌面端自己也正是这么读的。所以这里不伪造
 * 设备身份、不复刻登录流程，只做「以同一用户身份读同一份落盘凭据」。
 *
 * 凭证层在 `credentials.js`，与 router 共用：
 *
 *   1. 读 `auth-v2.dat` 拿到宿主 token（有效期约 7 天）；
 *   2. `POST {gateway}/api/desktop-sessions` 换一把 MaaS 推理 key（2 小时）；
 *   3. 缓存到 `~/.cache/qwenwork2api/maas-key.json`（0600），
 *      离到期不足 30 分钟就自动重签。
 *
 * 这样 Linux/macOS 上不需要等桌面端写 `engine-maas-key.dat`，也不依赖桌面端一直开着。
 * Windows 上如果桌面端已经写出 `engine-maas-key.dat`，仍会作为回退路径读取。
 *
 * 额度走宿主 token：`/adapter/user/wallets` + `/adapter/user/account-context`，
 * 能读到月度/长期/每日分账；读不到时明确说明原因，不编数字。
 *
 * ## 端点
 *
 *   GET  /health                进程、凭据来源、到期时间（不输出 key）
 *   GET  /v1/models             模型清单（来自桌面端缓存目录或内置表）
 *   GET  /v1/quota              余额（宿主 token）+ 逐模型倍率
 *   POST /v1/chat/completions   OpenAI 方言
 *   POST /v1/messages           Anthropic 方言（上游原生支持，少一层转换）
 *   *    /v1/*                 其余路径原样透传
 *
 * 零依赖，只用 node: 内建模块。
 *
 * 用法：
 *   node qwenwork-proxy.js                 # 127.0.0.1:8794
 *   node qwenwork-proxy.js --port 8794
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const credentials = require('./credentials.js');

const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8794;
/** 上游推理网关的默认地址（凭据里通常也会带 baseUrl，带了就以它为准）。 */
const DEFAULT_BASE = 'https://api9.qwenwork.cn/v1';
/** 桌面端的用户数据目录（Electron appData）。可以用 QWENWORK_DATA_DIR 覆盖。 */
const DATA_DIR =
  String(process.env.QWENWORK_DATA_DIR || '').trim() ||
  (process.platform === 'win32'
    ? path.join(HOME, 'AppData', 'Roaming', 'QwenWorkCN')
    : process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'QwenWorkCN')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'QwenWorkCN'));
/** `.qwenworkcn` 是 CLI/harness 的家；engine-maas-key.dat 也在这一层。 */
const AGENT_HOME =
  String(process.env.QWENWORK_HOME || '').trim() || path.join(HOME, '.qwenworkcn');

const CACHE_TTL_MS = Number(process.env.QWENWORK_CACHE_MS || 60_000);
const SHORT_TIMEOUT_MS = Number(process.env.QWENWORK_SHORT_TIMEOUT_MS || 20_000);
const CHAT_TIMEOUT_MS = Number(process.env.QWENWORK_CHAT_TIMEOUT_MS || 1_200_000);
const MAX_BODY_BYTES = Number(process.env.QWENWORK_MAX_BODY || 64 * 1024 * 1024);
/** 续期提前量：剩余不足这个时长就 exchange 一把新的。 */
const REFRESH_AHEAD_MS = Number(process.env.QWENWORK_REFRESH_AHEAD_MS || 30 * 60_000);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.QWENWORK_PORT || DEFAULT_PORT);
const HOST = String(process.env.QWENWORK_HOST || '127.0.0.1');

// 本地限流：与网关共用 limits.json 的档位（见 integrations/limits/limiter.js）。
let createLimiterFor = null;
let LimiterBusy = null;
try {
  ({ createLimiterFor, LimiterBusy } = require('../limits/limiter.js'));
} catch {}
const LIMITER =
  createLimiterFor && String(process.env.QWENWORK_LIMITS || '').toLowerCase() !== 'off'
    ? createLimiterFor('qwenwork')
    : null;

// ---------------------------------------------------------------- 输出

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

function maskKey(key) {
  const s = String(key || '');
  if (s.length < 16) return s ? '***' : '';
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

// ---------------------------------------------------------------- 凭据：MaaS key

/**
 * Chromium OSCrypt（`v10` 前缀）解密。
 *
 * 布局：`v10` + 12 字节 nonce + 密文 + 16 字节 GCM tag。
 * 主密钥在 `Local State` 的 `os_crypt.encrypted_key`（base64，去掉 `DPAPI` 前缀后
 * 是 DPAPI 保护的 blob）。
 *
 * Windows 上 DPAPI 只能在**同一用户的登录会话**里解开，所以这里用 PowerShell 调
 * `ProtectedData.Unprotect`。这是本机、本用户、只读操作，不涉及提权。
 */
function readMasterKey(dataDir) {
  const localStateFile = path.join(dataDir, 'Local State');
  const state = readJson(localStateFile);
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (typeof b64 !== 'string' || !b64) return null;

  let blob = Buffer.from(b64, 'base64');
  // Chromium 在 DPAPI 保护的 blob 前加 5 字节 "DPAPI"
  if (blob.subarray(0, 5).toString('latin1') === 'DPAPI') blob = blob.subarray(5);

  if (process.platform !== 'win32') return null;
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${blob.toString('base64')}')`,
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const key = Buffer.from(String(r.stdout || '').trim(), 'base64');
  return key.length === 32 ? key : null;
}

/** 解 OSCrypt `v10` 密文 → utf8 明文；失败返回 null。 */
function oscryptDecrypt(buf, key) {
  if (!buf || buf.length < 3 + 12 + 16) return null;
  if (buf.subarray(0, 3).toString('latin1') !== 'v10') return null;
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(15, buf.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 读 `engine-maas-key.dat` → 选一条可用凭据。
 *
 * 文件里可能有多条（每个 session 一条）。选「未过期里最晚到期」的那条：它通常就是
 * 当前主会话的 key，且最不需要立刻续期。
 */
function readMaasCredential() {
  // Linux/macOS：桌面端的 auth-v2.dat 由 safeStorage 加密，代理直接读宿主登录态
  // 签一把新 key，缓存在 ~/.cache/qwenwork2api/maas-key.json。先看缓存。
  const cached = credentials.readCachedKey();
  if (cached) {
    const now = Date.now();
    return {
      ...cached,
      baseUrl: cached.baseUrl || DEFAULT_BASE,
      source: cached.source,
      expired: Boolean(cached.expiresAtMs && cached.expiresAtMs <= now),
    };
  }

  const file = path.join(AGENT_HOME, 'engine-maas-key.dat');
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { error: `找不到 ${file}（先在千问办公桌面端登录并随便问一句）` };
  }
  const key = readMasterKey(DATA_DIR);
  if (!key) {
    return { error: `解不开 ${path.basename(file)}：读不到 DPAPI 主密钥（Local State）` };
  }
  const text = oscryptDecrypt(buf, key);
  if (!text) return { error: `${path.basename(file)} 解密失败（换用户或换机器后需要重新登录桌面端）` };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: `${path.basename(file)} 内容不是合法 JSON` };
  }
  const creds = doc && doc.credentials && typeof doc.credentials === 'object' ? doc.credentials : {};
  const now = Date.now();
  const rows = Object.entries(creds)
    .map(([id, c]) => ({
      sessionId: id,
      accessKey: c && typeof c.accessKey === 'string' ? c.accessKey : '',
      expiresAtMs: Number(c && c.expiresAtMs) || 0,
      ttlMs: Number(c && c.ttlMs) || 0,
      baseUrl: typeof (c && c.baseUrl) === 'string' ? c.baseUrl.replace(/\/+$/, '') : '',
    }))
    .filter((c) => c.accessKey);

  if (!rows.length) return { error: `${path.basename(file)} 里没有可用的 accessKey` };

  const alive = rows.filter((c) => !c.expiresAtMs || c.expiresAtMs > now);
  const pick = (alive.length ? alive : rows).sort((a, b) => (b.expiresAtMs || 0) - (a.expiresAtMs || 0))[0];
  return {
    ...pick,
    baseUrl: pick.baseUrl || DEFAULT_BASE,
    source: 'engine-maas-key.dat',
    // 用来判断「读到的 key 是不是已经过期、需要 exchange」
    expired: Boolean(pick.expiresAtMs && pick.expiresAtMs <= now),
    file,
  };
}

/**
 * 进程内凭据状态。桌面端会自己轮换 key，所以磁盘上的可能比内存里的新——
 * 每次续期前先比一下 `expiresAtMs`，谁新用谁。
 */
const credential = {
  accessKey: '',
  expiresAtMs: 0,
  baseUrl: '',
  sessionId: '',
  source: '',
  fromDiskAt: 0,
  lastError: '',
  lastRefreshedAt: 0,
  refreshes: 0,
};

function adopt(cred, reason) {
  if (!cred) return false;
  credential.accessKey = cred.accessKey;
  credential.expiresAtMs = cred.expiresAtMs || 0;
  credential.baseUrl = cred.baseUrl || credential.baseUrl || DEFAULT_BASE;
  credential.sessionId = cred.sessionId || credential.sessionId;
  credential.source = cred.source || credential.source;
  credential.fromDiskAt = Date.now();
  if (reason) credential.lastRefreshedAt = Date.now();
  return true;
}

/** 拿当前可用的 key：内存里还有效就用内存，否则重读磁盘。 */
function currentCredential({ force = false } = {}) {
  const now = Date.now();
  const fresh = !force && credential.accessKey && (!credential.expiresAtMs || credential.expiresAtMs - now > REFRESH_AHEAD_MS);
  if (fresh) return { ok: true, ...credential };
  const disk = readMaasCredential();
  if (disk.error) {
    credential.lastError = disk.error;
    if (credential.accessKey && (!credential.expiresAtMs || credential.expiresAtMs > now)) {
      return { ok: true, ...credential, stale: true };
    }
    return { ok: false, error: disk.error };
  }
  // 磁盘上的比内存里的新才采纳（桌面端可能刚轮换过）
  if (!credential.accessKey || (disk.expiresAtMs || 0) >= (credential.expiresAtMs || 0) || force) {
    adopt(disk);
    // 桌面端刚签了一把有效 key：之前「已过期、无法自续」的错误就作废了。
    // 只有新 key 仍然过期时才保留提示。
    if (!credential.expiresAtMs || credential.expiresAtMs > now) credential.lastError = '';
  }
  // 不要把 lastError 无条件洗掉：读盘成功不等于续期成功。
  // （以前这里每次读盘都清空，导致 /health 永远看不到真因。）
  return { ok: true, ...credential };
}

/**
 * 异步确保凭据可用。
 *
 * Windows 优先用桌面端写出的 `engine-maas-key.dat`；Linux/macOS 的桌面端不落明文，
 * 这里读 `auth-v2.dat` 的宿主 token，调 `/api/desktop-sessions` 签一把新 key 并缓存。
 * 缓存快到期时也会自动重签，所以不再依赖桌面端一直开着。
 */
async function ensureCredential({ force = false } = {}) {
  const cur = currentCredential({ force });
  const now = Date.now();
  if (!force && cur.ok && (!cur.expiresAtMs || cur.expiresAtMs - now > REFRESH_AHEAD_MS)) return cur;

  const minted = await credentials.ensureAccessKey({ force });
  if (minted.ok) {
    adopt(minted);
    credential.lastError = '';
    return { ok: true, ...credential };
  }
  credential.lastError = minted.error;
  if (cur.ok && (!cur.expiresAtMs || cur.expiresAtMs > now)) return { ...cur, stale: true };
  return { ok: false, error: minted.error };
}

/**
 * 用 exchange 把短 key 换成长 key。上游给的是 `{access_token, expires_at}`。
 *
 * 为什么需要：桌面端签的 key 只有 2 小时。代理要能独立长时间运行，就得自己续。
 * exchange 只需要当前 key 有效，成功后再用新 key 继续续期，形成自持循环。
 */
async function exchangeCredential() {
  const cur = currentCredential();
  if (!cur.ok) return { ok: false, error: cur.error };
  const base = (cur.baseUrl || DEFAULT_BASE).replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = `${base}/v1/access-tokens/exchange`;
  const ttlMs = Math.max(60_000, Number(process.env.QWENWORK_EXCHANGE_TTL_MS || 7_200_000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cur.accessKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ttl_ms: ttlMs }),
      signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      // 过期之后 exchange 不再是「续期」而是「用死掉的 key 换新 key」：上游一律 401。
      // 这个区分很重要——不写清楚的话，日志里只有一行 401，看起来像代理坏了。
      const expiredAt = cur.expiresAtMs && cur.expiresAtMs <= Date.now() ? cur.expiresAtMs : 0;
      credential.lastError = expiredAt
        ? `凭据已于 ${new Date(expiredAt).toISOString()} 过期，而 exchange 需要一把有效凭据才能换新，因此无法自续（HTTP ${res.status}）。请打开千问办公桌面端在对话里发一句话重新签发，或 node router.mjs login qwenwork`
        : `exchange 返回 HTTP ${res.status}：${(json && (json.error?.message || json.message)) || text.slice(0, 120)}`;
      return { ok: false, error: credential.lastError };
    }
    const token = json && typeof json.access_token === 'string' ? json.access_token : '';
    const expiresAt = json && Number(json.expires_at) ? Number(json.expires_at) : 0;
    if (!token) {
      credential.lastError = 'exchange 没有返回 access_token';
      return { ok: false, error: credential.lastError };
    }
    credential.accessKey = token;
    credential.expiresAtMs = expiresAt;
    credential.refreshes += 1;
    credential.lastRefreshedAt = Date.now();
    credential.lastError = '';
    log(
      `凭据已续期（第 ${credential.refreshes} 次）：${maskKey(token)}，到期 ${expiresAt ? new Date(expiresAt).toISOString() : '未知'}`,
    );
    return { ok: true, expiresAtMs: expiresAt };
  } catch (err) {
    credential.lastError = `exchange 失败：${err.message}`;
    return { ok: false, error: credential.lastError };
  }
}

/**
 * 后台续期：每 10 分钟检查一次，剩余不足 REFRESH_AHEAD_MS（30 分钟）就换。
 *
 * 为什么间隔要比提前量小很多：间隔 = 提前量时，最坏情况是「只剩几分钟才检查到」，
 * 一次 exchange 慢一点或定时器被系统节流就变成过期，而过期了就再也续不了。
 */
function startRefreshLoop() {
  const tick = async () => {
    // ensureCredential 会在临近到期时用宿主登录态重签（Linux/macOS 的新路径）。
    const cur = await ensureCredential();
    if (!cur.ok) return;
    const left = cur.expiresAtMs ? cur.expiresAtMs - Date.now() : Infinity;
    if (left > REFRESH_AHEAD_MS) return;
    const r = await exchangeCredential();
    if (!r.ok) {
      // exchange 失败时再试一次重签：宿主 token 通常比推理 key 长寿。
      const minted = await ensureCredential({ force: true });
      if (!minted.ok) log(`凭据续期失败：${r.error}`);
    }
  };
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, 10 * 60_000);
  timer.unref?.();
  tick().catch(() => {});
}

// ---------------------------------------------------------------- 模型目录

/**
 * 模型清单的权威来源有两个，都要试：
 *
 *   1. `%APPDATA%/QwenWorkCN/data/model-catalog/chat-modes-v2/*.lkg`
 *      桌面端缓存，但**是 base64 密文**（`UU1D…`），解不开；
 *   2. `%APPDATA%/QwenWorkCN/logs/<日期>/main.log`
 *      桌面端每次拉到目录都会把整个 `responseBody` 打进日志，**是明文**。
 *
 * 所以真正可用的是日志。两者都拿不到时才用内置表，并在 `/health` 里说明来源，
 * 免得「看起来有 13 个模型」却不知道是不是过期数据。
 */
function catalogDirs(dir) {
  const out = [];
  // 缓存目录（可能将来变成明文，先试着解）
  out.push({
    kind: 'cache',
    dir: path.join(dir, 'data', 'model-catalog', 'chat-modes-v2'),
  });
  // 日志目录：logs/<yyyymmddHHMM>/main.log，按目录名倒序取最新
  const logsRoot = path.join(dir, 'logs');
  try {
    const names = fs
      .readdirSync(logsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{8,}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const name of names.slice(0, 5)) {
      const file = path.join(logsRoot, name, 'main.log');
      if (fs.existsSync(file)) out.push({ kind: 'log', file });
    }
  } catch {}
  return out;
}

/** 从一行日志里取出 `"responseBody":{...}` 的 JSON 对象。 */
function parseCatalogLine(line) {
  const marker = '"responseBody":';
  const at = line.indexOf(marker);
  if (at < 0) return null;
  const tail = line.slice(at + marker.length).trimEnd();
  // 日志末尾可能带别的字段或行尾噪声：从第一个 { 开始做括号配平，取完整对象
  const start = tail.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(tail.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 从日志里找**最后一条**完整的 catalog。 */
function catalogFromLogs() {
  for (const src of catalogDirs(DATA_DIR)) {
    if (src.kind !== 'log') continue;
    let text;
    try {
      // main.log 可能几十 MB；从尾部读，catalog 出现在会话期间
      const stat = fs.statSync(src.file);
      const size = Math.min(stat.size, 8 * 1024 * 1024);
      const fd = fs.openSync(src.file, 'r');
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, stat.size - size);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('catalog fetched') && !line.includes('"catalog"')) continue;
      const doc = parseCatalogLine(line);
      const list = doc && (Array.isArray(doc.catalog) ? doc.catalog : doc.data && doc.data.catalog);
      if (Array.isArray(list) && list.length) return { list, file: src.file };
    }
  }
  return null;
}

function catalogFromFile() {
  for (const src of catalogDirs(DATA_DIR)) {
    if (src.kind !== 'cache') continue;
    let names = [];
    try {
      names = fs.readdirSync(src.dir).filter((f) => /\.(lkg|json)$/i.test(f));
    } catch {
      continue;
    }
    let best = null;
    for (const name of names) {
      const file = path.join(src.dir, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {}
    }
    if (!best) continue;
    const doc = readJson(best.file);
    const list = doc && (Array.isArray(doc.catalog) ? doc.catalog : doc.data && doc.data.catalog);
    if (Array.isArray(list) && list.length) return { list, file: best.file };
  }
  return null;
}
const CATALOG_INLINE = [
  // 文件与日志都读不到时的兜底（2026-11 实测，全部 chat/completions 可用）
  ['flash', '标准', 0.1, 1_000_000, true, true, '极速全能，秒杀日常任务'],
  ['pro', '高级', 1, 1_000_000, true, false, '性能均衡，擅长复杂任务'],
  ['qwen4-max', 'Qwen4-Max', 0.4, 1_000_000, true, true, '强大出众，适合大型任务'],
  ['qwen3.8-max-preview', 'Qwen3.8-Max', 1.8, 1_000_000, true, true, '全维旗舰，驾驭高难任务'],
  ['qwen3.8-flash', 'Qwen3.8-Flash', 0.1, 1_000_000, true, true, '轻量高效，适合高频任务'],
  ['ling-3.1-flash', 'Ling-3.1-Flash', 0.1, 1_000_000, true, false, '长程推理，擅长办公与编程'],
  ['deepseek-flash', 'DeepSeek-V4.1-Flash', 0.1, 1_000_000, true, true, '视觉推理，擅长编码与 Agent'],
  ['deepseek-v4-pro', 'Deepseek-V4-Pro', 0.2, 1_000_000, true, false, '深度推理，擅长数理与编程'],
  ['glm-5.3', 'GLM-5.3', 1.2, 1_000_000, true, false, '百万上下文，擅长工程与 Agent'],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 0.2, 1_000_000, true, false, '轻量多模态，擅长视觉编程'],
  ['kimi-k3.1-pro', 'Kimi-K3.1-Pro', 2.4, 1_000_000, true, true, '长上下文，擅长前端与深研'],
  ['minimax-m3.1-flash', 'MiniMax-M3.1-Flash', 0.2, 1_000_000, true, true, '多模态，擅长办公、Agent 与编程'],
  ['step-5-preview', 'Step-5-Preview', 0.7, 1_000_000, true, true, '多模态，擅长 CLI、深研与编程'],
];

function catalogFromFile() {
  const dir = path.join(DATA_DIR, 'data', 'model-catalog', 'chat-modes-v2');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /\.(lkg|json)$/i.test(f));
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
    } catch {}
  }
  if (!best) return null;
  const doc = readJson(best.file);
  const list = doc && (Array.isArray(doc.catalog) ? doc.catalog : doc.data && doc.data.catalog);
  return Array.isArray(list) && list.length ? list : null;
}

/** 模型目录 → 统一的内部行。 */
function normalizeCatalog(raw) {
  const rows = [];
  for (const m of raw) {
    const id = String((m && (m.key || m.name || m.id)) || '').trim();
    if (!id) continue;
    if (m.enable === false) continue;
    const i18n = m.i18n || {};
    const name = (i18n.display_name && (i18n.display_name.zh || i18n.display_name.en)) || id;
    const desc = (i18n.description && (i18n.description.zh || i18n.description.en)) || '';
    const ctx =
      Number(m.max_input_tokens) ||
      Number(m.context_config && Object.values(m.context_config).map((c) => c && c.token_count).sort((a, b) => b - a)[0]) ||
      1_000_000;
    const promo = m.promotion && m.promotion.active ? m.promotion : null;
    rows.push({
      id,
      name: String(name),
      description: String(desc),
      contextWindow: ctx,
      maxOutputTokens: Number(m.max_output_tokens) || 32 * 1024,
      reasoning: m.is_reasoning === true,
      vision: m.is_vl === true,
      wire: String(m.format || '').includes('anthropic') ? 'anthropic' : 'openai',
      priceFactor: Number.isFinite(Number(m.price_factor)) ? Number(m.price_factor) : null,
      promotion: promo ? { label: (promo.badge && (promo.badge.zh || promo.badge.en)) || '' } : null,
      default: m.is_default === true,
      frontier: m.frontier === true,
    });
  }
  return rows;
}

function inlineCatalog() {
  return CATALOG_INLINE.map(([id, name, price, ctx, reasoning, vision, desc]) => ({
    id,
    name,
    description: desc,
    contextWindow: ctx,
    maxOutputTokens: 32 * 1024,
    reasoning,
    vision,
    wire: id === 'qwen4-max' || id === 'minimax-m3.1-flash' ? 'anthropic' : 'openai',
    priceFactor: price,
    promotion: null,
    default: id === 'flash',
    frontier: price >= 0.4,
  }));
}

let catalogCache = { at: 0, rows: null, from: '' };

function loadCatalog({ refresh = false } = {}) {
  if (!refresh && catalogCache.rows && Date.now() - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache;
  }
  const fromLog = catalogFromLogs();
  if (fromLog) {
    const rows = normalizeCatalog(fromLog.list);
    if (rows.length) {
      catalogCache = { at: Date.now(), rows, from: '桌面端日志（main.log）', sourceFile: fromLog.file };
      return catalogCache;
    }
  }
  const fromFile = catalogFromFile();
  if (fromFile) {
    const rows = normalizeCatalog(fromFile.list);
    if (rows.length) {
      catalogCache = { at: Date.now(), rows, from: 'chat-modes-v2 缓存', sourceFile: fromFile.file };
      return catalogCache;
    }
  }
  catalogCache = { at: Date.now(), rows: inlineCatalog(), from: '内置兜底表' };
  return catalogCache;
}

// ---------------------------------------------------------------- HTTP 工具

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendError(res, status, message, type = 'qwenwork_error') {
  sendJson(res, status, { ok: false, error: { message, type, code: status } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function upstreamBase() {
  const cur = currentCredential();
  const base = (cur.ok && cur.baseUrl) || credential.baseUrl || DEFAULT_BASE;
  return base.replace(/\/+$/, '');
}

function upstreamHeaders(accessKey, { stream = false, anthropic = false } = {}) {
  const h = {
    Authorization: `Bearer ${accessKey}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
  // 上游的 /v1/messages 走 Anthropic 协议，需要版本头
  if (anthropic) h['anthropic-version'] = '2023-06-01';
  return h;
}

async function upstreamFetch(target, { method = 'GET', headers, body, timeout = SHORT_TIMEOUT_MS, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const composed = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(target, { method, headers, body, signal: composed, redirect: 'follow' });
}

/**
 * 把上游响应写回客户端，**等到流真正写完才 resolve**（调用方据此释放限流位）。
 */
function pipeUpstream(res, upstream) {
  return new Promise((resolve) => {
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) return;
      if (lower === 'content-encoding' || lower === 'content-length') return;
      try {
        res.setHeader(key, value);
      } catch {}
    });
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) {
      res.end();
      resolve();
      return;
    }
    const stream = Readable.fromWeb(upstream.body);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.on('close', () => {
      if (!res.writableEnded) {
        try { stream.destroy(); } catch {}
      }
      done();
    });
    stream.on('error', (err) => {
      if (!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || /aborted/i.test(err.message || '')))) {
        log('上游流中断:', err.message);
        if (!res.writableEnded) res.destroy(err);
      }
      done();
    });
    res.on('finish', done);
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------- 路由

function handleModels(req, res, url) {
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  const cat = loadCatalog({ refresh });
  const data = cat.rows.map((m) => ({
    id: m.id,
    object: 'model',
    owned_by: 'qwenwork',
    name: m.name,
    description: m.description,
    context_window: m.contextWindow,
    max_output_tokens: m.maxOutputTokens,
    capabilities: { vision: m.vision, reasoning: m.reasoning, tools: true },
    wire: m.wire,
    price_factor: m.priceFactor,
    promotion: m.promotion ? m.promotion.label : null,
    default: m.default,
    frontier: m.frontier,
  }));
  sendJson(res, 200, {
    object: 'list',
    data,
    source: cat.from,
    fetchedAt: new Date(cat.at).toISOString(),
  });
}

/**
 * 额度：宿主 JWT 的 `/adapter/user/wallets` + `/adapter/user/account-context`。
 *
 * 这两个接口要的是桌面端**宿主 token**（不是 MaaS key）。Linux/macOS 上宿主 token
 * 就在 safeStorage 加密的 `auth-v2.dat` 里，`credentials.readHostAuth()` 能读；
 * Windows 上则由 DPAPI 解 `Local State`。读不到时如实报错，不编数字。
 */
async function fetchHostQuota() {
  const auth = credentials.readHostAuth();
  if (auth.error) return { error: auth.error };
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json',
    'User-Agent': 'qoderwork/1.3.1',
    'X-QwenWork-Version': '1.3.1',
    'X-QwenWork-Platform': process.platform,
    'X-QwenWork-Arch': process.arch,
  };
  const get = async (url) => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!r.ok) return { error: `HTTP ${r.status}：${text.slice(0, 120)}` };
      return { json };
    } catch (err) {
      return { error: err.message };
    }
  };
  const [wallets, context] = await Promise.all([
    get(`${credentials.gatewayBase()}/api/v1/adapter/user/wallets`),
    get(`${credentials.gatewayBase()}/api/v1/adapter/user/account-context?include=quota`),
  ]);
  const w = wallets.json && wallets.json.data;
  const q = context.json && context.json.data && context.json.data.quota;
  if (!w && !q) return { error: wallets.error || context.error || '额度接口没有返回数据' };

  const monthly = Number(w && w.monthly_credits && w.monthly_credits.total_balance) || 0;
  const longterm = Number(w && w.longterm_credits && w.longterm_credits.total_balance) || 0;
  const daily = Number(w && w.daily_credits && w.daily_credits.total_balance) || 0;
  const remaining =
    q && q.remaining !== null && q.remaining !== undefined
      ? Number(q.remaining)
      : monthly + longterm + daily;
  const active = w && w.active_wallets && Array.isArray(w.active_wallets.wallets)
    ? w.active_wallets.wallets.map((x) => ({
        balance: Number(x.balance) || 0,
        validTo: x.valid_to || null,
      }))
    : [];

  return {
    balance: {
      remaining: Number.isFinite(remaining) ? remaining : null,
      total: null,
      used: null,
      unit: 'credits',
      monthly,
      longterm,
      daily,
      wallets: active,
    },
    hostExpiresAt: auth.expiresAtMs ? new Date(auth.expiresAtMs).toISOString() : null,
  };
}

async function handleQuota(res) {
  const cur = currentCredential();
  const cat = loadCatalog();
  const models = cat.rows.map((m) => ({
    id: m.id,
    name: m.name,
    multiplier: m.priceFactor,
    promotion: m.promotion ? m.promotion.label : null,
  }));
  const multipliers = Object.fromEntries(
    models.map((m) => [m.id, { base: m.multiplier, effective: m.multiplier, labels: m.promotion ? [m.promotion] : [] }]),
  );
  const host = await fetchHostQuota();
  const balance = host.balance || { remaining: null, total: null, used: null, unit: 'credits' };

  if (!cur.ok) {
    return sendJson(res, 200, {
      ok: false,
      service: 'qwenwork',
      fetchedAt: new Date().toISOString(),
      error: { message: cur.error, type: 'qwenwork_auth', code: 401 },
      balance,
      quotaNote: host.error || cur.error,
      multipliers,
      models,
    });
  }

  sendJson(res, 200, {
    ok: true,
    service: 'qwenwork',
    fetchedAt: new Date().toISOString(),
    user: {
      // 桌面端 `.status.json` 里有昵称/套餐，能读就读，读不到不猜
      ...qwenAccount(),
      credentialExpiresAt: cur.expiresAtMs ? new Date(cur.expiresAtMs).toISOString() : null,
      credentialSource: cur.source || null,
      refreshes: credential.refreshes,
      hostExpiresAt: host.hostExpiresAt || null,
    },
    balance,
    quotaNote: host.error || null,
    multipliers,
    models,
  });
}

/** 读 `.status.json`（明文，含昵称/套餐），读不到返回空对象。 */
function qwenAccount() {
  const doc = readJson(path.join(AGENT_HOME, '.status.json'));
  if (!doc) return {};
  return {
    name: doc.name ? String(doc.name) : null,
    username: doc.username ? String(doc.username) : null,
    plan: doc.plan ? String(doc.plan) : null,
    userType: doc.user_type ? String(doc.user_type) : null,
    loggedIn: doc.logged_in === true,
  };
}

/** `/v1/chat/completions` 与 `/v1/messages` 都直接透传到同名上游路径。 */
function upstreamPathFor(pathname) {
  return pathname.replace(/^\/v1/, '') || '/';
}

async function handleProxy(req, res, url, body) {
  const cur = await ensureCredential();
  if (!cur.ok) {
    return sendError(res, 401, `千问办公凭据不可用：${cur.error}`, 'qwenwork_auth');
  }

  let stream = false;
  if (body && body.length) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      stream = parsed && parsed.stream === true;
    } catch {}
  }

  let release = null;
  if (LIMITER) {
    try {
      release = await LIMITER.acquire({ maxWaitMs: 5000 });
    } catch (err) {
      if (err instanceof LimiterBusy) {
        const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        return sendError(
          res,
          429,
          `本地限流：${seconds} 秒后重试（${LIMITER.limits.rpm}/分钟，并发 ${LIMITER.limits.concurrency}）`,
          'qwenwork_rate_limited',
        );
      }
      throw err;
    }
  }

  const anthropic = url.pathname.startsWith('/v1/messages');
  const target = `${upstreamBase()}${upstreamPathFor(url.pathname)}${url.search}`;
  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const started = Date.now();
  try {
    let upstream = await upstreamFetch(target, {
      method: req.method,
      headers: upstreamHeaders(cur.accessKey, { stream, anthropic }),
      body: body && body.length ? body : undefined,
      timeout: CHAT_TIMEOUT_MS,
      signal: ac.signal,
    });

    // 401：key 可能在桌面端被轮换 / 到期了。重读磁盘再试一次，仍失败才回给客户端。
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      const again = await ensureCredential({ force: true });
      if (again.ok && again.accessKey && again.accessKey !== cur.accessKey) {
        log('上游 401，已重读凭据并重试一次');
        upstream = await upstreamFetch(target, {
          method: req.method,
          headers: upstreamHeaders(again.accessKey, { stream, anthropic }),
          body: body && body.length ? body : undefined,
          timeout: CHAT_TIMEOUT_MS,
          signal: ac.signal,
        });
      }
    }

    // 仍然是 401，就把「为什么」写进响应体。
    // pi / opencode 只会显示「Provider request failed with HTTP 401」，拿不到上游 trace；
    // 而真正的原因（key 过期、exchange 又需要有效 key）在这个时间点只能人工去桌面端签发。
    if (upstream.status === 401) {
      const detail = (await upstream.text().catch(() => '')).trim().slice(0, 200);
      const expired = Boolean(credential.expiresAtMs && credential.expiresAtMs <= Date.now());
      const hint = expired
        ? `千问办公的 MaaS 凭据已于 ${new Date(credential.expiresAtMs).toISOString()} 过期。exchange 需要一把有效凭据才能换新，而过期的 key 换不了，所以代理无法自续。请打开千问办公桌面端，在对话里发一句签发新 key（或 node router.mjs login qwenwork）；反代下一次请求会自动读到，不用重启。`
        : '上游拒绝当前凭据（可能是桌面端刚轮换过 key，或账号无权限）。反代每次请求都会重读磁盘，桌面端重新签发后下一次请求就会换用新 key。';
      credential.lastError = hint;
      log(`${req.method} ${url.pathname} → 401 ${Date.now() - started}ms（${expired ? '凭据已过期' : '上游拒绝凭据'}）`);
      return sendError(res, 401, `${hint}${detail ? `（上游：${detail}）` : ''}`, 'qwenwork_auth');
    }

    log(`${req.method} ${url.pathname} → ${upstream.status} ${Date.now() - started}ms`);
    await pipeUpstream(res, upstream);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    if (aborted) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    log(`${req.method} ${url.pathname} 失败：${err.message}`);
    if (!res.headersSent) {
      sendError(res, 502, `千问办公上游不可达：${err.message}`, 'qwenwork_network');
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  } finally {
    release?.();
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendError(res, 400, '非法 URL');
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.end();
    return;
  }

  try {
    if (url.pathname === '/health') {
      const cur = currentCredential();
      return sendJson(res, 200, {
        ok: true,
        service: 'qwenwork-proxy',
        upstream: upstreamBase(),
        loggedIn: cur.ok,
        credential: cur.ok
          ? {
              present: true,
              source: cur.source || null,
              masked: maskKey(cur.accessKey),
              expiresAt: cur.expiresAtMs ? new Date(cur.expiresAtMs).toISOString() : null,
              expired: Boolean(cur.expiresAtMs && cur.expiresAtMs <= Date.now()),
              refreshes: credential.refreshes,
              lastRefreshedAt: credential.lastRefreshedAt ? new Date(credential.lastRefreshedAt).toISOString() : null,
              // 续期失败的真因（尤其是「已过期、无法自续」）
              lastError: credential.lastError || null,
            }
          : { present: false, error: cur.error },
        account: qwenAccount(),
        catalog: { source: loadCatalog().from, count: loadCatalog().rows.length },
        limits: LIMITER ? LIMITER.snapshot() : null,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      });
    }

    if (url.pathname === '/v1/quota' || url.pathname === '/v1/credits' || url.pathname === '/admin/api/credits') {
      if (req.method !== 'GET') return sendError(res, 405, '只支持 GET');
      return handleQuota(res);
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return handleModels(req, res, url);
    }

    if (url.pathname.startsWith('/v1/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
      return await handleProxy(req, res, url, body);
    }

    sendError(res, 404, `未知端点：${url.pathname}`);
  } catch (err) {
    log('请求处理失败:', err && err.stack ? err.stack : err);
    if (!res.headersSent) sendError(res, 500, err.message || '内部错误');
    else if (!res.writableEnded) res.destroy(err);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.on('error', (err) => {
  console.error('[qwenwork-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  await ensureCredential();
  const cur = currentCredential();
  log(`千问办公反代已启动：http://${HOST}:${PORT}`);
  log(`上游：${upstreamBase()}`);
  if (cur.ok) {
    const expired = Boolean(cur.expiresAtMs && cur.expiresAtMs <= Date.now());
    log(
      `凭据：${maskKey(cur.accessKey)}（来源 ${cur.source || '未知'}，到期 ${
        cur.expiresAtMs ? new Date(cur.expiresAtMs).toISOString() : '未知'
      }${expired ? '，⚠ 已过期' : ''}）`,
    );
    if (expired) {
      log('⚠ 已过期的凭据无法 exchange 自续；先打开千问办公桌面端发一句话签发新 key，代理会自动读到');
    }
  } else {
    log(`凭据：不可用 —— ${cur.error}`);
  }
  startRefreshLoop();
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
