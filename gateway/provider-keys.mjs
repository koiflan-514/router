/**
 * 免费供应商的凭据存储。
 *
 * 这些 key 和网关自己的 `zsk_` 密钥不是一回事：
 *   - `zsk_` 是**别人访问本网关**的凭据（我们签发、只存 SHA-256）；
 *   - 这里的 key 是**本网关访问上游**的凭据（上游签发、我们必须能读回明文）。
 *
 * 所以不能哈希，只能加密或明文存放。三档，按可用性依次退化：
 *
 *   1. `ROUTER_PROVIDER_KEY_<ID>` 环境变量（最高优先，不落盘）
 *   2. `gateway/data/providers.json`，用本机密钥加密（AES-256-GCM）
 *   3. `gateway/data/providers.json` 明文（加密不可用时）
 *
 * 第 2 档的密钥从 `data/.vault-key` 读，首次使用时生成 32 字节随机值并设成
 * 0600。它和密文放在同一个目录里，**这不是防入侵**——目的是防止「把 data 目录
 * 误提交/误打包/误发群」时 key 直接可读。真正的隔离靠 `.gitignore` 与文件权限。
 *
 * 这个取舍要写清楚，否则会给人「已经安全了」的错觉：同一个目录里的密钥只能防
 * 意外泄露，防不住能读文件的人。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson, writeJsonAtomic } from './config.mjs';
import { BY_ID, FREE_PROVIDERS, resolveBaseUrl } from './free-providers.mjs';

export const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const VAULT_KEY_FILE = path.join(DATA_DIR, '.vault-key');
const ALGO = 'aes-256-gcm';

/** 环境变量名：`ROUTER_PROVIDER_KEY_OPENCODE_ZEN`（id 里非字母数字变下划线）。 */
export function envNameFor(id) {
  return `ROUTER_PROVIDER_KEY_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function readVaultKey({ create = false } = {}) {
  try {
    const raw = fs.readFileSync(VAULT_KEY_FILE);
    if (raw.length === 32) return raw;
  } catch {}
  if (!create) return null;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    fs.writeFileSync(VAULT_KEY_FILE, key, { mode: 0o600 });
  } catch {
    return null;
  }
  return key;
}

function encrypt(plain) {
  const key = readVaultKey({ create: true });
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    scheme: ALGO,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  };
}

function decrypt(blob) {
  if (!blob || blob.scheme !== ALGO) return null;
  const key = readVaultKey();
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 读整个凭据文件（不存在返回空壳）。 */
export function loadProviderStore() {
  const raw = readJson(PROVIDERS_FILE, null) || {};
  return {
    version: 1,
    // { [id]: { baseUrl?, key?: {scheme,iv,tag,data}, keyPlain?: string, addedAt } }
    providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
  };
}

export function saveProviderStore(store) {
  writeJsonAtomic(PROVIDERS_FILE, { version: 1, providers: store.providers });
}

/**
 * 取一个供应商的 key（明文）。
 *
 * 顺序：环境变量 > 加密存储 > 明文存储。三者都没有返回 null。
 * 本机服务不需要 key，直接返回 `'local'`——有些客户端（opencode）要求 apiKey
 * 非空，给一个占位值比给 null 更省事。
 */
export function providerKey(id, store = loadProviderStore(), env = process.env) {
  const def = BY_ID.get(id);
  if (!def) return null;
  if (def.local) return 'local';

  const fromEnv = env[envNameFor(id)];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const entry = store.providers[id];
  if (!entry) return null;
  if (entry.key) {
    const plain = decrypt(entry.key);
    if (plain) return plain;
  }
  if (typeof entry.keyPlain === 'string' && entry.keyPlain.trim()) return entry.keyPlain.trim();
  return null;
}

/** key 从哪来（给 `providers list` 显示来源，不泄露内容）。 */
export function keySource(id, store = loadProviderStore(), env = process.env) {
  const def = BY_ID.get(id);
  if (!def) return 'unknown';
  if (def.local) return 'local';
  if (env[envNameFor(id)]?.trim()) return 'env';
  const entry = store.providers[id];
  if (!entry) return 'none';
  if (entry.key) return decrypt(entry.key) ? 'vault' : 'vault(解不开)';
  if (entry.keyPlain) return 'plain';
  return 'none';
}

/**
 * 写入一个 key。优先加密；加密不可用时退化为明文并**明确告知调用方**。
 * @returns {{ stored: 'vault'|'plain', warning?: string }}
 */
export function setProviderKey(id, key, { baseUrl } = {}) {
  if (!BY_ID.has(id)) throw new Error(`未知供应商 ${id}`);
  const store = loadProviderStore();
  const entry = store.providers[id] || { addedAt: new Date().toISOString() };
  const trimmed = String(key ?? '').trim();

  if (!trimmed) {
    // 空字符串 = 清除（与 dsh 的语义一致）
    delete entry.key;
    delete entry.keyPlain;
  } else {
    const blob = encrypt(trimmed);
    if (blob) {
      entry.key = blob;
      delete entry.keyPlain;
    } else {
      entry.keyPlain = trimmed;
      delete entry.key;
    }
  }
  if (baseUrl) entry.baseUrl = String(baseUrl).replace(/\/+$/, '');
  entry.updatedAt = new Date().toISOString();
  store.providers[id] = entry;
  saveProviderStore(store);

  return entry.key
    ? { stored: 'vault' }
    : { stored: 'plain', warning: '加密不可用（写不了 data/.vault-key），key 以明文存放' };
}

export function removeProvider(id) {
  const store = loadProviderStore();
  if (!store.providers[id]) return false;
  delete store.providers[id];
  saveProviderStore(store);
  return true;
}

/**
 * 当前可用的供应商：有 key（本机服务无需 key）+ baseUrl 没有未替换的占位符。
 *
 * 占位符检查很重要：Cloudflare 的 baseUrl 里有 `{account_id}`，没替换就发请求
 * 只会得到一个 404，看起来像「这家不支持」。
 */
export function activeProviders(store = loadProviderStore(), env = process.env) {
  const rows = [];
  for (const def of FREE_PROVIDERS) {
    const baseUrl = resolveBaseUrl(def, store.providers, env);
    const key = providerKey(def.id, store, env);
    const missingKey = !def.local && !key;
    const needsSub = Boolean(baseUrl && baseUrl.includes('{'));
    rows.push({
      def,
      baseUrl,
      key,
      ok: !missingKey && !needsSub,
      reason: missingKey ? `缺 key（${def.env || '未声明环境变量'}）` : needsSub ? (def.needs || 'baseUrl 含占位符') : null,
    });
  }
  return rows;
}

/** 某个模型 id 属于哪家免费供应商（用于 `free/<model>` 形式的解析）。 */
export function providerForModel(modelId) {
  const want = String(modelId ?? '').toLowerCase();
  for (const def of FREE_PROVIDERS) {
    if ((def.freeModels || []).some((m) => String(m).toLowerCase() === want)) return def.id;
  }
  return null;
}

export { decrypt, encrypt };
