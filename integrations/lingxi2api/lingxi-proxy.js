#!/usr/bin/env node
/**
 * lingxi-proxy.js — 把 WPS 灵犀桌面端的订阅额度转成 OpenAI 兼容端点。
 *
 * 灵犀是 Electron 外壳 + Go app-server（JSON-RPC over stdio）的 agent 形态。
 * 本反代自己 spawn 一个 app-server，用桌面端的 wps_sid 鉴权，把 OpenAI 的
 * /v1/models 与 /v1/chat/completions 翻译成它的原生 JSON-RPC：
 *
 *   initialize  →  session/start  →  run/start  →  收集 SSE 事件  →  OpenAI 响应
 *
 * 同时保留只读积分端点（credits 插件用）。
 *
 * 凭据链条：
 *   %APPDATA%/WPS 灵犀/Local State → os_crypt.encrypted_key（DPAPI）
 *     └─ AES-256-GCM 解 Partitions/lingxi-passport-v2-<hash>/Network/Cookies 的 wps_sid
 * 注意 SID 不在 app-server-data/auth.json（那份是 runtime，落盘为空），
 * auth-binding-key.v1 只用于认证快照的 HMAC 绑定，不是快照密钥。
 *
 * 端点：
 *   GET  /health              进程、上游、登录态、模型数
 *   GET  /v1/models           OpenAI 模型清单（来自 app-server 的 model/list）
 *   POST /v1/chat/completions 对话；支持流式与非流式、多轮 messages
 *   GET  /v1/quota            智点余额 + 积分包（opencode credits 插件用）
 *   GET  /v1/credits          同上（别名）
 *   GET  /v1/usage            智点收支明细
 *
 * 零依赖，只用 node: 内建模块；不写任何凭证文件。
 *
 * 用法：
 *   node lingxi-proxy.js                  # 127.0.0.1:8796
 *   node lingxi-proxy.js --port 8796
 *   LINGXI_WPS_SID=... node lingxi-proxy.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const STARTED_AT = Date.now();

const DEFAULT_PORT = 8796;
const UPSTREAM = String(process.env.LINGXI_UPSTREAM || 'https://lingxi.wps.cn').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.LINGXI_TIMEOUT_MS || 15_000);
const SID_CACHE_MS = Number(process.env.LINGXI_SID_CACHE_MS || 120_000);
const QUOTA_CACHE_MS = Number(process.env.LINGXI_QUOTA_CACHE_MS || 30_000);
const CHAT_TIMEOUT_MS = Number(process.env.LINGXI_CHAT_TIMEOUT_MS || 180_000);
const DEVICE_ID = String(process.env.LINGXI_DEVICE_ID || '').trim()
  || '87722910d967ed51e44f45ea22844b9dc745c4e85fce4f9792bd61b74d692b61';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PORT = Number(argValue('--port') || process.env.LINGXI_PORT || process.env.PORT || DEFAULT_PORT);
const HOST = String(process.env.LINGXI_HOST || '127.0.0.1');

function appDataRoot() {
  const explicit = String(process.env.LINGXI_APP_DATA || '').trim();
  if (explicit) return explicit;
  if (WIN) {
    const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(roaming, 'WPS 灵犀');
  }
  const native = path.join(HOME, '.config', 'WPS 灵犀');
  // 官方只发 Windows 版；Linux 上用 Wine 跑时，登录态在 Wine prefix 的
  // AppData\Roaming\WPS 灵犀 下。原生目录优先，Wine 作为退路。
  try {
    const { candidateDirs, firstExistingDir } = require('../wine-paths.js');
    const hit = firstExistingDir(
      candidateDirs({ explicitEnv: 'LINGXI_APP_DATA', nativeDir: native, productNames: ['WPS 灵犀'] }),
    );
    if (hit) return hit.dir;
  } catch {}
  return native;
}

const APP_DATA = appDataRoot();

/**
 * 定位 app-server 可执行文件。
 *
 * 两种布局都要认（实测都会出现）：
 *   app_server_link/service/lingxi.exe          → Windows 上桌面端建的符号链接
 *   app_server_<版本>/service/lingxi.exe        → 链接建不起来时（Wine）保留的真实目录
 * Wine 里符号链接常常建不成，桌面端会留下一个空的 `app_server_link`，
 * 只认前者就会报「找不到 app-server」。
 */
