/**
 * 入站鉴权。
 *
 * 语义与 OpenResolver auth/guard.mjs 一致，但默认策略反过来了：
 * OpenResolver 默认「没有密钥时只放行回环」，router 默认**完全放行回环**，
 * 因为它是本机运维工具的延伸——你在终端里敲 curl 不该先造一个密钥。
 *
 * 想收紧就设 `gateway/data/config.json` 的 `strict: true`，或 `ROUTER_GATEWAY_STRICT=1`。
 * 非回环来源永远需要有效密钥，没有例外。
 */

import {
  findKeyBySecret,
  ipAllowed,
  isLoopback,
  keyExpired,
  modelAllowed,
  normalizeIp,
} from './keys.mjs';

export class AuthError extends Error {
  constructor(status, message, { type = 'authentication_error', code = '' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export function extractSecret(headers = {}) {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const key = headers['x-api-key'];
  if (typeof key === 'string' && key.trim()) return key.trim();
  return null;
}

export function clientIp(req) {
  return normalizeIp(req.socket?.remoteAddress || '');
}

/**
 * 校验一条推理请求。通过返回 { key }；回环放行时 key 为 null。
 * 顺序刻意与 OpenResolver 一致：先认证，再权限（provider → model → ip → 配额），
 * 这样 403 的文案能准确说「哪一条规则拦的」。
 *
 * 回环放行的判定要比「没带密钥」宽一点：客户端（opencode / pi）会强制带一个占位
 * apiKey（`router-local`、`qoder-local`…），如果只放行「完全不带密钥」，
 * 这些客户端在回环上反而全部 401。既然回环本来就不需要密钥，那么「带了但不对」
 * 也不该比「没带」更严格——否则只是逼用户去造一个密钥来填占位符。
 */
export function authorize({ secret, ip, db, config = {}, provider, model }) {
  const loopback = isLoopback(ip);
  const key = secret ? findKeyBySecret(db, secret) : null;

  if (!key) {
    if (!config.strict && loopback) return { key: null, openMode: true };
    if (!secret) {
      throw new AuthError(401, '缺少 API key（zsk_…），请用 Authorization: Bearer 或 x-api-key 传入');
    }
    throw new AuthError(401, 'API key 无效');
  }
  if (key.disabled === true) throw new AuthError(401, 'API key 已禁用');
  if (keyExpired(key)) throw new AuthError(401, 'API key 已过期');

  if (Array.isArray(key.providers) && key.providers.length && provider && !key.providers.includes(provider)) {
    throw new AuthError(403, `该密钥不允许访问供应商 "${provider}"`, { type: 'permission_error' });
  }
  if (!modelAllowed(model, key.models || [])) {
    throw new AuthError(403, `该密钥不允许使用模型 "${model}"`, { type: 'permission_error' });
  }
  if (!ipAllowed(ip, key.ips || [])) {
    throw new AuthError(403, `来源 IP ${ip} 不在该密钥的白名单内`, { type: 'permission_error' });
  }
  if (key.tokenQuota > 0 && (key.usedTokens || 0) >= key.tokenQuota) {
    throw new AuthError(403, '密钥 token 配额已用尽', { type: 'permission_error', code: 'quota_exceeded' });
  }
  return { key };
}

/** 密钥可见的供应商：白名单为空 = 全部。 */
export function visibleProviders(key, all) {
  const allow = key?.providers;
  if (!Array.isArray(allow) || !allow.length) return all;
  return all.filter((id) => allow.includes(id));
}
