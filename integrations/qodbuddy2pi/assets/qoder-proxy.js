#!/usr/bin/env node
/**
 * qoder-proxy.js — 把 Qoder 的额度暴露成一个 OpenAI 兼容端点。
 *
 * 为什么需要它：pi 直接吃 Qoder 的私有协议（pi-provider-qoder 扩展里那套 COSY
 * 签名 + 自定义 body 编码 + SSE 信封），但 opencode 只会说 OpenAI。两边要共用
 * 同一份额度，就得在中间放一个翻译层——这正是 WorkBuddy 那边 codebuddy_proxy
 * 扮演的角色，只是那一个是 PyPI 的现成包，Qoder 这边没有，只能自己写。
 *
 * 它只做三件事：
 *   1. 读 pi 的 ~/.pi/agent/auth.json 拿凭证（与 pi 共用同一份登录态），过期就续
 *   2. 把 OpenAI 的 /v1/chat/completions 请求翻成 Qoder 的 agent_chat_generation
 *   3. 把 Qoder 的 SSE 信封拆开，还原成 OpenAI 的 chunk 流
 *
 * 没有依赖：只用 node: 内建模块，所以不需要 npm install，也不会被上游版本带走。
 *
 * 用法：
 *   node qoder-proxy.js --region cn --port 8789
 *   node qoder-proxy.js --region global --port 8790 --verbose
 *   node qoder-proxy.js --region cn --port 0 --print-port   # 测试用，随机端口
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本地限流：与网关、其它反代共用 limits.json。直连 :8789 / :8790 也必须限，
// 否则客户端绕过网关开子代理时，上游仍会看到多路并发（docs/13-limits.md）。
let createLimiterFor = null;
let LimiterBusy = null;
try {
  ({ createLimiterFor, LimiterBusy } = require(path.join(__dirname, '..', '..', 'limits', 'limiter.js')));
} catch {}

// ---------------------------------------------------------------- 区域

/**
 * 两个区域是两套完全独立的网关与登录接口，provider 名与 pi 里的一致。
 * baseUrl 末尾的斜杠是 Qoder 网关的写法（拼接时不加 /），保持原样。
 */
const REGIONS = {
  cn: {
    key: 'cn',
    title: 'Qoder 国内版',
    provider: 'qoder-cn',
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    machineOs: 'x86_64_windows',
  },
  global: {
    key: 'global',
    title: 'Qoder 国际版',
    provider: 'qoder',
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    machineOs: 'x86_64_windows',
  },
};

const REGION_ALIASES = { cn: 'cn', 'qoder-cn': 'cn', global: 'global', qoder: 'global' };

const HOME = os.homedir();
const PI_DIR = path.join(HOME, '.pi', 'agent');
const AUTH_JSON = path.join(PI_DIR, 'auth.json');
const DATA_DIR = path.join(HOME, '.qoder2pi');

// COSY 是 Qoder 网关的签名协议：网关只认带这套头的请求，缺一个都会被 WAF 挡掉。
const COSY_GATEWAY_VERSION = '1.1.38';
const COSY_OPENAPI_VERSION = '1.0.1';
const COSY_CLIENT_TYPE = '5';
const QODER_DATA_POLICY = 'disagree';
const QODER_LOGIN_VERSION = 'v2';
const QODER_MACHINE_TYPE = '5';

const QODER_RSAS_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const MAX_OUTPUT_TOKENS = 131072;
const DEFAULT_CONTEXT_WINDOW = 1000000;

// ---------------------------------------------------------------- 工具

const log = {
  info: (...a) => console.log('\x1b[1;36m==>\x1b[0m', ...a),
  ok: (...a) => console.log('\x1b[1;32m✓\x1b[0m', ...a),
  warn: (...a) => console.log('\x1b[1;33m!\x1b[0m', ...a),
  err: (...a) => console.error('\x1b[1;31m错误:\x1b[0m', ...a),
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonTight(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function machineOS() {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'aarch64_windows' : 'x86_64_windows';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64_darwin' : 'x86_64_darwin';
  return process.arch === 'arm64' ? 'aarch64_linux' : 'x86_64_linux';
}

/**
 * 机器指纹。优先用凭证里已经绑定的那个（Qoder 会把 token 与机器绑定，换一个
 * 指纹可能直接 401），其次用 Qoder 客户端落盘的，最后才自己生成并持久化。
 */
function resolveMachineId(creds) {
  if (creds && creds.machineID) return creds.machineID;
  const candidates = [
    path.join(HOME, '.qoder', '.auth', 'machine_id'),
    path.join(HOME, '.qoder-cn', '.auth', 'machine_id'),
    path.join(PI_DIR, 'qoder-machine-id'),
  ];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {
      // 没有就试下一个
    }
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(PI_DIR, { recursive: true });
    fs.writeFileSync(path.join(PI_DIR, 'qoder-machine-id'), id, 'utf8');
  } catch {
    // 写不进去也无所谓，本次进程内仍然可用
  }
  return id;
}

// ---------------------------------------------------------------- COSY 签名

function rsaEncryptBase64(data) {
  const key = { key: QODER_RSAS_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING };
  return crypto.publicEncrypt(key, Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('base64');
}

function aesEncryptCBCBase64(plaintext, keyStr) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr), Buffer.from(keyStr));
  let out = cipher.update(plaintext, 'utf8', 'base64');
  out += cipher.final('base64');
  return out;
}

/** 签名路径：网关只认去掉 /algo 前缀之后的 path。 */
function computeSigPath(urlStr) {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith('/algo')) sigPath = sigPath.slice('/algo'.length);
  return sigPath;
}

/**
 * 构造 Qoder 网关要求的整套请求头。
 *
 * 注意 body 必须传「实际发出去的字节」：签名里混了 body 的 md5，传原文而发编码后的
 * 内容会被判为篡改（网关返回 403 Request discarded）。
 */
function buildAuthHeaders(body, requestURL, creds) {
  if (!creds || !creds.userID) throw new Error('cosy: user id is empty');
  if (!creds.authToken) throw new Error('cosy: auth token is empty');

  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || '',
    aid: '',
    email: creds.email || '',
  };
  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const cosyPayload = {
    version: 'v1',
    requestId: crypto.randomUUID(),
    info: infoB64,
    cosyVersion: COSY_GATEWAY_VERSION,
    ideVersion: '',
  };
  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString('base64');
  const sigPath = computeSigPath(requestURL);
  const bodyBytes = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  const sig = crypto
    .createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(cosyKey)
    .update('\n')
    .update(timestamp)
    .update('\n')
    .update(bodyBytes)
    .update('\n')
    .update(sigPath)
    .digest('hex');

  const machineID = creds.machineID || resolveMachineId(creds);
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_GATEWAY_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': QODER_MACHINE_TYPE,
    'Cosy-Machineos': machineOS(),
    'Cosy-Clienttype': COSY_CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': crypto.createHash('md5').update(bodyBytes).digest('hex'),
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': QODER_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': QODER_LOGIN_VERSION,
    'X-Request-Id': crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------- body 编码