function locateAppServer() {
  const explicit = String(process.env.LINGXI_APP_SERVER || '').trim();
  if (explicit) return explicit;

  const direct = path.join(APP_DATA, 'app_server_link', 'service', 'lingxi.exe');
  try {
    if (fs.statSync(direct).isFile()) return direct;
  } catch {}

  // 退到版本目录，取版本号最大的那个（多版本并存时用最新的）
  try {
    const versions = fs
      .readdirSync(APP_DATA)
      .filter((n) => /^app_server_\d/.test(n))
      .sort((a, b) => {
        const va = a.replace(/^app_server_/, '').split('.').map(Number);
        const vb = b.replace(/^app_server_/, '').split('.').map(Number);
        for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
          const d = (va[i] || 0) - (vb[i] || 0);
          if (d !== 0) return d;
        }
        return 0;
      })
      .reverse();
    for (const v of versions) {
      const p = path.join(APP_DATA, v, 'service', 'lingxi.exe');
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  } catch {}
  return direct;
}

const APP_SERVER_EXE = locateAppServer();
const APP_SERVER_CONFIG = path.join(APP_DATA, 'app-server-data', 'config.json');
const APP_SERVER_DATA = path.join(APP_DATA, 'app-server-data', 'state');

/**
 * 官方只发 Windows 版 app-server（lingxi.exe 是 PE）。Linux 上只能靠 Wine 跑，
 * 所以这里要把「Linux 路径 + 原生 spawn」翻译成「Windows 路径 + wine 命令」。
 *
 * 两个坑：
 *  1. Wine 只认 Windows 路径：prefix 里的文件要写成 C:\...，prefix 外的走 Z:\。
 *  2. Wine 的 prefix 必须显式指定（WINEPREFIX），否则它会用 ~/.wine，
 *     而桌面端和反代必须共享**同一个** prefix —— DPAPI 密钥只在该 prefix 内有效。
 */

/** 跑 .exe 用的 Wine 命令。显式 LINGXI_WINE 优先（可带参数），默认系统 wine。 */
function wineCommand() {
  const explicit = String(process.env.LINGXI_WINE || '').trim();
  if (explicit) return explicit.split(/\s+/);
  return ['wine'];
}

/**
 * 当前 prefix 的根。
 *
 * 优先显式 WINEPREFIX；否则用本项目的专用 prefix（`~/.local/share/wineprefixes/lingxi`），
 * 最后回落到 `~/.wine`。专用 prefix 的好处：不污染默认 prefix，也便于整个目录备份/迁移。
 */
function winePrefix() {
  const env = String(process.env.WINEPREFIX || '').trim();
  if (env) return env;
  const dedicated = path.join(HOME, '.local/share/wineprefixes/lingxi');
  try {
    if (fs.statSync(path.join(dedicated, 'drive_c')).isDirectory()) return dedicated;
  } catch {}
  return path.join(HOME, '.wine');
}

/** Linux 绝对路径 → Wine 眼里的 Windows 路径。 */
function toWinePath(unixPath) {
  const resolved = path.resolve(unixPath);
  const prefix = path.resolve(winePrefix());
  const driveC = path.join(prefix, 'drive_c');
  const rel = path.relative(driveC, resolved);
  if (rel && !rel.startsWith('..')) {
    return `C:\\${rel.split(path.sep).join('\\')}`;
  }
  return `Z:${resolved.split(path.sep).join('\\')}`;
}

/**
 * 拼出启动 app-server 的 { command, args }。
 *
 * Windows 上就是直接跑 exe；Linux 上改成 `wine <exe> ...`，而参数里的
 * 配置/数据目录也要换成 Windows 路径，否则 app-server 会往 Z:\ 里找不存在的文件。
 */
function appServerSpawn() {
  const args = ['--stdin', '--auth-storage=runtime'];
  if (fs.existsSync(APP_SERVER_CONFIG)) args.push('--config', toWinePath(APP_SERVER_CONFIG));
  args.push('--data-dir', toWinePath(APP_SERVER_DATA));

  if (WIN) return { command: APP_SERVER_EXE, args };

  const wine = wineCommand();
  return {
    command: wine[0],
    args: [...wine.slice(1), toWinePath(APP_SERVER_EXE), ...args],
  };
}

// ---------------------------------------------------------------- 小工具

function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function maskSid(sid) {
  const s = String(sid || '');
  if (!s) return '';
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, status, message, type = 'lingxi_error') {
  sendJson(res, status, { ok: false, error: { message, type, code: status } });
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(numberOrZero(value) * 100) / 100;
}

