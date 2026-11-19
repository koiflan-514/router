'use strict';
/**
 * 千问办公（QwenWork CN）凭据读取 / MaaS key 签发。
 *
 * 桌面端把宿主登录态放在 `auth-v2.dat`，用 Electron safeStorage 加密：
 *
 *   Windows  DPAPI 保护的主密钥（`Local State` → os_crypt.encrypted_key）
 *   Linux    GNOME Keyring / KWallet 里的 "QwenWorkCN Safe Storage" 密码
 *   macOS    Keychain 里的 "QwenWorkCN Safe Storage" 密码
 *
 * 拿到宿主 token 后调官方签发接口换短期推理 key：
 *
 *   POST {gateway}/api/desktop-sessions
 *   Authorization: Bearer <宿主 token>
 *   → { access_token, expires_at_ms, ttl_ms, base_url, session_id }
 *
 * 代理只读本机、本用户的凭据，不伪造设备身份。签出来的 key 缓存在
 * `~/.cache/qwenwork2api/maas-key.json`（0600），供进程和 router 共用。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const DEFAULT_GATEWAY = 'https://gateway.qwenwork.cn';
const DEFAULT_BASE = 'https://api9.qwenwork.cn/v1';
/** 剩余不足这个时长就重新签发；桌面端签的 key 只有 2 小时。 */
const REFRESH_AHEAD_MS = Number(process.env.QWENWORK_REFRESH_AHEAD_MS || 30 * 60_000);
const MINT_TIMEOUT_MS = Number(process.env.QWENWORK_MINT_TIMEOUT_MS || 20_000);
const KEY_SCHEMA = 1;

const agentHome = () =>
  String(process.env.QWENWORK_HOME || '').trim() || path.join(HOME, '.qwenworkcn');

const dataDir = () => {
  const explicit = String(process.env.QWENWORK_DATA_DIR || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'QwenWorkCN');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'QwenWorkCN');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'QwenWorkCN');
};

const cacheFile = () => {
  const explicit = String(process.env.QWENWORK_KEY_CACHE || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'qwenwork2api', 'maas-key.json');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'qwenwork2api', 'maas-key.json');
};

const gatewayBase = () =>
  (String(process.env.QWENWORK_GATEWAY_BASE || '').trim() || DEFAULT_GATEWAY).replace(/\/+$/, '');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- safeStorage

/**
 * Linux：从 Secret Service 取 Electron 的 safeStorage 密码。
 * 属性是 Chromium 的固定 schema + 应用名，`secret-tool` 走 D-Bus，不需要额外依赖。
 */
function linuxSafeStoragePassword() {
  const r = spawnSync(
    'secret-tool',
    ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', 'QwenWorkCN'],
    { encoding: 'utf8', timeout: 8_000 },
  );
  const out = String(r.stdout || '').trim();
  return r.status === 0 && out ? out : '';
}

/** macOS：Keychain 里的 safeStorage 密码。 */
function darwinSafeStoragePassword() {
  for (const service of ['QwenWorkCN Safe Storage', 'Chromium Safe Storage', 'Chrome Safe Storage']) {
    const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      timeout: 8_000,
    });
    const out = String(r.stdout || '').trim();
    if (r.status === 0 && out) return out;
  }
  return '';
}

/** Windows：DPAPI 解 Local State 里的 Chromium 主密钥。 */
function windowsMasterKey() {
  const state = readJson(path.join(dataDir(), 'Local State'));
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
    timeout: 15_000,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const key = Buffer.from(String(r.stdout || '').trim(), 'base64');
  return key.length === 32 ? key : null;
}

/** AES-256-GCM：`v1x` + 12 字节 nonce + 密文 + 16 字节 tag。 */
function decryptGcm(buf, key) {
  if (!buf || buf.length < 3 + 12 + 16 || key.length !== 32) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Chromium/Electron 在 Linux/macOS 上的旧式布局：`v1x` + AES-128-CBC，
 * key = PBKDF2(密码, "saltysalt", 1)，IV = 16 个空格。新版也用同一个布局，
 * 只是前缀从 v10 变成了 v11。
 */
function decryptCbc(buf, password) {
  if (!buf || buf.length < 4) return null;
  for (const len of [16, 32]) {
    try {
      const key = crypto.pbkdf2Sync(password, 'saltysalt', 1, len, 'sha1');
      const d = crypto.createDecipheriv(len === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, Buffer.alloc(16, 0x20));
      return Buffer.concat([d.update(buf.subarray(3)), d.final()]).toString('utf8');
    } catch {}
  }
  return null;
}

/** 解 Electron safeStorage 密文。 */
function decryptSafeStorage(buf) {
  if (!buf || buf.length < 4) return null;
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return null;

  if (process.platform === 'win32') {
    const key = windowsMasterKey();
    return key ? decryptGcm(buf, key) : null;
  }

  const password =
    process.platform === 'darwin' ? darwinSafeStoragePassword() : linuxSafeStoragePassword();
  if (!password) return null;

  // Linux/macOS 的 Electron 实际用的是 CBC 布局；先按这个解，失败再试 GCM。
  const viaCbc = decryptCbc(buf, password);
  if (viaCbc) return viaCbc;
  for (const len of [16, 32]) {
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1, len, 'sha1');
    const viaGcm = decryptGcm(buf, key);
    if (viaGcm) return viaGcm;
  }
  return null;
}

/**
 * 读宿主登录态：`auth-v2.dat`（加密）或 `auth-v2.dat.json`（桌面端降级明文）。
 * 返回 `{token, refreshToken, expiresAt, ...}`；读不到返回 `{error}`。
 */
