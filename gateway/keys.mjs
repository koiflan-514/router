/**
 * 网关密钥：`zsk_` 前缀，库里只存 SHA-256。
 *
 * 与 OpenResolver 的 auth/keys.mjs 同一套取舍：
 *   - 明文只在创建时打印一次，之后任何地方都拿不回来；
 *   - 校验时先哈希再查表，日志里绝不出现明文；
 *   - 白名单为空 = 不限制（provider / model / IP / 配额都是这个语义）。
 *
 * 密钥文件在 `gateway/data/keys.json`（已被 .gitignore 的 `**\/data/` 排除）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { KEYS_FILE, readJson, writeJsonAtomic } from './config.mjs';

const EMPTY = { version: 1, keys: [] };

export const KEY_PREFIX = 'zsk_';

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function generateSecret() {
  // 32 字节 base64url ≈ 43 字符；`zsk_` 前缀让密钥在日志里一眼可辨、可被 secret scanner 认出
  return `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function loadKeyDb() {
  const db = readJson(KEYS_FILE, null);
  if (!db || !Array.isArray(db.keys)) return { ...EMPTY };
  return { version: 1, keys: db.keys.filter((k) => k && typeof k.hash === 'string') };
}

/** 密钥库文件的修改时间，用来做热加载判断（null = 文件不存在）。 */
export function keysFileMtime() {
  try {
    return fs.statSync(KEYS_FILE).mtimeMs;
  } catch {
    return null;
  }
}

export function saveKeyDb(db) {
  writeJsonAtomic(KEYS_FILE, { version: 1, keys: db.keys });
}

/**
 * 新建密钥。返回 { key, secret }：secret 只在这一次调用里存在。
 * `expiresInDays` 为 0 / null 表示不过期。
 */
export function createKey({ name, providers, models, ips, tokenQuota, expiresInDays, note } = {}) {
  const db = loadKeyDb();
  const secret = generateSecret();
  const now = Date.now();
  const key = {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    name: String(name || 'default'),
    prefix: secret.slice(0, 12),
    hash: hashSecret(secret),
    createdAt: new Date(now).toISOString(),
    expiresAt: expiresInDays > 0 ? new Date(now + expiresInDays * 86_400_000).toISOString() : null,
    disabled: false,
    providers: normalizeList(providers),
    models: normalizeList(models),
    ips: normalizeList(ips),
    tokenQuota: Number(tokenQuota) > 0 ? Number(tokenQuota) : 0,
    usedTokens: 0,
    note: note ? String(note) : '',
  };
  db.keys.push(key);
  saveKeyDb(db);
  return { key, secret };
}

function normalizeList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/** 公开展示用（不含 hash）：面板/TUI/CLI 都只看到这些字段。 */
export function publicKey(key) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    disabled: key.disabled === true,
    providers: key.providers || [],
    models: key.models || [],
    ips: key.ips || [],
    tokenQuota: key.tokenQuota || 0,
    usedTokens: key.usedTokens || 0,
    note: key.note || '',
  };
}

export function findKeyBySecret(db, secret) {
  if (!secret) return null;
  const hash = hashSecret(secret);
  return db.keys.find((k) => k.hash === hash) || null;
}

export function removeKey(db, idOrPrefix) {
  const before = db.keys.length;
  db.keys = db.keys.filter((k) => k.id !== idOrPrefix && k.prefix !== idOrPrefix);
  return before - db.keys.length;
}

/** 累计 token 用量；只在脏的时候落盘（server 侧按 5 秒节流）。 */
export function addUsedTokens(db, keyId, tokens) {
  const key = db.keys.find((k) => k.id === keyId);
  if (!key || !tokens) return false;
  key.usedTokens = (key.usedTokens || 0) + Math.max(0, Math.trunc(tokens));
  return true;
}

// ---------------------------------------------------------------- IP 白名单

export function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

export function isLoopback(ip) {
  const v = normalizeIp(ip);
  return v === '::1' || v === 'localhost' || v.startsWith('127.');
}

function v4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255 || p === '') return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

export function ipAllowed(ip, allowlist = []) {
  if (!allowlist.length) return true;
  const target = normalizeIp(ip);
  return allowlist.some((entry) => {
    const e = normalizeIp(entry);
    if (e === target) return true;
    const slash = e.indexOf('/');
    if (slash < 0) return false;
    const base = v4ToInt(e.slice(0, slash));
    const addr = v4ToInt(target);
    const bits = Number(e.slice(slash + 1));
    if (base === null || addr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (base & mask) === (addr & mask);
  });
}

/** 模型白名单支持 `*` 与 `prefix*` 后缀通配，避免为几十个模型逐个列举。 */
export function modelAllowed(model, allowlist = []) {
  if (!allowlist.length) return true;
  const m = String(model || '');
  return allowlist.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return m.startsWith(pattern.slice(0, -1));
    return m === pattern;
  });
}

export function keyExpired(key, now = Date.now()) {
  if (!key.expiresAt) return false;
  const t = Date.parse(key.expiresAt);
  return Number.isFinite(t) && t <= now;
}

export { KEYS_FILE };
export function keysFileExists() {
  return fs.existsSync(KEYS_FILE);
}