// ---------------------------------------------------------------- 凭据

const sidCache = { sid: '', at: 0, source: '', error: '' };

/**
 * 解开 Local State 里的 `os_crypt.encrypted_key`，拿到 Chromium 的 cookie 主密钥。
 *
 * 三条路，按平台挑：
 *   1. Windows 原生：powershell 调 ProtectedData.Unprotect（原来的做法）
 *   2. Linux + Wine：Wine 没有可用的 powershell（`fixme:powershell:wmain stub`），
 *      改用一个交叉编译的小 PE（`wine-dpapi.exe`）在同一个 prefix 里调
 *      CryptUnprotectData —— 它和桌面端在同一个 Wine 用户下，DPAPI 主密钥一致。
 *   3. mac/Linux 原生客户端：cookie 是 `v10` + 固定派生密钥，不需要 DPAPI。
 */
function windowsMasterKey() {
  const state = readJson(path.join(APP_DATA, 'Local State'));
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (typeof b64 !== 'string' || !b64) return null;

  let blob = Buffer.from(b64, 'base64');
  if (blob.subarray(0, 5).toString('latin1') === 'DPAPI') blob = blob.subarray(5);

  // 2) Wine：用随仓库分发的 windows-dpapi 小工具（见 integrations/lingxi2api/tools）
  if (!WIN) {
    const key = keyViaWineTool(path.join(APP_DATA, 'Local State'));
    if (key) return key;
  }

  // 1) 原生 Windows
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${blob.toString('base64')}')`,
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (r.status !== 0) return null;
  const key = Buffer.from(String(r.stdout || '').trim(), 'base64');
  return key.length === 32 ? key : null;
}

/**
 * 在 Wine 里跑 windows-dpapi.exe 解出主密钥。
 *
 * 为什么需要它：Wine 自带 crypt32 的 DPAPI 实现，但 Electron 的 Local State
 * 是**同一个 prefix 内**加密的，所以用同一个 prefix 里的 wine 去解就能对上。
 * powershell 在 Wine 里是空壳，只能走这个原生 PE。
 */
function keyViaWineTool(localStatePath) {
  const tool = path.join(__dirname, 'tools', 'windows-dpapi.exe');
  if (!fs.existsSync(tool)) return null;
  const wine = wineCommand();
  try {
    const r = spawnSync(wine[0], [...wine.slice(1), tool, localStatePath], {
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, WINEPREFIX: winePrefix() },
    });
    if (r.status !== 0) return null;
    const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
    const key = Buffer.from(lines[lines.length - 1].trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function decryptCookie(buf, key) {
  if (!buf || !buf.length || !key) return '';
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString('utf8');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const out = Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]);
    if (out.length > 32) return out.subarray(32).toString('utf8');
    return out.toString('utf8');
  } catch {
    return '';
  }
}

function cookieDatabases() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'Cookies') out.push(p);
    }
  };
  walk(APP_DATA, 0);
  out.sort((a, b) => (/passport/i.test(a) ? 0 : 1) - (/passport/i.test(b) ? 0 : 1));
  return out;
}