/**
 * Qoder 的 body 不是明文 JSON，而是「base64 之后按 1/3 长度做三段轮转」再换字母表。
 * 三段轮转：后 1/3 提到最前、中间 1/3 居中、前 1/3 放最后，然后用自定义字母表替换。
 * 少任何一步都会在服务端解出乱码，表现为 500 Internal Server Error。
 */
const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const encodeTable = new Uint8Array(256);
for (let i = 0; i < encodeTable.length; i++) encodeTable[i] = i;
for (let i = 0; i < QODER_STD_ALPHABET.length; i++) {
  encodeTable[QODER_STD_ALPHABET.charCodeAt(i)] = QODER_CUSTOM_ALPHABET.charCodeAt(i);
}
encodeTable['='.charCodeAt(0)] = '$'.charCodeAt(0);

function encodeQoderBody(plaintext) {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - a; i < n; i++) out[dst++] = encodeTable[std.charCodeAt(i)];
  for (let i = a; i < n - a; i++) out[dst++] = encodeTable[std.charCodeAt(i)];
  for (let i = 0; i < a; i++) out[dst++] = encodeTable[std.charCodeAt(i)];
  return out;
}

// ---------------------------------------------------------------- 思考标签

/**
 * 有的模型把思考内容塞在 content 里用 <thinking> 包起来（而不是走 reasoning_content）。
 * 这些标签对客户端是噪音，和 pi 一样剥掉；半截的标签也要处理，否则流式输出会闪。
 */
const THINKING_TAG_VARIANTS = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' },
  { open: '<reasoning>', close: '</reasoning>' },
  { open: '<thought>', close: '</thought>' },
];
const ALL_THINKING_TAGS = THINKING_TAG_VARIANTS.flatMap((v) => [v.open, v.close]);

const DSML_TAG = /<\/?[\uFF5C|]{0,2}\s*DSML\s*[\uFF5C|]{0,2}[^>]*>|<\/?(?:invoke|invocation|parameter|function_call|function_calls)\b[^>]*>/g;

function stripThinkingTags(text) {
  let out = text;
  for (const { open, close } of THINKING_TAG_VARIANTS) {
    if (open && out.includes(open)) out = out.split(open).join('');
    if (close && out.includes(close)) out = out.split(close).join('');
  }
  return out;
}

function stripDsmlResidue(text) {
  return text.replace(DSML_TAG, '').replace(/\n{3,}/g, '\n\n');
}

function trailingTagPrefixLength(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function maxTrailingPrefix(text, tags) {
  let out = 0;
  for (const tag of tags) out = Math.max(out, trailingTagPrefixLength(text, tag));
  return out;
}

/**
 * 流式剥离 <thinking> 标签：按块喂进来，返回 {text, thinking} 两路增量。
 * 结尾可能是半个标签，先扣住不发，等下一个块到了再判断——否则用户会看到
 * "<thin" 这种半截标记闪一下。
 */
class ThinkingTagSplitter {
  constructor() {
    this.buffer = '';
    this.inThinking = false;
    this.activeEnd = THINKING_TAG_VARIANTS[0].close;
  }

  push(chunk) {
    this.buffer += chunk;
    const out = { text: '', thinking: '' };
    let guard = 0;
    while (this.buffer.length > 0 && guard++ < 64) {
      if (this.inThinking) {
        const endPos = this.buffer.indexOf(this.activeEnd);
        if (endPos === -1) {
          const hold = trailingTagPrefixLength(this.buffer, this.activeEnd);
          const safe = this.buffer.length - hold;
          if (safe > 0) {
            out.thinking += this.buffer.slice(0, safe);
            this.buffer = this.buffer.slice(safe);
          }
          break;
        }
        out.thinking += this.buffer.slice(0, endPos);
        this.buffer = this.buffer.slice(endPos + this.activeEnd.length);
        this.inThinking = false;
        if (this.buffer.startsWith('\n\n')) this.buffer = this.buffer.slice(2);
        else if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1);
        continue;
      }
      let bestOpen = -1;
      let bestOpenVariant = null;
      for (const v of THINKING_TAG_VARIANTS) {
        const pos = this.buffer.indexOf(v.open);
        if (pos !== -1 && (bestOpen === -1 || pos < bestOpen)) {
          bestOpen = pos;
          bestOpenVariant = v;
        }
      }
      if (bestOpenVariant) {
        out.text += this.buffer.slice(0, bestOpen);
        this.buffer = this.buffer.slice(bestOpen + bestOpenVariant.open.length);
        this.activeEnd = bestOpenVariant.close;
        this.inThinking = true;
        continue;
      }
      const hold = maxTrailingPrefix(this.buffer, ALL_THINKING_TAGS);
      const safe = this.buffer.length - hold;
      if (safe > 0) {
        out.text += this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
      }
      break;
    }
    return out;
  }

  flush() {
    const rest = this.buffer;
    this.buffer = '';
    if (!rest) return { text: '', thinking: '' };
    return this.inThinking ? { text: '', thinking: rest } : { text: rest, thinking: '' };
  }
}

// ---------------------------------------------------------------- 凭证

/** 判断 auth.json 里那个 provider 条目是否可用：有 access 才算登录。 */
function readAuthEntry(provider) {
  const auth = readJson(AUTH_JSON);
  const entry = auth && auth[provider];
  if (!entry) return null;
  return entry.access ? entry : null;
}

function isPatRefresh(refresh) {
  return typeof refresh === 'string' && refresh.startsWith('pat|');
}

/** pi 把 PAT 登录的凭证编码成 `pat|pat|jobRefreshToken|userID|machineID`。 */
function decodePatRefresh(refresh) {
  const parts = String(refresh).split('|');
  return { pat: parts[1] || '', jobRefreshToken: parts[2] || '', userID: parts[3] || '', machineID: parts[4] || '' };
}

function encodePatRefresh(pat, jobRefreshToken, userID, machineID) {
  return ['pat', pat, jobRefreshToken, userID, machineID].join('|');
}

/**
 * 用 PAT 换 job token。这是 pi 侧登录时走的那条路径，接口是纯 HTTP，
 * 不需要 COSY 签名，所以凭证过期时最省事的续期方式就是拿 PAT 再换一次。
 */