function readHostAuth() {
  const encrypted = path.join(dataDir(), 'auth-v2.dat');
  const plain = `${encrypted}.json`;
  const legacy = path.join(dataDir(), 'auth.dat');

  let text = '';
  if (fs.existsSync(encrypted)) {
    const dec = decryptSafeStorage(fs.readFileSync(encrypted));
    if (dec) text = dec;
  }
  if (!text && fs.existsSync(plain)) text = readText(plain);
  if (!text && fs.existsSync(legacy)) {
    const dec = decryptSafeStorage(fs.readFileSync(legacy));
    if (dec) text = dec;
  }
  if (!text) {
    return {
      error:
        process.platform === 'win32'
          ? `解不开 ${encrypted}：读不到 DPAPI 主密钥（${path.join(dataDir(), 'Local State')}）`
          : `解不开 ${encrypted}：读不到 safeStorage 密码（GNOME Keyring / KWallet）`,
    };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: `${path.basename(encrypted)} 内容不是合法 JSON` };
  }
  if (!doc || typeof doc.token !== 'string' || !doc.token) {
    return { error: `${path.basename(encrypted)} 里没有宿主 token` };
  }
  const expiresAt = Date.parse(doc.expiresAt || '') || 0;
  return { ...doc, expiresAtMs: expiresAt, source: path.basename(encrypted), file: encrypted };
}

// ---------------------------------------------------------------- MaaS key

function readCachedKey() {
  const doc = readJson(cacheFile());
  if (!doc || doc.schema !== KEY_SCHEMA) return null;
  if (typeof doc.accessKey !== 'string' || !doc.accessKey) return null;
  return {
    accessKey: doc.accessKey,
    expiresAtMs: Number(doc.expiresAtMs) || 0,
    ttlMs: Number(doc.ttlMs) || 0,
    baseUrl: typeof doc.baseUrl === 'string' && doc.baseUrl ? doc.baseUrl : DEFAULT_BASE,
    sessionId: typeof doc.sessionId === 'string' ? doc.sessionId : '',
    source: typeof doc.source === 'string' ? doc.source : 'cache',
    file: cacheFile(),
  };
}

function writeCachedKey(key) {
  const file = cacheFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const doc = {
    schema: KEY_SCHEMA,
    accessKey: key.accessKey,
    expiresAtMs: key.expiresAtMs,
    ttlMs: key.ttlMs,
    baseUrl: key.baseUrl,
    sessionId: key.sessionId,
    source: key.source || 'desktop-session',
    mintedAt: Date.now(),
  };
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** 用宿主 token 调 `/api/desktop-sessions` 签一把短期推理 key。 */
async function mintAccessKey(hostToken, { sessionId = '', timeout = MINT_TIMEOUT_MS } = {}) {
  const url = `${gatewayBase()}/api/desktop-sessions`;
  const body = sessionId ? { session_id: sessionId } : {};
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hostToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    return { error: `签发请求失败：${err.message}` };
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    return { error: `签发接口返回 HTTP ${res.status}：${(json && (json.message || json.error)) || text.slice(0, 160)}` };
  }
  const token = json && typeof json.access_token === 'string' ? json.access_token : '';
  if (!token) return { error: '签发接口没有返回 access_token' };
  return {
    accessKey: token,
    expiresAtMs: Number(json.expires_at_ms) || 0,
    ttlMs: Number(json.ttl_ms) || 0,
    baseUrl: typeof json.base_url === 'string' && json.base_url
      ? (json.base_url.endsWith('/v1') ? json.base_url : `${json.base_url.replace(/\/+$/, '')}/v1`)
      : DEFAULT_BASE,
    sessionId: typeof json.session_id === 'string' ? json.session_id : '',
    source: 'desktop-session',
  };
}

let inflightMint = null;

/**
 * 确保有一把可用的推理 key：
 *   1. 缓存里的 key 离到期还早 → 直接用；
 *   2. 否则读宿主登录态，签一把新的，写回缓存。
 *
 * 并发调用会合并到同一个 promise，避免同时签出多把 key。
 */
async function ensureAccessKey({ force = false, minValidMs = REFRESH_AHEAD_MS } = {}) {
  if (inflightMint) return inflightMint;
  const cached = readCachedKey();
  const now = Date.now();
  if (!force && cached && (!cached.expiresAtMs || cached.expiresAtMs - now > minValidMs)) {
    return { ok: true, ...cached };
  }

  inflightMint = (async () => {
    const auth = readHostAuth();
    if (auth.error) return { ok: false, error: auth.error };
    if (auth.expiresAtMs && auth.expiresAtMs <= now) {
      return {
        ok: false,
        error: `宿主登录态已于 ${new Date(auth.expiresAtMs).toISOString()} 过期；请打开千问办公桌面端刷新，或重新登录`,
      };
    }
    const minted = await mintAccessKey(auth.token);
    if (minted.error) return { ok: false, error: minted.error };
    const file = writeCachedKey({ ...minted, source: 'desktop-session' });
    return { ok: true, ...minted, file };
  })().finally(() => {
    inflightMint = null;
  });
  return inflightMint;
}

function credentialSummary() {
  const cached = readCachedKey();
  if (!cached) return { present: false, error: `还没有签发过推理 key（${cacheFile()}）` };
  return {
    present: true,
    expiresAtMs: cached.expiresAtMs,
    source: cached.source,
    sessionId: cached.sessionId,
    file: cached.file,
  };
}

module.exports = {
  DEFAULT_BASE,
  REFRESH_AHEAD_MS,
  agentHome,
  dataDir,
  cacheFile,
  gatewayBase,
  readHostAuth,
  readCachedKey,
  writeCachedKey,
  mintAccessKey,
  ensureAccessKey,
  credentialSummary,
};