function sidFromCookies() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { error: '当前 Node 没有 node:sqlite（需要 Node 22.5+）' };
  }
  const key = windowsMasterKey();
  if (!key) return { error: `读不到 DPAPI 主密钥（${path.join(APP_DATA, 'Local State')}）` };
  const dbs = cookieDatabases();
  if (!dbs.length) return { error: `找不到 cookie 库：${APP_DATA}` };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-'));
  try {
    for (const db of dbs) {
      const copy = path.join(tmp, `c${dbs.indexOf(db)}.db`);
      try {
        fs.copyFileSync(db, copy);
      } catch {
        continue;
      }
      let conn;
      try {
        conn = new DatabaseSync(copy, { readOnly: true });
        const rows = conn
          .prepare("SELECT host_key, encrypted_value FROM cookies WHERE name = 'wps_sid'")
          .all();
        for (const row of rows) {
          const sid = decryptCookie(Buffer.from(row.encrypted_value), key);
          if (sid) return { sid, source: path.relative(APP_DATA, db) };
        }
      } catch {
        // 换下一个分区
      } finally {
        try {
          if (conn) conn.close();
        } catch {}
      }
    }
    return { error: '未登录 WPS 灵犀（cookie 库里没有 wps_sid）' };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

function readSid({ force = false } = {}) {
  const explicit = String(process.env.LINGXI_WPS_SID || '').trim();
  if (explicit) return { sid: explicit, source: 'env' };
  if (!force && sidCache.sid && Date.now() - sidCache.at < SID_CACHE_MS) {
    return { sid: sidCache.sid, source: sidCache.source };
  }
  const got = sidFromCookies();
  if (got.sid) {
    sidCache.sid = got.sid;
    sidCache.at = Date.now();
    sidCache.source = got.source;
    sidCache.error = '';
    return { sid: got.sid, source: got.source };
  }
  sidCache.error = got.error || '取不到 wps_sid';
  if (sidCache.sid) return { sid: sidCache.sid, source: sidCache.source, stale: true };
  return { error: sidCache.error };
}

// ---------------------------------------------------------------- 上游 HTTP（积分）

async function upstreamGet(apiPath, { force = false } = {}) {
  let auth = readSid({ force });
  if (!auth.sid) {
    return Object.assign(new Error(auth.error || '取不到 WPS 灵犀登录态'), { code: 'LINGXI_NO_AUTH' });
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch(`${UPSTREAM}${apiPath}`, {
        headers: {
          Cookie: `wps_sid=${auth.sid}`,
          Accept: 'application/json',
          'User-Agent': 'lingxi-desktop/1.3.41',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return Object.assign(new Error(`WPS 灵犀上游不可达：${err.message}`), { code: 'LINGXI_NETWORK' });
    }
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    if (res.status === 401 || res.status === 403) {
      auth = readSid({ force: true });
      if (auth.sid && attempt === 0) continue;
      return Object.assign(new Error('WPS 灵犀登录态失效（打开桌面端重新登录）'), { code: 'LINGXI_AUTH' });
    }
    if (!res.ok || !payload || payload.result !== 'ok') {
      const message = (payload && (payload.msg || payload.hint)) || text.slice(0, 200) || `HTTP ${res.status}`;
      return Object.assign(new Error(`WPS 灵犀接口返回：${message}`), { code: 'LINGXI_UPSTREAM' });
    }
    return { data: payload.data || {}, fetchedAt: new Date().toISOString() };
  }
  return Object.assign(new Error('WPS 灵犀登录态失效'), { code: 'LINGXI_AUTH' });
}

function statusFor(err) {
  if (err.code === 'LINGXI_NO_AUTH') return 501;
  if (err.code === 'LINGXI_AUTH') return 401;
  return 502;
}

// ---------------------------------------------------------------- AppServer 客户端（stdio JSON-RPC）

/**
 * 管理与一个常驻 lingxi.exe app-server 的 stdio JSON-RPC 会话。
 *
 * 关键协议点（逆向所得，见 README）：
 *  - 必须 spawn 时带 LINGXI_WPS_SID 环境变量（runtime 鉴权）
 *  - initialize params 用 snake_case：{protocol_version, device_id, client_type}
 *  - 握手后要发 `initialized` 通知，否则后续方法都回 -32600
 *  - 方法名用斜杠：session/start、run/start、model/list、account/status
 *  - run/start 参数：{session_id, model:{provider,model_name}, agent_input:{text,files}}
 *  - 回复文本在 component.content 事件的 delta / component.end 的 full_content
 *
 * 并发控制：所有 RPC 串行（mutex）——与桌面端单窗口语义一致，也避免 stdout
 * 多路复用的竞态。对话请求排队执行。
 */
class AppServer {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.nextId = 1;
    this.ready = false;
    this.readyPromise = null;
    this.queue = Promise.resolve();
    this.sidUsed = '';
    this.lastError = '';
  }

  /** 确保进程在跑且已完成握手；SID 变了就重建。 */
  ensure() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._start().catch((err) => {
      this.lastError = err.message;
      this.readyPromise = null;
      this.ready = false;
      throw err;
    });
    return this.readyPromise;
  }

  async _start() {
    const auth = readSid();
    if (!auth.sid) throw new Error(auth.error || '未登录 WPS 灵犀');
    if (!fs.existsSync(APP_SERVER_EXE)) throw new Error(`找不到 app-server：${APP_SERVER_EXE}`);

    this._stopChild();
    this.sidUsed = auth.sid;
    this.nextId = 1;
    this.pending.clear();

    const exec = appServerSpawn();
    this.child = spawn(exec.command, exec.args, {
      env: {
        ...process.env,
        LINGXI_WPS_SID: auth.sid,
        WINEPREFIX: winePrefix(),
        // 关掉 Wine 调试通道：app-server 本身不渲染，但 fixme/warn 的字符串格式化
        // 仍要走一遍，长时间跑会积成可观的开销。
        WINEDEBUG: process.env.WINEDEBUG || '-all',
        // 同步原语交给 NTSync（Wine 10.16+ 默认，内核 6.14+ 有 /dev/ntsync）。
        // 只在没有 NTSync 时才退回 FSync——两者互斥，不能同时设。
        ...(fs.existsSync('/dev/ntsync') ? {} : { WINEFSYNC: '1' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      // app-server 会往 stderr 打 broker 信息，忽略噪音，只留真正的错误
      if (/error|failed/i.test(s)) log('[app-server]', s.trim().slice(0, 200));
    });
    this.child.on('exit', (code) => {
      this.ready = false;
      this.readyPromise = null;
      if (this.child) log(`app-server 退出（code=${code}）`);
      this.child = null;
      // 让等待中的请求尽快失败
      for (const [, p] of this.pending) p.reject(new Error('app-server 已退出'));
      this.pending.clear();
    });
    this.child.on('error', (err) => {
      this.lastError = err.message;
      log('app-server 启动失败:', err.message);
    });

    const init = await this._requestRaw('initialize', {
      protocol_version: '2026-08-13',
      device_id: DEVICE_ID,
      client_type: 'lingxi_claw',
    }, 15000);
    this.notify('initialized', {});
    this.ready = true;
    log(`app-server 就绪：v${init.server_info && init.server_info.version}，模型 ${(init.capabilities && init.capabilities.supported_api_formats || []).join('/')}`);
    return init;
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(this._rpcError(msg.error));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.eventHandlers) {
          try {
            h(msg);
          } catch {}
        }
      }
    }
  }

  _rpcError(error) {
    const data = error.data || {};
    const err = new Error(data.hint || data.msg || error.message || 'app-server 错误');
    err.code = error.code;
    err.result = data.result;
    err.v7code = data.v7code;
    return err;
  }

  request(method, params, timeout = CHAT_TIMEOUT_MS, onEvent = null) {
    // 串行执行：会话/运行都是单窗口语义，且简化事件归属
    const run = () => this._requestNow(method, params, timeout, onEvent);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _requestNow(method, params, timeout, onEvent) {
    await this.ensure();
    return this._requestRaw(method, params, timeout, onEvent);
  }

  /** 直接发一帧并等响应，不经过 ensure / 队列（握手阶段用，避免重入死锁）。 */
  _requestRaw(method, params, timeout, onEvent) {
    if (onEvent) this.eventHandlers.add(onEvent);
    const id = `desktop_${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (onEvent) this.eventHandlers.delete(onEvent);
        reject(new Error(`${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, onEvent });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (onEvent) this.eventHandlers.delete(onEvent);
        reject(err);
      }
    }).finally(() => {
      if (onEvent) this.eventHandlers.delete(onEvent);
    });
  }

  notify(method, params) {
    if (this.child && this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }
  }

  _stopChild() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.ready = false;
  }
}