async function exchangePat(region, pat) {
  const url = `${region.openApiUrl}/api/v1/jobToken/exchange`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'qoder-proxy',
      'Cosy-Version': COSY_OPENAPI_VERSION,
      'Cosy-ClientType': COSY_CLIENT_TYPE,
    },
    body: JSON.stringify({ personal_token: pat }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PAT 兑换失败：${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('PAT 兑换没有返回 job token');
  let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_in === 'number') {
    expiresAt = Date.now() + data.expires_in * 1000;
  }
  return { jobToken: data.token, jobRefreshToken: data.refresh_token || '', expiresAt };
}

/**
 * 用 device refresh token（drt-…）续期。
 *
 * 这条路径对应「浏览器 OAuth 登录」产生的凭证：pi 的 auth.json 里 refresh 是
 * `refreshToken|userID|machineID`。网关的 /algo/api/v3/user/refresh_token 会对
 * 直接调用返回 403，真正能用的是 openapi 上的 deviceToken/refresh。
 */
async function refreshDeviceToken(region, refreshToken) {
  const url = `${region.openApiUrl}/api/v1/deviceToken/refresh`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'qoder-proxy',
      'Cosy-Version': COSY_OPENAPI_VERSION,
      'Cosy-ClientType': COSY_CLIENT_TYPE,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`device token 续期失败：${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.device_token) throw new Error('device token 续期没有返回 device_token');
  let expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  }
  return {
    access: data.device_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
  };
}

/** 拿 openapi 的 userinfo，补全 userID / 名字 / 邮箱。失败不影响主流程。 */
async function fetchUserInfo(region, token) {
  try {
    const res = await fetch(`${region.openApiUrl}/api/v1/userinfo`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'qoder-proxy',
        'Cosy-Version': COSY_OPENAPI_VERSION,
        'Cosy-ClientType': COSY_CLIENT_TYPE,
      },
    });
    if (!res.ok) return null;
    const info = await res.json();
    return { userID: info.id || '', email: info.email || '', name: info.name || info.username || '' };
  } catch {
    return null;
  }
}

/**
 * 凭证缓存：一个进程里同一份凭证只解析一次，过期了才重新走网络。
 * 续期失败时先给 1 小时宽限（与 pi 的处理一致），避免每次请求都去打网关。
 */
class CredentialStore {
  constructor(region) {
    this.region = region;
    this.cached = null;
    this.inflight = null;
  }

  /** 从 auth.json 重新读一份，必要时续期。 */
  async resolve() {
    const entry = readAuthEntry(this.region.provider);
    if (!entry) {
      throw new Error(
        `未登录 ${this.region.title}。先在 pi 里登录（/login ${this.region.provider}），或运行 qoder2pi login ${this.region.key} pt-xxxxxx`,
      );
    }
    const expires = Number(entry.expires || 0);
    const usable = entry.access && (expires ? expires - Date.now() > 5 * 60 * 1000 : true);
    const creds = {
      access: entry.access,
      userID: entry.userID || '',
      name: entry.name || '',
      email: entry.email || '',
      machineID: entry.machineID || '',
      refresh: entry.refresh || '',
      expires,
    };
    if (usable) return creds;

    if (this.inflight) return this.inflight;
    this.inflight = this._refresh(creds).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async _refresh(creds) {
    const region = this.region;
    // 1) PAT 登录的凭证：直接拿 PAT 再换一次 job token
    if (isPatRefresh(creds.refresh)) {
      const { pat } = decodePatRefresh(creds.refresh);
      if (pat) {
        try {
          const r = await exchangePat(region, pat);
          const info = (await fetchUserInfo(region, r.jobToken)) || {};
          const next = {
            access: r.jobToken,
            userID: info.userID || creds.userID,
            name: info.name || creds.name,
            email: info.email || creds.email,
            machineID: creds.machineID || resolveMachineId(creds),
            refresh: encodePatRefresh(pat, r.jobRefreshToken, info.userID || creds.userID, creds.machineID || ''),
            expires: r.expiresAt - 5 * 60 * 1000,
          };
          this._persist(next);
          return next;
        } catch (err) {
          log.warn(`PAT 续期失败，继续用旧 token 试一次：${err.message}`);
        }
      }
    }

    // 2) 浏览器登录的凭证：refresh 是 refreshToken|userID|machineID
    const parts = String(creds.refresh).split('|');
    const deviceRefresh = parts[0] || '';
    if (deviceRefresh && !isPatRefresh(creds.refresh)) {
      try {
        const r = await refreshDeviceToken(region, deviceRefresh);
        const next = {
          ...creds,
          access: r.access,
          refresh: `${r.refreshToken}|${parts[1] || creds.userID}|${parts[2] || creds.machineID}`,
          expires: r.expiresAt - 5 * 60 * 1000,
        };
        this._persist(next);
        return next;
      } catch (err) {
        log.warn(`device token 续期失败，继续用旧 token 试一次：${err.message}`);
      }
    }

    // 3) 都不成：把旧 token 的寿命往后推 1 小时，等用户自己去重新登录
    log.warn(`${region.title} 的凭证无法续期，先沿用旧 token（过期后请重新登录）`);
    return { ...creds, expires: Date.now() + 60 * 60 * 1000 };
  }

  /**
   * 写回 auth.json，让 pi 与 opencode 共用同一份新鲜凭证。
   * 只覆盖本 provider 那一项，别的 provider（WorkBuddy、siliconflow 等）原样保留。
   */
  _persist(next) {
    try {
      const auth = readJson(AUTH_JSON) || {};
      auth[this.region.provider] = { type: 'oauth', ...next };
      writeJsonTight(AUTH_JSON, auth);
    } catch (err) {
      log.warn(`写回 auth.json 失败：${err.message}`);
    }
  }
}

// ---------------------------------------------------------------- 模型目录

/**
 * 模型目录来自网关的 model/list。缓存到 ~/.qoder2pi/models-<region>.json，
 * 一小时内不重复拉取——这个接口要签名，每次都打一遍没必要。
 *
 * id 用 display_name 去掉空白（与 pi 侧一致，比如 "Qwen3.8-Max" → "Qwen3.8-Max"），
 * 同时接受上游 key（qmodel / dmodel / …），方便用户直接写 key。
 */
const MODEL_CACHE_TTL = 60 * 60 * 1000;

// 拉不到目录时的兜底。不是硬编码的全部（网关随时会变），只保证客户端至少能选到东西。
const FALLBACK_MODELS = {
  cn: [
    { id: 'Auto', key: 'auto', name: 'Auto', reasoning: true, vision: true },
    { id: 'Qwen3.8-Max', key: 'qmodel_38max', name: 'Qwen3.8-Max', reasoning: true, vision: true },
    { id: 'Qwen3.8-Flash', key: 'qfmodel', name: 'Qwen3.8-Flash', reasoning: true, vision: true },
    { id: 'DeepSeek-V4-Pro', key: 'dmodel', name: 'DeepSeek-V4-Pro', reasoning: true, vision: true },
    { id: 'DeepSeek-Flash', key: 'dfmodel', name: 'DeepSeek-Flash', reasoning: false, vision: true },
    { id: 'GLM-5.3', key: 'gmodel', name: 'GLM-5.3', reasoning: true, vision: true },
    { id: 'GLM-5.3-Flash', key: 'gfmodel', name: 'GLM-5.3-Flash', reasoning: true, vision: true },
    { id: 'Kimi-K3.1-Pro', key: 'kmodel_latest', name: 'Kimi-K3.1-Pro', reasoning: false, vision: true },
    { id: 'Kimi-K2.8-Preview', key: 'kmodel', name: 'Kimi-K2.8-Preview', reasoning: true, vision: true },
    { id: 'MiniMax-M3.1-Flash', key: 'mmodel', name: 'MiniMax-M3.1-Flash', reasoning: true, vision: true },
  ],
  global: [
    { id: 'Auto', key: 'auto', name: 'Auto', reasoning: true, vision: true },
    { id: 'Ultimate', key: 'ultimate', name: 'Ultimate', reasoning: true, vision: true },
    { id: 'Performance', key: 'performance', name: 'Performance', reasoning: true, vision: true },
    { id: 'Efficient', key: 'efficient', name: 'Efficient', reasoning: false, vision: true },
    { id: 'Lite', key: 'lite', name: 'Lite', reasoning: false, vision: false },
    { id: 'Qwen3.8-Max', key: 'qmodel_preview', name: 'Qwen3.8-Max', reasoning: true, vision: true },
    { id: 'Qwen3.7-Max', key: 'qmodel_latest', name: 'Qwen3.7-Max', reasoning: false, vision: true },
    { id: 'DeepSeek-V4-Pro', key: 'dmodel', name: 'DeepSeek-V4-Pro', reasoning: true, vision: true },
    { id: 'DeepSeek-V4-Flash', key: 'dfmodel', name: 'DeepSeek-V4-Flash', reasoning: true, vision: true },
    { id: 'GLM-5.2', key: 'gm51model', name: 'GLM-5.2', reasoning: true, vision: true },
    { id: 'Kimi-K3', key: 'kmodel_latest', name: 'Kimi-K3', reasoning: true, vision: true },
    { id: 'MiniMax-M3', key: 'mmodel', name: 'MiniMax-M3', reasoning: true, vision: true },
  ],
};

function modelIdFromDisplay(displayName) {
  return String(displayName || 'QoderModel').replace(/\s+/g, '');
}

function contextWindowFromCatalog(entry) {
  const cfg = entry && entry.context_config;
  if (cfg && typeof cfg === 'object') {
    let advertised = 0;
    for (const value of Object.values(cfg)) {
      if (value && typeof value === 'object' && typeof value.token_count === 'number') {
        advertised = Math.max(advertised, value.token_count);
      }
    }
    if (advertised > 0) return advertised;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** 网关的 thinking_config 有两种写法：只给 enabled，或给 enabled.efforts 的白名单。 */
function thinkingLevels(entry) {
  const tc = entry && entry.thinking_config;
  if (!tc) return { supported: false, efforts: [], defaultEnabled: false };
  const efforts = tc.enabled && typeof tc.enabled === 'object' && tc.enabled.efforts ? Object.keys(tc.enabled.efforts) : [];
  return {
    supported: !!tc.enabled,
    efforts,
    defaultEnabled: !!(tc.enabled && tc.enabled.is_default),
    canDisable: !!tc.disabled,
  };
}

/** 把网关目录条目规整成代理内部使用的模型描述。 */
function normalizeCatalogEntry(entry) {
  if (!entry || !entry.key || !entry.enable || !entry.display_name) return null;
  const id = modelIdFromDisplay(entry.display_name);
  const think = thinkingLevels(entry);
  return {
    id,
    key: entry.key,
    name: entry.display_name,
    reasoning: !!entry.is_reasoning || !!entry.thinking_config,
    vision: !!entry.is_vl,
    contextWindow: contextWindowFromCatalog(entry),
    maxTokens: MAX_OUTPUT_TOKENS,
    efforts: think.efforts,
    thinkingSupported: think.supported,
    canDisableThinking: think.canDisable,
    defaultThinking: think.defaultEnabled,
    raw: entry,
  };
}

function cachePath(region) {
  return path.join(DATA_DIR, `models-${region.key}.json`);
}

class ModelCatalog {
  constructor(region, credsStore) {
    this.region = region;
    this.creds = credsStore;
    this.models = null;
    this.updatedAt = 0;
    this.inflight = null;
  }

  /** 缓存优先；缓存过期就重拉，拉失败退回缓存，再退回兜底表。 */
  async list({ force = false } = {}) {
    if (!force && this.models && Date.now() - this.updatedAt < MODEL_CACHE_TTL) return this.models;
    if (!force) {
      const disk = readJson(cachePath(this.region));
      if (disk && Array.isArray(disk.models) && Array.isArray(disk.models) && typeof disk.updatedAt === 'number') {
        if (Date.now() - disk.updatedAt < MODEL_CACHE_TTL) {
          this.models = disk.models;
          this.updatedAt = disk.updatedAt;
          return this.models;
        }
      }
    }
    if (this.inflight) return this.inflight;
    this.inflight = this._fetch()
      .catch((err) => {
        log.warn(`拉取模型目录失败：${err.message}`);
        return null;
      })
      .then((models) => {
        this.inflight = null;
        if (models && models.length) {
          this.models = models;
          this.updatedAt = Date.now();
          try {
            writeJsonTight(cachePath(this.region), { updatedAt: this.updatedAt, models: models.map((m) => ({ ...m, raw: undefined })) });
          } catch {
            // 缓存写不进去不影响本次使用
          }
          return models;
        }
        if (this.models) return this.models;
        const fallback = (FALLBACK_MODELS[this.region.key] || []).map((m) => ({
          ...m,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: MAX_OUTPUT_TOKENS,
          efforts: [],
          thinkingSupported: m.reasoning,
          canDisableThinking: true,
          defaultThinking: m.reasoning,
        }));
        this.models = fallback;
        this.updatedAt = Date.now();
        return fallback;
      });
    return this.inflight;
  }

  async _fetch() {
    const creds = await this.creds.resolve();
    const url = `${this.region.baseUrl}algo/api/v2/model/list?Encode=1`;
    const headers = buildAuthHeaders(null, url, {
      userID: creds.userID,
      authToken: creds.access,
      name: creds.name,
      email: creds.email,
      machineID: creds.machineID,
    });
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    const chat = Array.isArray(data.chat) ? data.chat : [];
    return chat.map(normalizeCatalogEntry).filter(Boolean);
  }

  /** 客户端可能发 display id、也可能发上游 key（大小写不敏感）。 */
  find(modelId) {
    const wanted = String(modelId || '').trim().toLowerCase();
    if (!wanted) return null;
    const models = this.models || [];
    return (
      models.find((m) => m.id.toLowerCase() === wanted) ||
      models.find((m) => m.key.toLowerCase() === wanted) ||
      models.find((m) => m.name.toLowerCase() === wanted) ||
      models.find((m) => m.id.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted.replace(/[^a-z0-9]/g, '')) ||
      null
    );
  }
}

// ---------------------------------------------------------------- 请求转换

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * OpenAI 的 messages → Qoder 的 messages。
 *
 * 三个要点：
 *   - system 单独抽出来，作为 messages 里第一条 role:system（Qoder 忽略顶层 system 字段）
 *   - assistant 的 tool_calls 要保留，否则多轮工具调用会断
 *   - tool 结果按 tool_call_id 回填
 */
function toQoderMessages(messages) {
  const systemParts = [];
  const out = [];
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = contentToText(msg.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const parts = msg.content
          .map((part) => {
            if (!part) return null;
            if (part.type === 'text') return { type: 'text', text: part.text || '' };
            if (part.type === 'image_url' || part.type === 'input_image') {
              const url = part.image_url && part.image_url.url ? part.image_url.url : part.image_url || part.image || '';
              return url ? { type: 'image_url', image_url: { url } } : null;
            }
            return null;
          })
          .filter(Boolean);
        out.push({ role: 'user', content: parts.length ? parts : contentToText(msg.content) });
      } else {
        out.push({ role: 'user', content: contentToText(msg.content) });
      }
      continue;
    }
    if (msg.role === 'assistant') {
      const text = contentToText(msg.content);
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
            .filter((tc) => tc && tc.function)
            .map((tc) => ({
              id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments || {}),
              },
            }))
        : [];
      const mapped = { role: 'assistant', content: text || (toolCalls.length ? ' ' : null) };
      if (msg.reasoning_content) mapped.reasoning_content = msg.reasoning_content;
      if (toolCalls.length) mapped.tool_calls = toolCalls;
      out.push(mapped);
      continue;
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id || msg.toolCallId || '',
        content: contentToText(msg.content),
      });
      continue;
    }
  }
  const systemText = systemParts.join('\n\n');
  if (systemText) out.unshift({ role: 'system', content: systemText });
  return out;
}

function toQoderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .filter((t) => t && (t.type === 'function' || t.function || t.name))
    .map((t) => {
      const fn = t.function || t;
      return {
        type: 'function',
        function: {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
        },
      };
    });
}

/** 稳定的 chat_record_id：同样的对话前缀得同一个 id，服务端才能命中缓存。 */
function stableHash(prefix, ...inputs) {
  const hash = crypto.createHash('sha256');
  hash.update(prefix);
  for (const input of inputs) {
    hash.update('\0');
    hash.update(String(input));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * 决定思考开关与强度。
 *
 * 优先级：请求里的 reasoning_effort > 模型默认 > 关。
 * opencode 走 @ai-sdk/openai-compatible，会把 reasoningEffort 变成 reasoning_effort；
 * 有的客户端什么都不发，这时按目录里的 is_default 决定。
 */
function resolveThinking(model, body) {
  const effortRaw = body.reasoning_effort || (body.reasoning && body.reasoning.effort) || null;
  const explicitOff = body.enable_thinking === false || effortRaw === 'none' || effortRaw === 'off';
  if (explicitOff) return { enable: false, effort: null };
  if (!model.reasoning && !model.thinkingSupported) return { enable: false, effort: null };

  let enable = body.enable_thinking === true || model.defaultThinking || model.reasoning;
  if (effortRaw && effortRaw !== 'none' && effortRaw !== 'off') enable = true;
  if (!enable) return { enable: false, effort: null };

  // effort 只在模型真的支持时下发，否则网关会挑一个它自己认的默认值
  let effort = null;
  if (effortRaw && effortRaw !== 'none' && effortRaw !== 'off') {
    if (model.efforts && model.efforts.length) {
      effort = model.efforts.includes(effortRaw) ? effortRaw : null;
    } else {
      effort = effortRaw;
    }
  }
  return { enable: true, effort };
}

/** OpenAI 请求 → Qoder agent_chat_generation 的 body。 */
function buildQoderRequest({ body, model, messages, tools }) {
  const thinking = resolveThinking(model, body);
  let maxTokens = MAX_OUTPUT_TOKENS;
  const wanted = body.max_tokens || body.max_completion_tokens || (body.stream_options && body.stream_options.max_tokens);
  if (typeof wanted === 'number' && wanted > 0 && wanted < maxTokens) maxTokens = Math.floor(wanted);

  const parameters = { max_tokens: maxTokens, enable_thinking: thinking.enable };
  if (thinking.enable && thinking.effort) parameters.reasoning_effort = thinking.effort;

  const qoderMessages = toQoderMessages(messages);
  const qoderTools = toQoderTools(tools);

  const lastUser = [...qoderMessages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser ? contentToText(lastUser.content) : '';
  const recordId = stableHash('qoder-record', model.key, JSON.stringify(qoderMessages), JSON.stringify(qoderTools), maxTokens);
  const sessionId = `${stableHash('qoder-session', model.key, lastUserText.slice(0, 200))}-${crypto.randomUUID()}`;

  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true, // 网关只支持流式；非流式由代理自己聚合
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages: qoderMessages,
    tools: qoderTools,
    parameters,
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model.key, is_reasoning: model.reasoning },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: model.raw && model.raw.thinking_config ? model.raw : { key: model.key, is_reasoning: model.reasoning, source: 'system' },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: crypto.randomUUID(),
      name: lastUserText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

// ---------------------------------------------------------------- SSE 解析

/**
 * Qoder 的 SSE 是「信封套信封」：外层 `data: {"headers":…,"body":"<内层 JSON 字符串>"}`，
 * 内层才是 OpenAI 形状的 chunk。这里把外层拆掉，只留内层。
 *
 * 顺带处理两种异常：
 *   - statusCodeValue 非 200：抛错（否则会被当成正常空回复）
 *   - 内层解析失败：跳过这一行，不要中断整个流
 */
function parseQoderSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { done: true };
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return null;
  }
  if (envelope && typeof envelope.statusCodeValue === 'number' && envelope.statusCodeValue !== 200) {
    // 注意：HTTP 状态码是 200，错误藏在信封里。所以「排队」也是从这里出来的——
    // 只检查 response.ok 是看不到它的，必须解析信封的 statusCodeValue。
    const info = upstreamError(envelope.statusCodeValue, envelope.body);
    return {
      error: info.message,
      retryable: info.retryable,
      businessStatus: info.status,
      retryAfter: info.retryAfter || null,
    };
  }
  if (!envelope || envelope.body === undefined || envelope.body === null) return null;
  if (envelope.body === '[DONE]') return { done: true };
  let inner;
  try {
    inner = JSON.parse(envelope.body);
  } catch {
    return null;
  }
  return { chunk: inner };
}

// ---------------------------------------------------------------- 上游错误

/**
 * 把 Qoder 上游的失败响应变成客户端能理解的错误。
 *
 * 关键是识别「排队中」：免费账号并发受限时会返回 HTTP 403 + 业务码 10605 +
 * `isQueued: true`。这**不是权限问题**，隔十几秒重试就能成功。如果当成普通 403
 * 透给客户端，用户会去改配置、重新登录，全都是白费功夫（见 docs/02-pitfalls.md P16）。
 *
 * 返回 { status, retryable, message }：
 *   - retryable=true 时给 429（客户端与 OpenAI SDK 都认这个码，会自动重试）
 *   - 其它情况保留原状态码，但把嵌套 JSON 里的业务码与说明提出来
 */
function upstreamError(status, text) {
  const raw = String(text || '');

  // 上游的 body 是嵌套 JSON：{"code":"403","message":"{\"code\":\"10605\",...}"}
  // 这里做有限层解包，只为了拿到业务码与 isQueued
  let business = null;
  let probe = raw;
  for (let depth = 0; depth < 3; depth++) {
    try {
      const j = JSON.parse(probe);
      if (j && typeof j === 'object') {
        if (j.code || j.isQueued) business = j;
        probe = j.message || j.msg || '';
        if (!probe) break;
      } else break;
    } catch {
      break;
    }
  }

  const code = business && business.code ? String(business.code) : '';
  const queued = /"isQueued"\s*:\s*true/.test(raw) || (business && business.isQueued === true);

  if (queued || code === '10605') {
    // 上游会带 retryAfterSeconds / waitTime，有就照抄——客户端据此决定等多久，
    // 比我们自己拍一个数字准。
    const retryAfter =
      (business && (business.retryAfterSeconds || business.waitTime)) || 30;
    const available = business && business.serviceAvailable === false;
    return {
      status: 429,
      retryable: true,
      retryAfter,
      message:
        `Qoder 排队中（免费账号并发受限，业务码 10605${available ? '，当前服务不可用' : ''}）。` +
        `这不是权限问题：等约 ${retryAfter} 秒重试即可。`,
    };
  }

  const short = raw.replace(/\s+/g, ' ').slice(0, 300);
  return {
    status: status || 500,
    retryable: status === 429 || status === 503,
    message: `Qoder 上游返回 ${status}${code ? `（业务码 ${code}）` : ''}：${short}`,
  };
}

// ---------------------------------------------------------------- 服务

function openAiModelEntry(model) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: 'qoder',
    name: model.name,
    // opencode 读 limit 决定上下文窗口与输出上限；非 opencode 客户端会忽略
    limit: { context: model.contextWindow, output: model.maxTokens },
    capabilities: { vision: !!model.vision, reasoning: !!model.reasoning },
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function openAiError(res, status, message, type = 'invalid_request_error', retryAfter = null) {
  const body = JSON.stringify({ error: { message, type, code: status } });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  // 429 带上 Retry-After：OpenAI SDK 与多数客户端会照它决定重试间隔
  if (retryAfter && status === 429) headers['Retry-After'] = String(retryAfter);
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * 核心：把 Qoder 的流翻译成 OpenAI 的流。
 *
 * 中途会做的事：
 *   - 剥 <thinking> 标签（有的模型把思考塞在 content 里）
 *   - 剥 DSML 残渣（工具调用失败时模型会吐出这种标记，直接透给客户端会污染上下文）
 *   - 记住 tool_call 的 id：Qoder 只在第一个 delta 里给 id，后面只给 index
 */
async function streamChat({ region, creds, model, qoderBody, res, onUsage }) {
  const chatURL = `${region.baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  const encoded = encodeQoderBody(Buffer.from(JSON.stringify(qoderBody)));
  const headers = buildAuthHeaders(encoded, chatURL, {
    userID: creds.userID,
    authToken: creds.access,
    name: creds.name,
    email: creds.email,
    machineID: creds.machineID,
  });

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);

  const upstream = await fetch(chatURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': model.key,
      'X-Model-Source': (model.raw && model.raw.source) || 'system',
      ...headers,
    },
    body: encoded,
    signal: controller.signal,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const info = upstreamError(upstream.status, text);
    const err = new Error(info.message);
    err.status = info.status;
    err.retryable = info.retryable;
    throw err;
  }
  if (!upstream.body) throw new Error('Qoder 上游没有返回响应体');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = model.id;

  const emit = (delta, finishReason) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  const emitUsage = (usage) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [],
      usage,
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  emit({ role: 'assistant', content: '' }, null);

  const splitter = new ThinkingTagSplitter();
  const toolStates = new Map();
  let usage = null;
  let finishReason = null;
  let reasoningStarted = false;
  let textStarted = false;
  let sawDone = false;
  let buffer = '';

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  const handleInner = (inner) => {
    if (!inner) return;
    if (inner.usage) {
      const u = inner.usage;
      usage = {
        prompt_tokens: u.prompt_tokens || 0,
        completion_tokens: u.completion_tokens || 0,
        total_tokens: u.total_tokens || u.prompt_tokens + u.completion_tokens || 0,
        prompt_tokens_details: {
          cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
        },
        completion_tokens_details: {
          reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
        },
      };
      if (onUsage) onUsage(usage, inner.usage);
    }
    const choices = inner.choices || [];
    if (!choices.length) return;
    const choice = choices[0];
    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      const cleaned = stripDsmlResidue(stripThinkingTags(delta.reasoning_content));
      if (cleaned) {
        reasoningStarted = true;
        emit({ reasoning_content: cleaned }, null);
      }
    }

    if (typeof delta.content === 'string' && delta.content) {
      const split = splitter.push(delta.content);
      if (split.thinking) {
        reasoningStarted = true;
        emit({ reasoning_content: stripDsmlResidue(split.thinking) }, null);
      }
      if (split.text) {
        textStarted = true;
        emit({ content: split.text }, null);
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        let state = toolStates.get(index);
        if (!state) {
          state = { id: '', name: '', args: '', announced: false };
          toolStates.set(index, state);
        }
        if (tc.id) state.id = tc.id;
        if (tc.function && tc.function.name) state.name = tc.function.name;
        if (!state.id) state.id = `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        if (!state.announced && state.name) {
          state.announced = true;
          emit(
            {
              tool_calls: [
                {
                  index,
                  id: state.id,
                  type: 'function',
                  function: { name: state.name, arguments: '' },
                },
              ],
            },
            null,
          );
        }
        const argsDelta = tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
        if (argsDelta) {
          state.args += argsDelta;
          emit(
            {
              tool_calls: [
                {
                  index,
                  id: state.id,
                  type: 'function',
                  function: { arguments: argsDelta },
                },
              ],
            },
            null,
          );
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        const parsed = parseQoderSseLine(line);
        if (parsed) {
          if (parsed.done) {
            sawDone = true;
            break;
          }
          if (parsed.error) {
            const err = new Error(parsed.error);
            err.retryable = !!parsed.retryable;
            err.retryAfter = parsed.retryAfter || null;
            if (parsed.businessStatus) err.status = parsed.businessStatus;
            throw err;
          }
          if (parsed.chunk) handleInner(parsed.chunk);
        }
        lineEnd = buffer.indexOf('\n');
      }
    }

    // 收尾：可能还有半截标签或未闭合的思考块
    const tail = splitter.flush();
    if (tail.thinking) {
      reasoningStarted = true;
      emit({ reasoning_content: stripDsmlResidue(tail.thinking) }, null);
    }
    if (tail.text) {
      textStarted = true;
      emit({ content: tail.text }, null);
    }

    // 没收到 finish_reason 时按有没有工具调用补一个，客户端才知道该停下
    if (!finishReason) finishReason = toolStates.size > 0 ? 'tool_calls' : 'stop';
    const mappedFinish = finishReason === 'tool_calls' || finishReason === 'function_call' ? 'tool_calls' : finishReason;

    emit({}, mappedFinish);
    if (usage) emitUsage(usage);
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已经读完了，取消失败无所谓
    }
    res.off('close', abort);
  }
}

/** 非流式请求：把上面的流聚合成一条完整的 chat.completion。 */
async function collectChat({ region, creds, model, qoderBody }) {
  const chatURL = `${region.baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  const encoded = encodeQoderBody(Buffer.from(JSON.stringify(qoderBody)));
  const headers = buildAuthHeaders(encoded, chatURL, {
    userID: creds.userID,
    authToken: creds.access,
    name: creds.name,
    email: creds.email,
    machineID: creds.machineID,
  });
  const upstream = await fetch(chatURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': model.key,
      'X-Model-Source': (model.raw && model.raw.source) || 'system',
      ...headers,
    },
    body: encoded,
    // 非流式是「等上游把整条流读完再聚合」，排队时上游可能迟迟不吐字节；
    // 不给信号的话这个请求会一直挂着，客户端只看到连接被重置
    signal: AbortSignal.timeout(180000),
  });
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const info = upstreamError(upstream.status, text);
    const err = new Error(info.message);
    err.status = info.status;
    err.retryable = info.retryable;
    throw err;
  }
  // 边读边解析：不能等整条流读完再判断。
  //
  // 排队错误藏在 SSE 信封里（HTTP 状态是 200），而排队时上游可能长时间不吐字节。
  // 用 upstream.text() 会一直等到超时，客户端只看到断连；改成逐行读，信封一出现
  // statusCodeValue != 200 就立刻抛出，用户马上拿到「排队中，请重试」。
  let raw = '';
  {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const parsed = parseQoderSseLine(line);
        if (parsed && parsed.error) {
          const err = new Error(parsed.error);
          err.retryable = !!parsed.retryable;
          err.retryAfter = parsed.retryAfter || null;
          if (parsed.businessStatus) err.status = parsed.businessStatus;
          try { await reader.cancel(); } catch {}
          throw err;
        }
        if (parsed && parsed.done) { done = true; break; }
        raw += `${line}
`;
        nl = buffer.indexOf('\n');
      }
      if (done) break;
    }
    if (buffer) raw += buffer;
    try { await reader.cancel(); } catch {}
  }

  let content = '';
  let reasoning = '';
  const toolCalls = new Map();
  let usage = null;
  let finishReason = null;

  for (const line of raw.split('\n')) {
    const parsed = parseQoderSseLine(line);
    if (!parsed || parsed.done) continue;
    if (parsed.error) {
      const err = new Error(parsed.error);
      err.retryable = !!parsed.retryable;
      if (parsed.businessStatus) err.status = parsed.businessStatus;
      throw err;
    }
    const inner = parsed.chunk;
    if (!inner) continue;
    if (inner.usage) {
      const u = inner.usage;
      usage = {
        prompt_tokens: u.prompt_tokens || 0,
        completion_tokens: u.completion_tokens || 0,
        total_tokens: u.total_tokens || 0,
        prompt_tokens_details: { cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 },
        completion_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
      };
    }
    const choice = (inner.choices || [])[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.reasoning_content) reasoning += stripDsmlResidue(stripThinkingTags(delta.reasoning_content));
    if (typeof delta.content === 'string') {
      const split = new ThinkingTagSplitter();
      const out = split.push(delta.content);
      const rest = split.flush();
      if (out.thinking || rest.thinking) reasoning += stripDsmlResidue(out.thinking + rest.thinking);
      content += out.text + rest.text;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        let state = toolCalls.get(index);
        if (!state) {
          state = { id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: '', args: '' };
          toolCalls.set(index, state);
        }
        if (tc.id) state.id = tc.id;
        if (tc.function && tc.function.name) state.name = tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') state.args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const calls = [...toolCalls.values()].filter((c) => c.name);
  const mappedFinish = finishReason === 'tool_calls' || finishReason === 'function_call' ? 'tool_calls' : finishReason || (calls.length ? 'tool_calls' : 'stop');
  const message = { role: 'assistant', content: content || (calls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) {
    message.tool_calls = calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
  }
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message, finish_reason: mappedFinish }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------- HTTP 路由

function createServer({ regionKey, verbose = false, logFile = null }) {
  const region = REGIONS[regionKey];
  if (!region) throw new Error(`未知区域：${regionKey}`);
  const credsStore = new CredentialStore(region);
  const catalog = new ModelCatalog(region, credsStore);
  const LIMITER =
    createLimiterFor && String(process.env.QODER_LIMITS || '').toLowerCase() !== 'off'
      ? createLimiterFor(region.provider)
      : null;

  const writeLog = (line) => {
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 日志写不进去不该影响请求
    }
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (verbose) log.info(`${req.method} ${pathname}`);
    writeLog(`${req.method} ${pathname}`);

    try {
      // ---- 健康检查：插件与运维命令靠它判断服务在不在
      if (pathname === '/health' || pathname === '/v1/health') {
        return json(res, 200, {
          status: 'ok',
          region: region.key,
          provider: region.provider,
          pid: process.pid,
          limits: LIMITER ? LIMITER.snapshot() : null,
        });
      }

      // ---- 模型列表
      if (pathname === '/v1/models' || pathname === '/models') {
        const models = await catalog.list({ force: url.searchParams.get('refresh') === '1' });
        return json(res, 200, { object: 'list', data: models.map(openAiModelEntry) });
      }

      // ---- 对话
      if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') {
        if (req.method !== 'POST') return openAiError(res, 405, '只支持 POST');
        const body = await readJsonBody(req);
        if (!body) return openAiError(res, 400, '请求体不是合法 JSON');
        const messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return openAiError(res, 400, 'messages 必须是非空数组');
        }
        // 第一次请求时目录可能还没拉过；模型名要靠它解析上游 key
        await catalog.list();
        const model = catalog.find(body.model) || catalog.find('auto') || (catalog.models || [])[0];
        if (!model) return openAiError(res, 400, `未知模型：${body.model}`);

        // 本地限流：执行位一直占到流结束（docs/02-pitfalls P31）。
        let release = null;
        if (LIMITER) {
          try {
            release = await LIMITER.acquire({ maxWaitMs: 5000 });
          } catch (err) {
            if (err instanceof LimiterBusy) {
              const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
              return openAiError(
                res,
                429,
                `本地限流：${seconds} 秒后重试（${LIMITER.limits.rpm}/分钟，并发 ${LIMITER.limits.concurrency}）`,
                'qoder_rate_limited',
                seconds,
              );
            }
            throw err;
          }
        }

        try {
          const creds = await credsStore.resolve();
          const qoderBody = buildQoderRequest({ body, model, messages, tools: body.tools });

          if (body.stream === false) {
            const result = await collectChat({ region, creds, model, qoderBody });
            writeLog(`POST chat model=${model.id} non-stream ${Date.now() - started}ms`);
            return json(res, 200, result);
          }
          await streamChat({ region, creds, model, qoderBody, res });
          writeLog(`POST chat model=${model.id} stream ${Date.now() - started}ms`);
          return;
        } finally {
          if (release) release();
        }
      }

      // ---- 兼容少数客户端会打的端点，至少别 404 得莫名其妙
      if (pathname === '/' || pathname === '/v1') {
        return json(res, 200, {
          object: 'qoder-proxy',
          region: region.key,
          provider: region.provider,
          endpoints: ['/v1/models', '/v1/chat/completions', '/health'],
        });
      }

      return openAiError(res, 404, `没有这个端点：${pathname}`);
    } catch (err) {
      // 超时（AbortSignal.timeout）与网络错误要变成可读信息，否则客户端只看到断连。
      // 排队/超时统一给 429，客户端与 OpenAI SDK 会自动重试。
      const timedOut =
        (err && err.name === 'TimeoutError') ||
        (err && err.name === 'AbortError') ||
        /aborted due to timeout|operation was aborted/i.test(err && err.message ? err.message : '');
      const status = timedOut ? 429 : err && err.status ? err.status : 500;
      const message = timedOut
        ? 'Qoder 上游超时（可能正在排队或负载高）。等 10~30 秒重试即可。'
        : err && err.message
          ? err.message
          : String(err);
      log.err(message);
      writeLog(`ERROR ${message}`);
      if (!res.headersSent) {
        return openAiError(res, status, message, 'upstream_error', err && err.retryAfter);
      }
      try {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.end();
      } catch {
        // 连接已经断了
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, catalog, credsStore, region };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // 图片走 base64 会很大，给到 64MB；再大就不像正常请求了
      if (size > 64 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 入口

function parseArgs(argv) {
  const opts = { region: 'cn', port: null, verbose: false, printPort: false, logFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--region') opts.region = REGION_ALIASES[(argv[++i] || '').toLowerCase()] || 'cn';
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--print-port') opts.printPort = true;
    else if (a === '--log-file') opts.logFile = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const USAGE = `qoder-proxy — 把 Qoder 额度暴露成 OpenAI 兼容端点

用法：
  qoder-proxy --region <cn|global> [--port 8789] [--verbose] [--log-file <path>]

端点：
  GET  /health               健康检查（运维命令与 opencode 插件用它判断服务在不在）
  GET  /v1/models            模型列表（来自 Qoder 网关，缓存一小时）
  POST /v1/chat/completions  OpenAI 兼容对话（支持流式与工具调用）

凭证来自 pi 的 ~/.pi/agent/auth.json，与 pi 共用同一份登录态；过期会自动续期。
区域：cn（qoder-cn，默认端口 8789）、global（qoder，默认端口 8790）。`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const regionKey = opts.region;
  const defaultPort = regionKey === 'cn' ? 8789 : 8790;
  const port = typeof opts.port === 'number' && !Number.isNaN(opts.port) ? opts.port : defaultPort;

  const { server, region } = createServer({ regionKey, verbose: opts.verbose, logFile: opts.logFile });

  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    if (opts.printPort) {
      // 只输出端口，方便脚本/测试取
      process.stdout.write(`${actual}\n`);
    } else {
      log.ok(`${region.title} 的 OpenAI 兼容端点在 http://127.0.0.1:${actual}/v1`);
    }
    if (opts.verbose) log.info(`pid ${process.pid}，凭证 ${AUTH_JSON}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.err(`端口 ${port} 已被占用。先停掉旧实例：qoder2pi proxy stop ${regionKey}`);
    } else {
      log.err(err.message);
    }
    process.exit(1);
  });

  const shutdown = () => {
    log.info('正在关闭…');
    server.close(() => process.exit(0));
    // 有长连接（SSE）时 close 不会立刻回调，给一个兜底
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  REGIONS,
  REGION_ALIASES,
  encodeQoderBody,
  computeSigPath,
  buildAuthHeaders,
  buildQoderRequest,
  toQoderMessages,
  toQoderTools,
  resolveThinking,
  parseQoderSseLine,
  ThinkingTagSplitter,
  normalizeCatalogEntry,
  modelIdFromDisplay,
  openAiModelEntry,
  upstreamError,
  FALLBACK_MODELS,
  createServer,
};

if (require.main === module) {
  main().catch((err) => {
    log.err(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