const appServer = new AppServer();

// ---------------------------------------------------------------- 模型目录

const MODEL_CACHE_MS = 5 * 60 * 1000;
let modelCache = { models: null, at: 0 };

/** OpenAI /v1/models 形状的清单，来自 app-server 的 model/list。 */
async function listModels({ refresh = false } = {}) {
  if (!refresh && modelCache.models && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models;
  }
  await appServer.ensure();
  const raw = await appServer.request('model/list', {});
  const created = Math.floor(Date.now() / 1000);
  const models = (Array.isArray(raw.models) ? raw.models : []).map((m) => ({
    id: m.model_name,
    object: 'model',
    created,
    owned_by: m.provider || 'lingxi',
    name: m.name || m.model_name,
    description: m.intro || m.desc || '',
    context_window: m.max_context_tokens || null,
    max_output_tokens: m.max_new_tokens || null,
    capabilities: {
      // 上游 support_multimodal=true，但本桥只把 messages 压成 text（files:[]），
      // 图片会被丢弃——如实标 false，免得客户端贴图后静默失效
      vision: false,
      reasoning: Array.isArray(m.reasoning_efforts) && m.reasoning_efforts.length > 0,
      // 灵犀是完整 agent，不吐 OpenAI tool_calls；标 false 让客户端别拿它当编码驱动
      tool_call: false,
    },
  }));
  if (!models.length) throw new Error('app-server 没有返回模型');
  modelCache = { models, at: Date.now() };
  return models;
}

function resolveModel(modelId, models) {
  if (!modelId) return models[0] && models[0].id;
  const hit = models.find((m) => m.id === modelId || m.id.toLowerCase() === String(modelId).toLowerCase());
  return hit ? hit.id : null;
}

// ---------------------------------------------------------------- 对话

/** 把 OpenAI messages 压成灵犀 agent_input.text（保留角色，多轮用换行分隔）。 */
function messagesToText(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  return messages
    .map((m) => {
      const role = String(m.role || 'user');
      let content = m.content;
      if (Array.isArray(content)) {
        content = content
          .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
          .map((part) => part.text || '')
          .join('\n');
      }
      content = String(content == null ? '' : content);
      if (role === 'system') return `[系统指令]\n${content}`;
      if (role === 'assistant') return `[助手]\n${content}`;
      if (role === 'tool') return `[工具结果]\n${content}`;
      return content;
    })
    .filter(Boolean)
    .join('\n\n');
}

function parseStream(body) {
  if (!body || !body.length) return false;
  try {
    return JSON.parse(body.toString('utf8')).stream === true;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 执行一次 chat。onDelta(text) 在流式时逐段回调；非流式传 null。
 * 返回 { text, usage, runId }。
 */
async function runChat({ model, messages, reasoningEffort, onDelta }) {
  const models = await listModels();
  const resolved = resolveModel(model, models);
  if (!resolved) {
    const err = new Error(`未知模型 ${model}（可用：${models.slice(0, 8).map((m) => m.id).join(', ')}…）`);
    err.status = 400;
    throw err;
  }
  const text = messagesToText(messages);
  if (!text.trim()) {
    const err = new Error('messages 为空');
    err.status = 400;
    throw err;
  }

  // 每次请求新建会话：干净上下文，也避免并发串台
  const session = await appServer.request('session/start', {
    session_type: 'cowork_client',
    agent: 'lingxiclaw',
    client_type: 'lingxi_claw',
  });
  const sessionId = session.session_id;

  let fullText = '';
  let finish = false;
  let usage = null;
  let runError = null;

  const onEvent = (msg) => {
    const p = msg.params || {};
    if (p.session_id && p.session_id !== sessionId) return;
    if (msg.method === 'component.content' && p.type === 'c_text') {
      const delta = String(p.delta || '');
      if (delta) {
        fullText += delta;
        if (onDelta) onDelta(delta);
      }
    } else if (msg.method === 'component.end' && p.type === 'c_text') {
      // full_content 是这一段的完整文本；若没有收到过 delta，用它兜底
      if (!fullText && p.full_content) {
        fullText = String(p.full_content);
        if (onDelta) onDelta(fullText);
      }
    } else if (msg.method === 'token_usage.updated' && p.usage) {
      usage = p.usage;
    } else if (msg.method === 'error') {
      runError = new Error((p.details && p.details.hint) || p.message || 'run 失败');
      finish = true;
    } else if (msg.method === 'stream.end' || msg.method === 'run.end') {
      finish = true;
    }
  };

  // 事件 handler 的生命周期要覆盖整个 run（响应返回后事件还在继续），
  // 所以这里自己注册/注销，不用 request 的 onEvent（那个在响应返回时就移除了）。
  appServer.eventHandlers.add(onEvent);
  try {
    const agentInput = { text, files: [] };
    if (reasoningEffort) agentInput.reasoning_effort = reasoningEffort;
    const result = await appServer.request('run/start', {
      session_id: sessionId,
      model: { provider: 'lingxi', model_name: resolved },
      agent_input: agentInput,
    });

    // run/start 返回后，事件流还在继续；等到 stream.end / run.end / error。
    const deadline = Date.now() + CHAT_TIMEOUT_MS;
    while (!finish && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
    }
    if (runError) throw runError;
    if (!finish) throw new Error('对话超时（未收到结束事件）');
    return { text: fullText, usage, runId: result.run_id || result.group_id || null, model: resolved };
  } finally {
    appServer.eventHandlers.delete(onEvent);
  }
}

async function handleChat(req, res, url, body) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return sendError(res, 400, '非法 JSON body');
  }

  const stream = parseStream(body);
  const reasoningEffort =
    payload.reasoning_effort
    || (payload.chat_template_kwargs && payload.chat_template_kwargs.reasoning_effort)
    || null;

  if (stream) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const model = payload.model || 'lingxi';
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const result = await runChat({
        model,
        messages: payload.messages,
        reasoningEffort,
        onDelta: (delta) => {
          send({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          });
        },
      });
      const resultModel = result.model || model;
      send({
        id, object: 'chat.completion.chunk', created, model: resultModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(result.usage ? { usage: {
          prompt_tokens: numberOrZero(result.usage.input_tokens),
          completion_tokens: numberOrZero(result.usage.output_tokens),
          total_tokens: numberOrZero(result.usage.total_tokens),
        } } : {}),
      });
      res.write('data: [DONE]\n\n');
    } catch (err) {
      send({ error: { message: err.message, type: 'lingxi_chat_error', code: err.status || 502 } });
      res.write('data: [DONE]\n\n');
    }
    res.end();
    return;
  }

  // 非流式
  try {
    const result = await runChat({ model: payload.model, messages: payload.messages, reasoningEffort });
    sendJson(res, 200, {
      id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      ...(result.usage ? { usage: {
        prompt_tokens: numberOrZero(result.usage.input_tokens),
        completion_tokens: numberOrZero(result.usage.output_tokens),
        total_tokens: numberOrZero(result.usage.total_tokens),
      } } : {}),
    });
  } catch (err) {
    sendError(res, err.status || 502, err.message, 'lingxi_chat_error');
  }
}

// ---------------------------------------------------------------- 积分

const profileCache = { data: null, at: 0 };

async function readProfile({ force = false } = {}) {
  if (!force && profileCache.data && Date.now() - profileCache.at < 300_000) return profileCache.data;
  const got = await upstreamGet('/api/public/v1/account/profile', { force });
  if (got instanceof Error) return null;
  profileCache.data = got.data;
  profileCache.at = Date.now();
  return got.data;
}

const quotaCache = { data: null, at: 0 };

function bucketLabel(item, kind) {
  if (kind === 'purchased') return '购买智点';
  if (kind === 'contract') return '套餐智点';
  return '赠送智点';
}

async function handleQuota(res, url) {
  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  if (!refresh && quotaCache.data && Date.now() - quotaCache.at < QUOTA_CACHE_MS) {
    return sendJson(res, 200, quotaCache.data);
  }
  const got = await upstreamGet('/api/public/v1/credits/balance', { force: refresh });
  if (got instanceof Error) return sendError(res, statusFor(got), got.message, 'lingxi_quota');
  const d = got.data;
  const profile = await readProfile({ force: refresh });

  const remaining = round2(d.total_balance);
  const bonus = round2(d.total_bonus);
  const purchased = round2(d.total_purchased);
  const contract = round2(d.total_contract);
  const grantedBonus = round2(d.bonus_summary && d.bonus_summary.total_value);
  const grantedPurchased = round2(d.purchased_summary && d.purchased_summary.total_value);
  const total = round2(grantedBonus + grantedPurchased);
  const consumed = round2(
    numberOrZero(d.bonus_summary && d.bonus_summary.total_consumed)
    + numberOrZero(d.purchased_summary && d.purchased_summary.total_consumed),
  );

  const buckets = [];
  for (const [kind, list] of [['bonus', d.bonus_credits], ['purchased', d.purchased_credits]]) {
    for (const item of Array.isArray(list) ? list : []) {
      buckets.push({
        kind, label: bucketLabel(item, kind), skuKey: item.sku_key || null,
        total: round2(item.value), used: round2(item.consumed), remaining: round2(item.balance),
        unit: 'credits', effectAt: item.effect_time || null, expireAt: item.expire_time || null,
      });
    }
  }
  buckets.sort((a, b) => String(a.expireAt || '9999').localeCompare(String(b.expireAt || '9999')));
  const sub = d.active_subscription || null;
  const user = profile || {};

  const body = {
    ok: true,
    service: 'lingxi',
    fetchedAt: got.fetchedAt,
    user: {
      id: user.id ? String(user.id) : null,
      name: user.name || null,
      corpId: user.corp_id ? String(user.corp_id) : null,
      isCorp: Boolean(user.corp_id && String(user.corp_id) !== '0'),
    },
    balance: { remaining, total, used: consumed, unit: 'credits' },
    wallet: {
      available: remaining, bonus, purchased, contract, granted: total, consumed,
      enabled: d.enabled === true,
    },
    subscription: sub ? {
      skuKey: sub.sku_key || null, name: sub.merchandise_name || null,
      expireAt: sub.expire_time || null, planExpireAt: sub.plan_expire_time || null,
    } : null,
    buckets,
    multipliers: {},
    chatAvailable: true,
    chatNote: '已接入 OpenAI 兼容对话（经 app-server JSON-RPC）',
  };
  quotaCache.data = body;
  quotaCache.at = Date.now();
  sendJson(res, 200, body);
}

async function handleUsage(res, url) {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const got = await upstreamGet('/api/public/v1/credits/transaction_summary');
  if (got instanceof Error) return sendError(res, statusFor(got), got.message, 'lingxi_usage');
  const list = Array.isArray(got.data.list) ? got.data.list : [];
  sendJson(res, 200, {
    ok: true,
    service: 'lingxi',
    fetchedAt: got.fetchedAt,
    hasMore: got.data.has_more === true,
    transactions: list.slice(0, limit).map((t) => ({
      type: t.type || null, amount: round2(t.amount), taskName: t.task_name || null,
      remark: t.remark || null, source: t.source || null, sessionId: t.session_id || null,
      skuKey: t.sku_key || null, at: t.time || null, expireAt: t.expire_time || null,
    })),
  });
}

async function handleHealth(res) {
  const auth = readSid();
  const profile = auth.sid ? await readProfile() : null;
  let models = [];
  let modelError = '';
  try {
    models = await listModels();
  } catch (err) {
    modelError = err.message;
  }
  sendJson(res, 200, {
    ok: true,
    service: 'lingxi-proxy',
    upstream: UPSTREAM,
    appServerReady: appServer.ready,
    appServerError: appServer.lastError || undefined,
    loggedIn: Boolean(auth.sid),
    credentialSource: auth.source || null,
    credentialError: auth.error || undefined,
    sid: auth.sid ? maskSid(auth.sid) : null,
    user: profile ? { id: String(profile.id || ''), name: profile.name || null } : null,
    models: models.length,
    modelError: modelError || undefined,
    appData: APP_DATA,
    chatAvailable: true,
    endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/quota', '/v1/credits', '/v1/usage'],
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  });
}

// ---------------------------------------------------------------- 路由

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
    if (url.pathname === '/health' || url.pathname === '/') return await handleHealth(res);
    if (url.pathname === '/v1/models' && (req.method === 'GET' || req.method === 'HEAD')) {
      const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
      try {
        const models = await listModels({ refresh });
        return sendJson(res, 200, { object: 'list', data: models });
      } catch (err) {
        return sendError(res, 502, err.message, 'lingxi_models');
      }
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      return await handleChat(req, res, url, body);
    }
    if (url.pathname === '/v1/quota' || url.pathname === '/v1/credits' || url.pathname === '/admin/api/credits') {
      if (req.method !== 'GET') return sendError(res, 405, '只支持 GET');
      return await handleQuota(res, url);
    }
    if (url.pathname === '/v1/usage' && req.method === 'GET') return await handleUsage(res, url);

    sendError(res, 404, `未知端点：${url.pathname}`);
  } catch (err) {
    log('请求处理失败:', err && err.stack ? err.stack : err);
    if (!res.headersSent) sendError(res, 500, err.message || '内部错误');
    else if (!res.writableEnded) res.destroy(err);
  }
});

server.requestTimeout = 0;

server.on('error', (err) => {
  console.error('[lingxi-proxy] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = readSid();
  log(`WPS 灵犀反代已启动：http://${HOST}:${PORT}（OpenAI 兼容 + 积分）`);
  log(`桌面端目录：${APP_DATA}`);
  log(
    auth.sid
      ? `登录态：已取到 wps_sid（${maskSid(auth.sid)}，来源 ${auth.source}）`
      : `登录态：${auth.error || '未登录'}（打开 WPS 灵犀桌面端登录后自动生效）`,
  );
  // 预热 app-server，让首次 /v1/models 更快
  appServer.ensure().then(() => listModels()).catch((err) => {
    log('app-server 预热失败（首次请求时会重试）：', err.message);
  });
});

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  appServer._stopChild();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
